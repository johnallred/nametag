import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readLauncherContext } from "../../src/app/launcher-context.ts";

describe("readLauncherContext", () => {
  it("reads the launcher version and bad versions", () => {
    const context = readLauncherContext({ NAMETAG_LAUNCHER_VERSION: "1.2.0", NAMETAG_BAD_VERSIONS: '["1.1.0","1.1.1"]' }, true);
    assert.deepEqual(context, { launcherVersion: "1.2.0", badVersions: new Set(["1.1.0", "1.1.1"]) });
  });

  it("returns null without an IPC channel, even if the env looks right", () => {
    assert.equal(readLauncherContext({ NAMETAG_LAUNCHER_VERSION: "1.2.0" }, false), null);
  });

  it("returns null without a valid launcher version", () => {
    assert.equal(readLauncherContext({}, true), null);
    assert.equal(readLauncherContext({ NAMETAG_LAUNCHER_VERSION: "dev" }, true), null);
  });

  for (const raw of [undefined, "", "not json", '{"1.1.0":true}']) {
    it(`treats bad versions ${JSON.stringify(raw)} as none`, () => {
      const env = raw === undefined ? { NAMETAG_LAUNCHER_VERSION: "1.0.0" } : { NAMETAG_LAUNCHER_VERSION: "1.0.0", NAMETAG_BAD_VERSIONS: raw };
      assert.deepEqual(readLauncherContext(env, true)?.badVersions, new Set());
    });
  }
});
