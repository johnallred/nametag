import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareVersions, isValidVersion, parseVersion } from "../../src/shared/semver.ts";

describe("parseVersion", () => {
  it("parses MAJOR.MINOR.PATCH", () => {
    assert.deepEqual(parseVersion("1.20.3"), { major: 1, minor: 20, patch: 3 });
    assert.deepEqual(parseVersion("0.0.0"), { major: 0, minor: 0, patch: 0 });
  });

  for (const bad of ["", "1", "1.2", "1.2.3.4", "v1.2.3", "1.02.3", "1.2.3-beta", "1.2.3+build", " 1.2.3", "1.2.x"]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      assert.throws(() => parseVersion(bad), /invalid version/);
      assert.equal(isValidVersion(bad), false);
    });
  }

  it("rejects components beyond safe integer range", () => {
    assert.throws(() => parseVersion("99999999999999999999.0.0"), /too large/);
  });
});

describe("compareVersions", () => {
  it("orders numerically, not lexically", () => {
    assert.ok(compareVersions("1.10.0", "1.9.0") > 0);
    assert.ok(compareVersions("1.9.0", "1.10.0") < 0);
  });

  it("compares major before minor before patch", () => {
    assert.ok(compareVersions("2.0.0", "1.99.99") > 0);
    assert.ok(compareVersions("1.2.0", "1.1.99") > 0);
    assert.ok(compareVersions("1.1.2", "1.1.1") > 0);
  });

  it("returns zero for equal versions", () => {
    assert.equal(compareVersions("3.4.5", "3.4.5"), 0);
  });
});
