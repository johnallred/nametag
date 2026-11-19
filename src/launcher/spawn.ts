// How the launcher starts an app version (ADR-0002).
//
// The child is the launcher's own executable, re-run in "app mode" with the
// path of the bundle to load. As a Node Single Executable Application that
// executable embeds the runtime, so clients need nothing installed. In
// development (launcher run as `node src/launcher/main.ts`) the same flag is
// passed to node plus the launcher's entry script, so both paths run the same
// app-hosting code.

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { isSea } from "node:sea";

export const RUN_APP_FLAG = "--nametag-run-app";

export type SpawnApp = (appPath: string, env: NodeJS.ProcessEnv) => ChildProcess;

export function createAppSpawner(): SpawnApp {
  // In a SEA, argv[1] is the executable again rather than a script.
  const prefix = isSea() ? [] : [process.argv[1] ?? ""];
  return (appPath, env) =>
    spawn(process.execPath, [...prefix, RUN_APP_FLAG, appPath], {
      env,
      // stdout/stderr pass straight through; fd 3 is the IPC channel.
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      windowsHide: true,
    });
}

/** If this process was started in app mode, the bundle it should run. */
export function appModeTarget(argv: readonly string[]): string | null {
  const index = argv.indexOf(RUN_APP_FLAG);
  return index === -1 ? null : (argv[index + 1] ?? null);
}

/**
 * Runs an app bundle in this process. Inside a SEA the global `require` can
 * only load built-in modules, so a require bound to the bundle's own path is
 * needed to load it from disk.
 */
export function runApp(appPath: string): void {
  createRequire(appPath)(appPath);
}
