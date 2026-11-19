import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Updater, type UpdaterOptions } from "../../src/app/updater.ts";
import { createLogger } from "../../src/shared/log.ts";
import { dataLayout } from "../../src/shared/paths.ts";
import { decodePublicKey } from "../../src/shared/signing.ts";
import { silentLogger, startReleaseServer, type ReleaseServer } from "../fixtures.ts";
import { makeTempDir, waitFor } from "../helpers.ts";

const V1 = "console.log('v1');";
const V2 = "console.log('v2 is here');";

describe("Updater", () => {
  let server: ReleaseServer;

  // Each test gets its own server, so tests can tamper with its files freely.
  before(async () => {
    server = await startReleaseServer();
  });
  after(() => server.close());

  async function freshServer(): Promise<ReleaseServer> {
    const fresh = await startReleaseServer();
    after(() => fresh.close());
    return fresh;
  }

  async function makeUpdater(target: ReleaseServer, overrides: Partial<UpdaterOptions> = {}) {
    const layout = dataLayout(await makeTempDir());
    const updater = new Updater({
      manifestUrl: target.manifestUrl,
      publicKey: decodePublicKey(target.keys.publicKey),
      installedVersion: "1.0.0",
      launcherVersion: "1.0.0",
      badVersions: new Set(),
      layout,
      log: silentLogger,
      pollIntervalMs: 60_000,
      initialDelayMs: 0,
      onStaged: () => {},
      ...overrides,
    });
    after(() => updater.stop());
    const versionsDir = async () => (await readdir(layout.versions).catch(() => [])).sort();
    return { updater, layout, versionsDir };
  }

  describe("checkNow", () => {
    it("reports no update when the published version is the installed one", async () => {
      await server.publishVersion("1.0.0", V1);
      const { updater, versionsDir } = await makeUpdater(server);
      const outcome = await updater.checkNow();
      assert.equal(outcome.status, "no-update");
      assert.equal(outcome.status === "no-update" && outcome.reason, "not-newer");
      assert.deepEqual(await versionsDir(), []);
    });

    it("downloads, verifies and stages a newer release, leaving nothing else behind", async () => {
      const target = await freshServer();
      await target.publishVersion("1.1.0", V2);
      const { updater, layout, versionsDir } = await makeUpdater(target);

      assert.deepEqual(await updater.checkNow(), { status: "staged", version: "1.1.0" });
      assert.equal(await readFile(path.join(layout.versions, "1.1.0", "app.js"), "utf8"), V2);
      assert.deepEqual(await versionsDir(), ["1.1.0"]);
    });

    it("skips a version this client has rolled back from", async () => {
      const target = await freshServer();
      await target.publishVersion("1.1.0", V2);
      const { updater } = await makeUpdater(target, { badVersions: new Set(["1.1.0"]) });
      const outcome = await updater.checkNow();
      assert.equal(outcome.status === "no-update" && outcome.reason, "known-bad");
    });

    it("reuses an already-staged release without downloading again", async () => {
      const target = await freshServer();
      await target.publishVersion("1.1.0", V2);
      const { updater, layout } = await makeUpdater(target);
      await mkdir(path.join(layout.versions, "1.1.0"), { recursive: true });
      await writeFile(path.join(layout.versions, "1.1.0", "app.js"), V2);
      // If it tried to download, this would fail with a 404.
      await rm(path.join(target.root, "artifacts", "1.1.0"), { recursive: true });

      assert.deepEqual(await updater.checkNow(), { status: "staged", version: "1.1.0" });
    });

    it("replaces a corrupt leftover version folder", async () => {
      const target = await freshServer();
      await target.publishVersion("1.1.0", V2);
      const { updater, layout } = await makeUpdater(target);
      await mkdir(path.join(layout.versions, "1.1.0"), { recursive: true });
      await writeFile(path.join(layout.versions, "1.1.0", "app.js"), "half-writ");

      assert.deepEqual(await updater.checkNow(), { status: "staged", version: "1.1.0" });
      assert.equal(await readFile(path.join(layout.versions, "1.1.0", "app.js"), "utf8"), V2);
    });
  });

  describe("refuses untrustworthy releases, staging nothing", () => {
    async function expectRejected(tamper: (target: ReleaseServer) => Promise<void>, message: RegExp) {
      const target = await freshServer();
      await target.publishVersion("1.1.0", V2);
      await tamper(target);
      const { updater, versionsDir } = await makeUpdater(target);
      await assert.rejects(updater.checkNow(), message);
      assert.deepEqual(await versionsDir(), [], "no version folder, partial folder or temp file left");
    }

    const manifestPath = (target: ReleaseServer) => path.join(target.root, "manifest.json");
    const artifactPath = (target: ReleaseServer) => path.join(target.root, "artifacts", "1.1.0", "app.js");

    it("a manifest altered after signing", () =>
      expectRejected(async (target) => {
        const text = await readFile(manifestPath(target), "utf8");
        await writeFile(manifestPath(target), text.replace("1.1.0", "1.1.1"));
      }, /signature is invalid/));

    it("a manifest signed by another key", async () => {
      const target = await freshServer();
      await target.publishVersion("1.1.0", V2);
      const imposter = await freshServer();
      const { updater } = await makeUpdater(target, { publicKey: decodePublicKey(imposter.keys.publicKey) });
      await assert.rejects(updater.checkNow(), /signature is invalid/);
    });

    it("an artifact swapped for one of the same size", () =>
      expectRejected((target) => writeFile(artifactPath(target), "x".repeat(V2.length)), /sha256 .* does not match/));

    it("an artifact larger than declared", () =>
      expectRejected((target) => writeFile(artifactPath(target), `${V2}// and then some`), /exceeds its declared size/));

    it("an artifact smaller than declared", () =>
      expectRejected((target) => writeFile(artifactPath(target), "short"), /is 5 bytes, expected/));

    it("a missing artifact", () => expectRejected((target) => rm(artifactPath(target)), /HTTP 404/));

    it("an oversized manifest", () =>
      expectRejected((target) => writeFile(manifestPath(target), " ".repeat(70 * 1024)), /exceeds 65536 bytes/));

    it("a manifest that isn't JSON", () => expectRejected((target) => writeFile(manifestPath(target), "<html>"), /not valid JSON/));
  });

  describe("URL policy", () => {
    it("refuses a plain-HTTP manifest URL that isn't localhost", async () => {
      const { updater } = await makeUpdater(server, {
        manifestUrl: "http://updates.example.com/manifest.json",
        fetch: () => assert.fail("must not make the request"),
      });
      await assert.rejects(updater.checkNow(), /must use https/);
    });

    it("refuses a redirect to a plain-HTTP host", async () => {
      const { updater } = await makeUpdater(server, {
        manifestUrl: "https://updates.example.com/manifest.json",
        fetch: async () => {
          const response = new Response("{}");
          Object.defineProperty(response, "url", { value: "http://evil.example.com/manifest.json" });
          return response;
        },
      });
      await assert.rejects(updater.checkNow(), /redirect target must use https/);
    });
  });

  describe("polling", () => {
    it("stages a release, calls onStaged once, and stops polling", async () => {
      const target = await freshServer();
      await target.publishVersion("1.1.0", V2);
      const staged: string[] = [];
      let requests = 0;
      const { updater } = await makeUpdater(target, {
        pollIntervalMs: 5,
        onStaged: (version) => staged.push(version),
        fetch: (input, init) => {
          requests += 1;
          return fetch(input, init);
        },
      });
      updater.start();
      await waitFor(() => staged.length > 0);
      const requestsWhenStaged = requests;
      await sleep(50);

      assert.deepEqual(staged, ["1.1.0"]);
      assert.equal(requests, requestsWhenStaged, "no polling after staging");
    });

    it("retries failed checks with backoff, sooner than the poll interval", async () => {
      const target = await freshServer();
      await target.publishVersion("1.1.0", V2);
      const lines: string[] = [];
      let failuresLeft = 2;
      const staged: string[] = [];
      const { updater } = await makeUpdater(target, {
        pollIntervalMs: 60_000,
        retryBaseMs: 5,
        log: createLogger({ component: "test", sinks: [(line) => lines.push(line)] }),
        onStaged: (version) => staged.push(version),
        fetch: (input, init) => {
          if (failuresLeft > 0) {
            failuresLeft -= 1;
            return Promise.reject(new TypeError("fetch failed"));
          }
          return fetch(input, init);
        },
      });
      updater.start();
      await waitFor(() => staged.length > 0);

      const failures = lines.filter((line) => line.includes("update check failed"));
      assert.equal(failures.length, 2);
      assert.match(failures[1] ?? "", /"consecutiveFailures":2/);
    });

    it("stop() aborts a request in flight without reporting a failure", async () => {
      const lines: string[] = [];
      let aborted = false;
      const { updater } = await makeUpdater(server, {
        log: createLogger({ component: "test", sinks: [(line) => lines.push(line)] }),
        fetch: (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(init.signal?.reason);
            });
          }),
      });
      updater.start();
      await sleep(20);
      updater.stop();
      await sleep(20);

      assert.ok(aborted);
      assert.deepEqual(lines.filter((line) => line.includes("update check failed")), []);
    });
  });
});
