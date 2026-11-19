// Builds the real release bundle and runs it as a separate process, the way
// the launcher will.

import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { before, describe, it } from "node:test";
import { buildApp } from "../../src/build/app.ts";
import { makeTempDir } from "../helpers.ts";

describe("app bundle", () => {
  let bundle: string;

  before(async () => {
    bundle = path.join(await makeTempDir(), "app.js");
    await buildApp({ version: "1.2.3", outFile: bundle });
  });

  it(
    "runs, reports its baked-in version, and saves state when stopped",
    { skip: process.platform === "win32" && "Windows has no SIGTERM; graceful stop arrives over IPC in a later slice" },
    async () => {
      const dataDir = await makeTempDir();
      const child = spawn(process.execPath, [bundle], {
        env: { ...process.env, NAMETAG_DATA_DIR: dataDir, NAMETAG_TICK_INTERVAL_MS: "10" },
        stdio: ["ignore", "pipe", "inherit"],
      });
      const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));

      // Wait for a few ticks, then ask it to stop.
      const records: Array<Record<string, unknown>> = [];
      for await (const line of createInterface({ input: child.stdout })) {
        const record = JSON.parse(line) as Record<string, unknown>;
        records.push(record);
        if (record.msg === "tick" && record.ticks === 3) {
          child.kill("SIGTERM");
        }
      }

      assert.equal(await exited, 0);
      assert.ok(records.every((record) => record.version === "1.2.3" && record.component === "app"));
      const stopped = records.find((record) => record.msg === "stopped");
      assert.ok(stopped, "logged a clean stop");
      const saved = JSON.parse(await readFile(path.join(dataDir, "app-state.json"), "utf8")) as { ticks: number };
      assert.equal(saved.ticks, stopped.ticks);
      assert.match(await readFile(path.join(dataDir, "logs", "app.log"), "utf8"), /"msg":"stopped"/);
    },
  );

  describe("under a launcher (IPC)", () => {
    async function forkBundle() {
      const dataDir = await makeTempDir();
      const child = fork(bundle, [], {
        env: { ...process.env, NAMETAG_DATA_DIR: dataDir, NAMETAG_TICK_INTERVAL_MS: "10", NAMETAG_LAUNCHER_VERSION: "1.0.0" },
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      });
      const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
      const firstMessage = new Promise<unknown>((resolve) => child.once("message", resolve));
      return { dataDir, child, exited, firstMessage };
    }

    it("reports healthy, then saves state and exits 0 on a shutdown request", async () => {
      const { dataDir, child, exited, firstMessage } = await forkBundle();
      assert.deepEqual(await firstMessage, { type: "healthy" });
      await new Promise((resolve) => setTimeout(resolve, 50)); // Let it tick.
      child.send({ type: "shutdown" });

      assert.equal(await exited, 0);
      const saved = JSON.parse(await readFile(path.join(dataDir, "app-state.json"), "utf8")) as { ticks: number };
      assert.ok(saved.ticks > 0);
    });

    it("shuts down if the launcher disconnects", async () => {
      const { child, exited, firstMessage } = await forkBundle();
      await firstMessage;
      child.disconnect();
      assert.equal(await exited, 0);
    });
  });

  it("refuses an invalid version", async () => {
    await assert.rejects(buildApp({ version: "1.2", outFile: path.join(await makeTempDir(), "app.js") }), /invalid version/);
  });
});
