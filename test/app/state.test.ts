import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { INITIAL_STATE, loadAppState, saveAppState } from "../../src/app/state.ts";
import { createLogger } from "../../src/shared/log.ts";
import { makeTempDir } from "../helpers.ts";

function recordingLogger() {
  const lines: string[] = [];
  return { log: createLogger({ component: "test", sinks: [(line) => lines.push(line)] }), lines };
}

describe("app state", () => {
  it("starts from the initial state when nothing has been saved", async () => {
    const { log, lines } = recordingLogger();
    assert.deepEqual(await loadAppState(path.join(await makeTempDir(), "app-state.json"), log), INITIAL_STATE);
    assert.equal(lines.length, 0, "a missing file is normal, not worth a warning");
  });

  it("round-trips saved state", async () => {
    const file = path.join(await makeTempDir(), "app-state.json");
    await saveAppState(file, { ticks: 41 });
    assert.deepEqual(await loadAppState(file, recordingLogger().log), { ticks: 41 });
  });

  it("ignores unknown fields written by a newer version (rollback compatibility)", async () => {
    const file = path.join(await makeTempDir(), "app-state.json");
    await writeFile(file, JSON.stringify({ ticks: 7, addedInV2: true }));
    assert.deepEqual(await loadAppState(file, recordingLogger().log), { ticks: 7 });
  });

  for (const [label, content] of [
    ["truncated JSON", '{"ticks": 4'],
    ["a negative count", '{"ticks": -1}'],
    ["a non-numeric count", '{"ticks": "4"}'],
    ["null", "null"],
  ] as const) {
    it(`starts fresh, with a warning, from ${label}`, async () => {
      const file = path.join(await makeTempDir(), "app-state.json");
      await writeFile(file, content);
      const { log, lines } = recordingLogger();
      assert.deepEqual(await loadAppState(file, log), INITIAL_STATE);
      assert.match(lines.join(""), /"level":"warn"/);
    });
  }

  it("saves as one JSON line", async () => {
    const file = path.join(await makeTempDir(), "app-state.json");
    await saveAppState(file, { ticks: 3 });
    assert.equal(await readFile(file, "utf8"), '{"ticks":3}\n');
  });
});
