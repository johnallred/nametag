import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { keygen, MANIFEST_FILE, publish, refresh } from "../../src/release/commands.ts";
import { readSignedManifest } from "../../src/shared/manifest.ts";
import { decodePublicKey, generateSigningKeyPair } from "../../src/shared/signing.ts";
import { makeTempDir } from "../helpers.ts";

const now = new Date("2026-11-18T12:00:00.123Z");

async function setup() {
  const dir = await makeTempDir();
  const keys = generateSigningKeyPair();
  const root = path.join(dir, "releases");
  const artifactPath = path.join(dir, "app.js");
  await writeFile(artifactPath, "console.log('hello');");
  const readManifest = async () =>
    readSignedManifest(JSON.parse(await readFile(path.join(root, MANIFEST_FILE), "utf8")), decodePublicKey(keys.publicKey));
  return { dir, keys, root, artifactPath, readManifest };
}

/** Puts an artifact in place directly, as an interrupted earlier publish would have. */
async function plantArtifact(root: string, version: string, content: string): Promise<void> {
  await mkdir(path.join(root, "artifacts", version), { recursive: true });
  await writeFile(path.join(root, "artifacts", version, "app.js"), content);
}

describe("keygen", () => {
  it("writes a usable key pair, with the private key readable only by its owner", async () => {
    const dir = await makeTempDir();
    const result = await keygen(dir);

    assert.equal((await readFile(result.publicKeyPath, "utf8")).trim(), result.publicKey);
    assert.doesNotThrow(() => decodePublicKey(result.publicKey));
    if (process.platform !== "win32") {
      assert.equal((await stat(result.privateKeyPath)).mode & 0o777, 0o600);
    }
  });

  it("refuses to overwrite an existing key", async () => {
    const dir = await makeTempDir();
    await keygen(dir);
    await assert.rejects(keygen(dir), { code: "EEXIST" });
  });
});

describe("publish", () => {
  it("writes the artifact and a signed manifest that verifies against the public key", async () => {
    const { keys, root, artifactPath, readManifest } = await setup();
    const returned = await publish({ artifactPath, version: "1.0.0", privateKey: keys.privateKey, root, now });

    const release = await readManifest();
    assert.deepEqual(release, returned);
    assert.deepEqual(release, {
      version: "1.0.0",
      channel: "stable",
      publishedAt: "2026-11-18T12:00:00Z",
      expiresAt: "2026-12-18T12:00:00Z",
      minLauncherVersion: "1.0.0",
      artifact: {
        url: "artifacts/1.0.0/app.js",
        size: "console.log('hello');".length,
        sha256: createHash("sha256").update("console.log('hello');").digest("hex"),
      },
    });
    assert.equal(await readFile(path.join(root, release.artifact.url), "utf8"), "console.log('hello');");
  });

  it("replaces the manifest when a newer version is published", async () => {
    const { keys, root, artifactPath, readManifest } = await setup();
    await publish({ artifactPath, version: "1.0.0", privateKey: keys.privateKey, root, now });
    await writeFile(artifactPath, "console.log('v2');");
    await publish({ artifactPath, version: "1.1.0", privateKey: keys.privateKey, root, now });

    assert.equal((await readManifest()).version, "1.1.0");
    // The old artifact stays: clients mid-download, and CDN caches, may still want it.
    assert.equal(await readFile(path.join(root, "artifacts/1.0.0/app.js"), "utf8"), "console.log('hello');");
  });

  for (const version of ["1.0.0", "0.9.0"]) {
    it(`refuses ${version} after 1.0.0, since clients would ignore it`, async () => {
      const { keys, root, artifactPath } = await setup();
      await publish({ artifactPath, version: "1.0.0", privateKey: keys.privateKey, root, now });
      await assert.rejects(publish({ artifactPath, version, privateKey: keys.privateKey, root, now }), /not newer/);
    });
  }

  it("can be re-run after a crash that left the artifact but no manifest", async () => {
    const { keys, root, artifactPath, readManifest } = await setup();
    await publish({ artifactPath, version: "1.0.0", privateKey: keys.privateKey, root, now });
    await writeFile(artifactPath, "console.log('v2');");
    // Simulate the crash: the 1.1.0 artifact is in place, the manifest still says 1.0.0.
    await plantArtifact(root, "1.1.0", "console.log('v2');");

    await publish({ artifactPath, version: "1.1.0", privateKey: keys.privateKey, root, now });
    assert.equal((await readManifest()).version, "1.1.0");
  });

  it("refuses to overwrite a published artifact with different content", async () => {
    const { keys, root, artifactPath } = await setup();
    await publish({ artifactPath, version: "1.0.0", privateKey: keys.privateKey, root, now });
    await plantArtifact(root, "1.1.0", "something else");

    await assert.rejects(publish({ artifactPath, version: "1.1.0", privateKey: keys.privateKey, root, now }), /immutable/);
  });

  it("refuses to publish over a manifest signed with a different key", async () => {
    const { keys, root, artifactPath } = await setup();
    await publish({ artifactPath, version: "1.0.0", privateKey: keys.privateKey, root, now });
    const otherKey = generateSigningKeyPair().privateKey;
    await assert.rejects(publish({ artifactPath, version: "1.1.0", privateKey: otherKey, root, now }), /can't be verified/);
  });

  it("rejects invalid versions and validity periods before touching disk", async () => {
    const { keys, root, artifactPath } = await setup();
    await assert.rejects(publish({ artifactPath, version: "1.0", privateKey: keys.privateKey, root, now }), /invalid version/);
    await assert.rejects(
      publish({ artifactPath, version: "1.0.0", privateKey: keys.privateKey, root, now, validDays: 0 }),
      /validDays/,
    );
  });
});

describe("refresh", () => {
  it("extends the expiry and changes nothing else", async () => {
    const { keys, root, artifactPath, readManifest } = await setup();
    const published = await publish({ artifactPath, version: "1.0.0", privateKey: keys.privateKey, root, now });

    const later = new Date("2026-12-10T08:00:00Z");
    const refreshed = await refresh({ root, privateKey: keys.privateKey, now: later, validDays: 14 });

    assert.deepEqual(refreshed, { ...published, expiresAt: "2026-12-24T08:00:00Z" });
    assert.deepEqual(await readManifest(), refreshed);
  });

  it("fails if nothing has been published yet", async () => {
    const { keys, root } = await setup();
    await assert.rejects(refresh({ root, privateKey: keys.privateKey, now }), /publish a release first/);
  });

  it("refuses to re-sign a manifest whose artifact is missing or changed", async () => {
    const { keys, root, artifactPath } = await setup();
    await publish({ artifactPath, version: "1.0.0", privateKey: keys.privateKey, root, now });
    await writeFile(path.join(root, "artifacts/1.0.0/app.js"), "tampered");
    await assert.rejects(refresh({ root, privateKey: keys.privateKey, now }), /missing or doesn't match/);
  });

  it("refuses a manifest signed with a different key", async () => {
    const { keys, root, artifactPath } = await setup();
    await publish({ artifactPath, version: "1.0.0", privateKey: keys.privateKey, root, now });
    await assert.rejects(refresh({ root, privateKey: generateSigningKeyPair().privateKey, now }), /can't be verified/);
  });
});
