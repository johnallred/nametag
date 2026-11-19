import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { INITIAL_LAUNCHER_STATE, loadLauncherState, type LauncherState } from "../../src/launcher/state.ts";
import { Supervisor, type SupervisorOptions } from "../../src/launcher/supervisor.ts";
import { createLogger } from "../../src/shared/log.ts";
import { dataLayout } from "../../src/shared/paths.ts";
import { makeTempDir, waitFor } from "../helpers.ts";
import { installFakeApp, readEvents, spawnWithNode, type AppEvent, type FakeAppBehaviour } from "./fake-app.ts";

const silent = createLogger({ component: "test", sinks: [] });

async function setup(
  versions: Record<string, FakeAppBehaviour>,
  current: string,
  options: { state?: LauncherState; overrides?: Partial<SupervisorOptions> } = {},
) {
  const layout = dataLayout(await makeTempDir());
  for (const [version, behaviour] of Object.entries(versions)) {
    await installFakeApp(layout.root, version, behaviour);
  }
  await writeFile(layout.current, `${current}\n`);

  const supervisor = new Supervisor({
    layout,
    log: silent,
    launcherVersion: "1.0.0",
    currentVersion: current,
    state: options.state ?? INITIAL_LAUNCHER_STATE,
    spawnApp: spawnWithNode,
    // Fast timings so the state machine runs in well under a second.
    healthTimeoutMs: 400,
    probationMs: 500,
    shutdownTimeoutMs: 300,
    restartBaseMs: 30,
    restartMaxMs: 200,
    ...options.overrides,
  });
  after(() => supervisor.stop());

  const events = () => readEvents(layout.root);
  const starts = async () => (await events()).filter((event) => event.event === "start").map((event) => event.version);
  const has = (predicate: (event: AppEvent) => boolean) => async () => (await events()).some(predicate);
  const currentFile = async () => (await readFile(layout.current, "utf8")).trim();
  return { layout, supervisor, events, starts, has, currentFile };
}

