import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readTimingOverrides } from "../../src/launcher/timings.ts";

describe("readTimingOverrides", () => {
  it("returns only the overrides that are set and valid", () => {
    assert.deepEqual(readTimingOverrides({}), {});
    assert.deepEqual(
      readTimingOverrides({ NAMETAG_HEALTH_TIMEOUT_MS: "2000", NAMETAG_PROBATION_MS: "-1", NAMETAG_SHUTDOWN_TIMEOUT_MS: "soon" }),
      { healthTimeoutMs: 2000 },
    );
  });
});
