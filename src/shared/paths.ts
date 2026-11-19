// Where nametag keeps its files on each OS (DESIGN.md#architecture). The data
// directory is per user and user-writable, so updating never needs admin rights.

import os from "node:os";
import path from "node:path";

const APP_NAME = "nametag";

export interface Environment {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly homedir: string;
}

const currentEnvironment = (): Environment => ({ platform: process.platform, env: process.env, homedir: os.homedir() });

export function defaultDataDir({ platform, env, homedir }: Environment = currentEnvironment()): string {
  // Pick path semantics by target platform, not host, so this is testable anywhere.
  const p = platform === "win32" ? path.win32 : path.posix;
  switch (platform) {
    case "win32":
      return p.join(env.LOCALAPPDATA || p.join(homedir, "AppData", "Local"), APP_NAME);
    case "darwin":
      return p.join(homedir, "Library", "Application Support", APP_NAME);
    default: {
      // The XDG spec says relative values must be ignored.
      const xdg = env.XDG_DATA_HOME;
      return p.join(xdg && p.isAbsolute(xdg) ? xdg : p.join(homedir, ".local", "share"), APP_NAME);
    }
  }
}

/**
 * The data directory, overridable with NAMETAG_DATA_DIR (used by tests and the
 * demo). Always absolute: the launcher hands paths inside it to child
 * processes, and require() can't load a relative path.
 */
export function resolveDataDir(environment: Environment = currentEnvironment()): string {
  return path.resolve(environment.env.NAMETAG_DATA_DIR || defaultDataDir(environment));
}

/** Every path inside the data directory, in one place. Each file has one writer, noted below. */
export function dataLayout(dataDir: string) {
  return {
    root: dataDir,
    /** launcher: the active version. */
    current: path.join(dataDir, "current"),
    /** app: one folder per installed version. */
    versions: path.join(dataDir, "versions"),
    /** launcher: previous version and bad versions. */
    launcherState: path.join(dataDir, "launcher-state.json"),
    /** app: the program's own state. */
    appState: path.join(dataDir, "app-state.json"),
    /** user/operator: optional overrides. */
    config: path.join(dataDir, "config.json"),
    /** one file per process: launcher.log, app.log. */
    logs: path.join(dataDir, "logs"),
    /** launcher: single-instance lock. */
    lock: path.join(dataDir, "nametag.lock"),
  };
}

export type DataLayout = ReturnType<typeof dataLayout>;