describe("Supervisor", () => {
  it("runs the current version, passing it the launcher version and bad versions", async () => {
    const state = { ...INITIAL_LAUNCHER_STATE, badVersions: ["0.9.0"] };
    const { supervisor, events, has } = await setup({ "1.0.0": {} }, "1.0.0", { state });
    supervisor.start();
    await waitFor(has((event) => event.event === "start"));

    const [start] = await events();
    assert.equal(start?.version, "1.0.0");
    assert.equal(start?.launcherVersion, "1.0.0");
    assert.equal(start?.badVersions, '["0.9.0"]');
  });

  it("stop() shuts the app down gracefully and starts nothing else", async () => {
    const { supervisor, has, starts } = await setup({ "1.0.0": {} }, "1.0.0");
    supervisor.start();
    await waitFor(has((event) => event.event === "start"));
    await supervisor.stop();

    assert.ok(await has((event) => event.event === "graceful-exit")());
    await sleep(100);
    assert.deepEqual(await starts(), ["1.0.0"]);
  });

  it("switches to a staged version and confirms it after probation", async () => {
    const { supervisor, layout, has, currentFile } = await setup({ "1.0.0": { stage: "1.1.0" }, "1.1.0": {} }, "1.0.0");
    supervisor.start();
    await waitFor(has((event) => event.event === "start" && event.version === "1.1.0"));

    assert.ok(await has((event) => event.event === "graceful-exit" && event.version === "1.0.0")(), "old version stopped gracefully");
    assert.equal(await currentFile(), "1.1.0");
    assert.deepEqual(supervisor.state, { previous: "1.0.0", probation: "1.1.0", badVersions: [] });

    await waitFor(() => supervisor.state.probation === null, 2000, "probation to pass");
    assert.deepEqual(await loadLauncherState(layout, silent), { previous: "1.0.0", probation: null, badVersions: [] });
  });

  for (const [label, behaviour] of [
    ["crashes during probation", { crashAfterMs: 50 }],
    ["never reports healthy", { healthy: false }],
  ] as const) {
    it(`rolls back a new version that ${label}, and marks it bad`, async () => {
      const { supervisor, layout, starts, events, currentFile } = await setup({ "1.0.0": { stage: "1.1.0" }, "1.1.0": behaviour }, "1.0.0");
      supervisor.start();
      await waitFor(async () => (await starts()).length >= 3, 3000, "rollback restart");

      assert.deepEqual(await starts(), ["1.0.0", "1.1.0", "1.0.0"]);
      assert.equal(await currentFile(), "1.0.0");
      assert.deepEqual(await loadLauncherState(layout, silent), { previous: null, probation: null, badVersions: ["1.1.0"] });
      // The restarted old version is told, so its updater won't fetch 1.1.0 again.
      assert.equal((await events()).filter((event) => event.event === "start").at(-1)?.badVersions, '["1.1.0"]');
    });
  }

  it("resumes probation, and can still roll back, if the launcher restarted mid-probation", async () => {
    const { supervisor, starts, currentFile } = await setup({ "1.0.0": {}, "1.1.0": { crashAfterMs: 50 } }, "1.1.0", {
      state: { previous: "1.0.0", probation: "1.1.0", badVersions: [] },
    });
    supervisor.start();
    await waitFor(async () => (await starts()).length >= 2, 3000, "rollback");

    assert.deepEqual(await starts(), ["1.1.0", "1.0.0"]);
    assert.equal(await currentFile(), "1.0.0");
  });

  it("restarts a version that crashes after passing probation, without rolling back", async () => {
    const { supervisor, starts, currentFile } = await setup({ "1.0.0": { crashAfterMs: 600 } }, "1.0.0");
    supervisor.start();
    await waitFor(async () => (await starts()).length >= 2, 3000, "restart");

    assert.deepEqual((await starts()).slice(0, 2), ["1.0.0", "1.0.0"]);
    assert.equal(await currentFile(), "1.0.0");
    assert.deepEqual(supervisor.state.badVersions, []);
  });

  it("kills an old version that ignores the shutdown request, then switches", async () => {
    const { supervisor, has, events } = await setup({ "1.0.0": { stage: "1.1.0", ignoreShutdown: true }, "1.1.0": {} }, "1.0.0");
    supervisor.start();
    await waitFor(has((event) => event.event === "start" && event.version === "1.1.0"), 3000, "switch");

    const kinds = (await events()).map((event) => `${event.event}:${event.version}`);
    assert.ok(kinds.includes("shutdown-requested:1.0.0"));
    assert.ok(!kinds.includes("graceful-exit:1.0.0"), "it never exited by itself");
  });

  for (const [label, versions, staged] of [
    ["isn't installed", { "1.0.0": { stage: "1.1.0" } }, "1.1.0"],
    ["isn't newer", { "1.0.0": { stage: "0.9.0" }, "0.9.0": {} }, "0.9.0"],
    ["isn't a version", { "1.0.0": { stage: "../../etc" } }, "../../etc"],
  ] as const) {
    it(`ignores a staged version that ${label}`, async () => {
      const lines: string[] = [];
      const { supervisor, starts, currentFile } = await setup(versions, "1.0.0", {
        overrides: { log: createLogger({ component: "test", sinks: [(line) => lines.push(line)] }) },
      });
      supervisor.start();
      await waitFor(() => lines.some((line) => line.includes("ignoring staged release")), 2000, "staged message");

      assert.deepEqual(await starts(), ["1.0.0"]);
      assert.equal(await currentFile(), "1.0.0");
      assert.ok(lines.some((line) => line.includes(JSON.stringify(staged).slice(1, -1))));
    });
  }

  it("ignores a staged version that previously failed here", async () => {
    const lines: string[] = [];
    const { supervisor, starts } = await setup({ "1.0.0": { stage: "1.1.0" }, "1.1.0": {} }, "1.0.0", {
      state: { ...INITIAL_LAUNCHER_STATE, badVersions: ["1.1.0"] },
      overrides: { log: createLogger({ component: "test", sinks: [(line) => lines.push(line)] }) },
    });
    supervisor.start();
    await waitFor(() => lines.some((line) => line.includes("previously failed here")), 2000, "rejection");
    assert.deepEqual(await starts(), ["1.0.0"]);
  });
});
