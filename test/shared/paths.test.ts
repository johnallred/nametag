import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultDataDir, resolveDataDir } from "../../src/shared/paths.ts";

describe("defaultDataDir", () => {
  it("uses %LOCALAPPDATA% on Windows", () => {
    const dir = defaultDataDir({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\ann\\AppData\\Local" }, homedir: "C:\\Users\\ann" });
    assert.equal(dir, "C:\\Users\\ann\\AppData\\Local\\nametag");
  });

  it("falls back to the home directory on Windows if LOCALAPPDATA is unset", () => {
    assert.equal(defaultDataDir({ platform: "win32", env: {}, homedir: "C:\\Users\\ann" }), "C:\\Users\\ann\\AppData\\Local\\nametag");
  });

  it("uses Application Support on macOS", () => {
    assert.equal(defaultDataDir({ platform: "darwin", env: {}, homedir: "/Users/ann" }), "/Users/ann/Library/Application Support/nametag");
  });

  it("uses $XDG_DATA_HOME on Linux, defaulting to ~/.local/share", () => {
    assert.equal(defaultDataDir({ platform: "linux", env: { XDG_DATA_HOME: "/data" }, homedir: "/home/ann" }), "/data/nametag");
    assert.equal(defaultDataDir({ platform: "linux", env: {}, homedir: "/home/ann" }), "/home/ann/.local/share/nametag");
  });

  it("ignores a relative $XDG_DATA_HOME, as the XDG spec requires", () => {
    assert.equal(defaultDataDir({ platform: "linux", env: { XDG_DATA_HOME: "data" }, homedir: "/home/ann" }), "/home/ann/.local/share/nametag");
  });
});

describe("resolveDataDir", () => {
  it("prefers NAMETAG_DATA_DIR", () => {
    assert.equal(resolveDataDir({ platform: "linux", env: { NAMETAG_DATA_DIR: "/tmp/x" }, homedir: "/home/ann" }), "/tmp/x");
  });
});
