import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { INITIAL_LAUNCHER_STATE, loadLauncherState, readCurrent, saveLauncherState, writeCurrent } from "../../src/launcher/state.ts";
import { createLogger } from "../../src/shared/log.ts";
import { dataLayout } from "../../src/shared/paths.ts";
import { makeTempDir } from "../helpers.ts";

const silent = createLogger({ component: "test", sinks: [] });

describe("launcher state", () => {
  it("round-trips", async () => {
    const layout = dataLayout(await makeTempDir());
    const state = { previous: "1.0.0", probation: "1.1.0", badVersions: ["0.9.0"] };
    await saveLauncherState(layout, state);
    assert.deepEqual(await loadLauncherState(layout, silent), state);
  });

  it("starts fresh when missing or corrupt", async () => {
    const layout = dataLayout(await makeTempDir());
    assert.deepEqual(await loadLauncherState(layout, silent), INITIAL_LAUNCHER_STATE);
    await writeFile(layout.launcherState, "{ nope");
    assert.deepEqual(await loadLauncherState(layout, silent), INITIAL_LAUNCHER_STATE);
  });

  it("drops fields that aren't valid versions", async () => {
    const layout = dataLayout(await makeTempDir());
    await writeFile(layout.launcherState, JSON.stringify({ previous: "../x", probation: 3, badVersions: ["1.0.0", "evil", null] }));
    assert.deepEqual(await loadLauncherState(layout, silent), { previous: null, probation: null, badVersions: ["1.0.0"] });
  });
});

describe("current pointer", () => {
  it("names the installed version", async () => {
    const layout = dataLayout(await makeTempDir());
    await mkdir(path.join(layout.versions, "1.2.0"), { recursive: true });
    await writeFile(path.join(layout.versions, "1.2.0", "app.cjs"), "");
    await writeCurrent(layout, "1.2.0");
    assert.equal(await readCurrent(layout), "1.2.0");
  });

  it("is null when missing, invalid, or pointing at a version that isn't installed", async () => {
    const layout = dataLayout(await makeTempDir());
    assert.equal(await readCurrent(layout), null);
    await writeFile(layout.current, "garbage\n");
    assert.equal(await readCurrent(layout), null);
    await writeFile(layout.current, "2.0.0\n");
    assert.equal(await readCurrent(layout), null);
  });
});
