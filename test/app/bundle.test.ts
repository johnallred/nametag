// Builds the real release bundle and runs it as a separate process, the way
// the launcher will.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

  it("refuses an invalid version", async () => {
    await assert.rejects(buildApp({ version: "1.2", outFile: path.join(await makeTempDir(), "app.js") }), /invalid version/);
  });
});
