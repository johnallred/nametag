// Smoke test of the real launcher executable (a Node SEA) on the current OS:
// build it, install 1.0.0 with it, and watch it update to 1.1.0. This is the
// evidence for "works on Windows, macOS and Linux", run by CI on each.
//
// Not part of `npm test` (building the executable takes a while and copies
// the ~100 MB node binary). Run it with `npm run test:sea`.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, it } from "node:test";
import { buildApp } from "../../src/build/app.ts";
import { assembleInstall } from "../../src/build/install.ts";
import { buildLauncherExecutable } from "../../src/build/launcher.ts";
import { readCurrent, RunningClient } from "../client.ts";
import { startReleaseServer } from "../fixtures.ts";
import { makeTempDir } from "../helpers.ts";

it("the SEA launcher installs, runs and updates the app", { timeout: 5 * 60_000 }, async () => {
  const dir = await makeTempDir();
  const executable = await buildLauncherExecutable(path.join(dir, "launcher"));

  const server = await startReleaseServer();
  after(() => server.close());
  const bundle = async (version: string) => {
    const outFile = path.join(dir, `app-${version}.js`);
    await buildApp({ version, outFile, publicKey: server.keys.publicKey, manifestUrl: server.manifestUrl });
    return outFile;
  };

  const v1 = await bundle("1.0.0");
  await server.publishVersion("1.0.0", await readFile(v1, "utf8"));
  const dataDir = path.join(dir, "client");
  await assembleInstall({ outDir: dataDir, appPath: v1, version: "1.0.0", launcherPath: executable });

  // Run the installed copy, exactly as a client would.
  const client = new RunningClient(path.join(dataDir, path.basename(executable)), [], dataDir);
  after(() => client.stop());

  // Generous timeouts: the first run of a new executable can be slow while
  // antivirus scans it, particularly on Windows.
  await client.waitForLog("1.0.0 healthy", { msg: "app healthy", appVersion: "1.0.0" }, 60_000);
  await server.publishVersion("1.1.0", await readFile(await bundle("1.1.0"), "utf8"));
  await client.waitForLog("1.1.0 confirmed", { msg: "new version confirmed", appVersion: "1.1.0" }, 60_000);

  assert.equal(await readCurrent(dataDir), "1.1.0");
});
