// End to end: a real update server, real signed releases, real app bundles,
// and the real launcher (run from source; the SEA executable takes the same
// code path and is smoke-tested in CI). Each scenario installs 1.0.0, starts
// the launcher, publishes something, and watches the combined log stream of
// launcher and app.

import assert from "node:assert/strict";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { buildApp } from "../../src/build/app.ts";
import { assembleInstall } from "../../src/build/install.ts";
import { publish } from "../../src/release/commands.ts";
import { generateSigningKeyPair } from "../../src/shared/signing.ts";
import { readCurrent, RunningClient } from "../client.ts";
import { startReleaseServer, type ReleaseServer } from "../fixtures.ts";
import { makeTempDir } from "../helpers.ts";

describe("end to end", () => {
  /** A server, bundles built to trust its key, and a client running 1.0.0. */
  async function scenario() {
    const server: ReleaseServer = await startReleaseServer();
    after(() => server.close());
    const dir = await makeTempDir();

    const bundle = async (version: string) => {
      const outFile = path.join(dir, `app-${version}.js`);
      await buildApp({ version, outFile, publicKey: server.keys.publicKey, manifestUrl: server.manifestUrl });
      return readFile(outFile, "utf8");
    };

    const v1 = await bundle("1.0.0");
    await server.publishVersion("1.0.0", v1);
    const dataDir = path.join(dir, "client");
    await assembleInstall({ outDir: dataDir, appPath: path.join(dir, "app-1.0.0.js"), version: "1.0.0" });

    const client = RunningClient.fromSource(dataDir);
    after(() => client.stop());
    await client.waitForLog("1.0.0 healthy", { msg: "app healthy", appVersion: "1.0.0" });
    return { server, client, dataDir, bundle };
  }

  it("updates a running client to a new release, carrying its state across", async () => {
    const { server, client, dataDir, bundle } = await scenario();
    await client.waitForLog("1.0.0 ticking", { msg: "tick", version: "1.0.0", ticks: 3 });

    await server.publishVersion("1.1.0", await bundle("1.1.0"));

    const stopped = await client.waitForLog("1.0.0 stopped", { msg: "stopped", version: "1.0.0" });
    const started = await client.waitForLog("1.1.0 started", { msg: "started", component: "app", version: "1.1.0" });
    assert.equal(started.ticks, stopped.ticks, "the new version resumed counting where the old one stopped");
    await client.waitForLog("1.1.0 confirmed", { msg: "new version confirmed", appVersion: "1.1.0" });

    assert.equal(await readCurrent(dataDir), "1.1.0");
    // And it keeps doing its job on the new version.
    await client.waitForLog("1.1.0 ticking", { msg: "tick", version: "1.1.0", ticks: (stopped.ticks as number) + 3 });
  });

  it("ignores a release signed with someone else's key", async () => {
    const { server, client, dataDir, bundle } = await scenario();

    // An attacker controls the server and publishes their own "1.1.0".
    const attacker = generateSigningKeyPair();
    const dir = await makeTempDir();
    const artifactPath = path.join(dir, "evil.js");
    await writeFile(artifactPath, await bundle("1.1.0"));
    await rm(path.join(server.root, "manifest.json"));
    await publish({ artifactPath, version: "1.1.0", privateKey: attacker.privateKey, root: server.root });

    const failure = await client.waitForLog("signature rejection", { msg: "update check failed", level: "error" });
    assert.match(JSON.stringify(failure.error), /signature is invalid/);
    // Give it a few more polls to be sure nothing changes.
    await client.waitForLog("repeated rejection", { msg: "update check failed", consecutiveFailures: 3 });

    assert.equal(await readCurrent(dataDir), "1.0.0");
    assert.deepEqual(await readdir(path.join(dataDir, "versions")), ["1.0.0"]);
    assert.ok(!client.records.some((record) => record.msg === "switching version"));
  });

  it("rolls back a release that crashes on start, then recovers with the next release", async () => {
    const { server, client, dataDir, bundle } = await scenario();

    // Correctly signed, but broken.
    await server.publishVersion("1.1.0", 'throw new Error("this release is broken");\n');

    const rollback = await client.waitForLog("rollback", { msg: "new version failed probation; rolling back" });
    assert.equal(rollback.failed, "1.1.0");
    assert.equal(rollback.to, "1.0.0");
    await client.waitForLog("1.0.0 healthy again", { msg: "app healthy", appVersion: "1.0.0" });
    await client.waitForLog("1.1.0 skipped", { msg: "no update", reason: "known-bad" });
    assert.equal(await readCurrent(dataDir), "1.0.0");
    const state = JSON.parse(await readFile(path.join(dataDir, "launcher-state.json"), "utf8")) as { badVersions: string[] };
    assert.deepEqual(state.badVersions, ["1.1.0"]);

    // The fix ships as a new version and goes through normally.
    await server.publishVersion("1.2.0", await bundle("1.2.0"));
    await client.waitForLog("1.2.0 confirmed", { msg: "new version confirmed", appVersion: "1.2.0" });
    assert.equal(await readCurrent(dataDir), "1.2.0");
  });
});
