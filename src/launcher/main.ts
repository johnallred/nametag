// The launcher's entry point. The same executable runs in one of two modes:
//
//   nametag                                  launcher: supervise the app
//   nametag --nametag-run-app <path/app.js>  app mode: run one app bundle
//
// Kept small on purpose: this is the one component that doesn't update itself.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createLogger, stdoutSink, type Logger } from "../shared/log.ts";
import { createFileSink } from "../shared/log-file.ts";
import { dataLayout, resolveDataDir, type DataLayout } from "../shared/paths.ts";
import { cleanUp } from "./cleanup.ts";
import { acquireLock } from "./lock.ts";
import { appModeTarget, createAppSpawner, runApp } from "./spawn.ts";
import { isInstalled, loadLauncherState, readCurrent, writeCurrent, type LauncherState } from "./state.ts";
import { Supervisor } from "./supervisor.ts";
import { LAUNCHER_VERSION } from "./version.ts";

async function main(): Promise<number | null> {
  const layout = dataLayout(resolveDataDir());
  await mkdir(layout.logs, { recursive: true });
  const log = createLogger({
    component: "launcher",
    version: LAUNCHER_VERSION,
    sinks: [stdoutSink, createFileSink(path.join(layout.logs, "launcher.log"))],
  });

  const lock = await acquireLock(layout.lock);
  if (!lock) {
    log.warn("another launcher is already running; exiting", { lock: layout.lock });
    return 0;
  }
  process.on("exit", () => lock.release());

  const state = await loadLauncherState(layout, log);
  const current = await resolveCurrentVersion(layout, state, log);
  if (!current) {
    log.error("no installed version found; reinstall nametag", { dataDir: layout.root });
    return 1;
  }
  await cleanUp(layout, new Set([current, ...(state.previous ? [state.previous] : [])]), log);

  const supervisor = new Supervisor({
    layout,
    log,
    launcherVersion: LAUNCHER_VERSION,
    currentVersion: current,
    state,
    spawnApp: createAppSpawner(),
  });
  log.info("launcher started", { dataDir: layout.root, appVersion: current });
  supervisor.start();

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      log.info("launcher stopping", { signal });
      void supervisor.stop().then(() => process.exit(0));
    });
  }
  return null; // Keep running; the supervisor's child process keeps us alive.
}

/**
 * The version to run. `current` should always be valid, since it's only ever
 * replaced atomically. If it somehow isn't (e.g. deleted by hand), fall back
 * to the previous version rather than refusing to start.
 */
async function resolveCurrentVersion(layout: DataLayout, state: LauncherState, log: Logger): Promise<string | null> {
  const current = await readCurrent(layout);
  if (current) {
    return current;
  }
  if (state.previous && (await isInstalled(layout, state.previous))) {
    log.warn("current version missing or invalid; falling back to previous", { previous: state.previous });
    await writeCurrent(layout, state.previous);
    return state.previous;
  }
  return null;
}

const appPath = appModeTarget(process.argv);
if (appPath) {
  runApp(appPath);
} else {
  main().then(
    (exitCode) => {
      if (exitCode !== null) {
        process.exit(exitCode);
      }
    },
    (error: unknown) => {
      console.error("launcher failed:", error);
      process.exit(1);
    },
  );
}
