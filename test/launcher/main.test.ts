// Runs the real launcher entry point (from source, via node) over a real app
// bundle. The child is started through the launcher's own app mode, the same
// code path the SEA executable uses.

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildApp } from "../../src/build/app.ts";
import { assembleInstall } from "../../src/build/install.ts";
import { makeTempDir, waitFor } from "../helpers.ts";

const LAUNCHER = fileURLToPath(new URL("../../src/launcher/main.ts", import.meta.url));
const run = promisify(execFile);

describe("launcher entry point", () => {
  let bundle: string;

  before(async () => {
    bundle = path.join(await makeTempDir(), "app.cjs");
    await buildApp({ version: "1.0.0", outFile: bundle });
  });

  it("refuses to start without an installed version", async () => {
    const dataDir = await makeTempDir();
    await assert.rejects(run(process.execPath, [LAUNCHER], { env: { ...process.env, NAMETAG_DATA_DIR: dataDir } }), (error: { code?: number; stdout?: string }) => {
      assert.equal(error.code, 1);
      assert.match(error.stdout ?? "", /no installed version found/);
      return true;
    });
  });

  it(
    "runs the app, refuses a second launcher, and stops the app gracefully",
    { skip: process.platform === "win32" && "stopping the launcher relies on SIGTERM" },
    async () => {
      // A package.json declaring ES modules above the install must not change
      // how the CommonJS bundle loads (it did, when bundles were named app.js).
      const parent = await makeTempDir();
      await writeFile(path.join(parent, "package.json"), '{"type":"module"}');
      const dataDir = path.join(parent, "nametag");
      await assembleInstall({ outDir: dataDir, appPath: bundle, version: "1.0.0" });
      const env = { ...process.env, NAMETAG_DATA_DIR: dataDir, NAMETAG_TICK_INTERVAL_MS: "20" };

      const launcher = spawn(process.execPath, [LAUNCHER], { env, stdio: ["ignore", "pipe", "pipe"] });
      const exited = new Promise<number | null>((resolve) => launcher.on("exit", resolve));
      // Never leave a launcher (and its app) running if an assertion fails.
      after(() => void launcher.kill("SIGKILL"));
      launcher.stderr.resume();

      const messages: string[] = [];
      createInterface({ input: launcher.stdout }).on("line", (line) => {
        try {
          messages.push((JSON.parse(line) as { msg: string }).msg);
        } catch {
          // Not a log line (e.g. a crash's stack trace).
        }
      });
      const seen = (msg: string) => messages.includes(msg);

      await waitFor(() => seen("app healthy"), 10_000, "app healthy");

      const second = await run(process.execPath, [LAUNCHER], { env });
      assert.match(second.stdout, /another launcher is already running/);

      launcher.kill("SIGTERM");
      assert.equal(await exited, 0);
      for (const expected of ["launcher stopping", "shutting down", "stopped", "app exited"]) {
        assert.ok(seen(expected), `logged "${expected}"`);
      }
    },
  );
});
