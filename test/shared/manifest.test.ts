import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSignedManifest,
  evaluateRelease,
  ManifestError,
  readSignedManifest,
  validateRelease,
  type InstallContext,
  type Release,
} from "../../src/shared/manifest.ts";
import { decodePrivateKey, decodePublicKey, generateSigningKeyPair, signBytes } from "../../src/shared/signing.ts";

const keys = generateSigningKeyPair();
const publicKey = decodePublicKey(keys.publicKey);
const privateKey = decodePrivateKey(keys.privateKey);

const release: Release = {
  version: "1.4.0",
  channel: "stable",
  publishedAt: "2026-11-18T12:00:00Z",
  expiresAt: "2026-12-18T12:00:00Z",
  minLauncherVersion: "1.0.0",
  artifact: { url: "artifacts/1.4.0/app.cjs", size: 48211, sha256: "a".repeat(64) },
};

function withChanges(changes: Record<string, unknown>): Record<string, unknown> {
  return { ...release, ...changes };
}

describe("signed manifests", () => {
  it("round-trips: what's signed is what's read", () => {
    const manifest = createSignedManifest(release, privateKey);
    assert.deepEqual(readSignedManifest(manifest, publicKey), release);
  });

  it("survives serialization to and from JSON, as it would over HTTP", () => {
    const wire = JSON.stringify(createSignedManifest(release, privateKey));
    assert.deepEqual(readSignedManifest(JSON.parse(wire), publicKey), release);
  });

  it("rejects a manifest whose signed content was altered", () => {
    const manifest = createSignedManifest(release, privateKey);
    const tampered = { ...manifest, signed: manifest.signed.replace("1.4.0", "9.9.9") };
    assert.throws(() => readSignedManifest(tampered, publicKey), /signature is invalid/);
  });

  it("rejects a manifest signed by a different key", () => {
    const attacker = decodePrivateKey(generateSigningKeyPair().privateKey);
    const forged = createSignedManifest(release, attacker);
    assert.throws(() => readSignedManifest(forged, publicKey), /signature is invalid/);
  });

  for (const [label, document] of [
    ["null", null],
    ["an array", []],
    ["missing signature", { signed: "{}" }],
    ["non-string signed field", { signed: {}, signature: "x" }],
  ] as const) {
    it(`rejects a malformed envelope: ${label}`, () => {
      assert.throws(() => readSignedManifest(document, publicKey), ManifestError);
    });
  }

  it("rejects correctly signed content that isn't valid JSON", () => {
    // Bypasses createSignedManifest to simulate a buggy release tool.
    const signed = "not json";
    const document = { signed, signature: signBytes(Buffer.from(signed), privateKey) };
    assert.throws(() => readSignedManifest(document, publicKey), /not valid JSON/);
  });

  it("refuses to sign a malformed release", () => {
    const bad = withChanges({ version: "latest" }) as unknown as Release;
    assert.throws(() => createSignedManifest(bad, privateKey), /version/);
  });
});

describe("validateRelease", () => {
  it("ignores unknown fields so future manifests stay readable", () => {
    assert.deepEqual(validateRelease(withChanges({ rolloutPercent: 10 })), release);
  });

  const invalid: Array<[string, Record<string, unknown>, RegExp]> = [
    ["a non-semver version", withChanges({ version: "1.4" }), /release\.version/],
    ["an empty channel", withChanges({ channel: "" }), /release\.channel/],
    ["a non-UTC timestamp", withChanges({ expiresAt: "2026-12-18T12:00:00+01:00" }), /release\.expiresAt/],
    ["an impossible date", withChanges({ publishedAt: "2026-13-45T12:00:00Z" }), /release\.publishedAt/],
    ["expiry before publication", withChanges({ expiresAt: "2026-11-01T00:00:00Z" }), /must be after/],
    ["a missing artifact", withChanges({ artifact: undefined }), /release\.artifact must be an object/],
    ["a zero size", withChanges({ artifact: { ...release.artifact, size: 0 } }), /artifact\.size/],
    ["a fractional size", withChanges({ artifact: { ...release.artifact, size: 1.5 } }), /artifact\.size/],
    ["an uppercase hash", withChanges({ artifact: { ...release.artifact, sha256: "A".repeat(64) } }), /artifact\.sha256/],
    ["a short hash", withChanges({ artifact: { ...release.artifact, sha256: "abc" } }), /artifact\.sha256/],
    ["an empty url", withChanges({ artifact: { ...release.artifact, url: "" } }), /artifact\.url/],
  ];
  for (const [label, value, message] of invalid) {
    it(`rejects ${label}`, () => {
      assert.throws(() => validateRelease(value), (error: unknown) => {
        assert.ok(error instanceof ManifestError);
        assert.match(error.message, message);
        return true;
      });
    });
  }
});

describe("evaluateRelease", () => {
  const context: InstallContext = {
    installedVersion: "1.3.0",
    launcherVersion: "1.0.0",
    channel: "stable",
    badVersions: new Set(),
    now: new Date("2026-11-20T00:00:00Z"),
  };

  it("accepts a fresh, newer release on the right channel", () => {
    assert.deepEqual(evaluateRelease(release, context), { accepted: true });
  });

  const rejections: Array<[string, Partial<InstallContext>, Partial<Release>, string]> = [
    ["an expired manifest", { now: new Date("2026-12-18T12:00:00Z") }, {}, "expired"],
    ["another channel", {}, { channel: "beta" }, "wrong-channel"],
    ["the installed version (replay)", { installedVersion: "1.4.0" }, {}, "not-newer"],
    ["an older version (downgrade)", { installedVersion: "1.5.0" }, {}, "not-newer"],
    ["a version that already failed here", { badVersions: new Set(["1.4.0"]) }, {}, "known-bad"],
    ["a release needing a newer launcher", {}, { minLauncherVersion: "1.1.0" }, "launcher-too-old"],
  ];
  for (const [label, contextChanges, releaseChanges, reason] of rejections) {
    it(`rejects ${label}`, () => {
      const decision = evaluateRelease({ ...release, ...releaseChanges }, { ...context, ...contextChanges });
      assert.equal(decision.accepted, false);
      assert.equal(!decision.accepted && decision.reason, reason);
    });
  }

  it("checks expiry before anything else, so a stale manifest is reported as stale", () => {
    const decision = evaluateRelease(release, {
      ...context,
      installedVersion: "1.4.0",
      now: new Date("2027-01-01T00:00:00Z"),
    });
    assert.equal(!decision.accepted && decision.reason, "expired");
  });
});
