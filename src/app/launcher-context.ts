// What the launcher tells the app when it starts it (src/shared/ipc.ts).

import { ENV_BAD_VERSIONS, ENV_LAUNCHER_VERSION } from "../shared/ipc.ts";
import { isValidVersion } from "../shared/semver.ts";

export interface LauncherContext {
  readonly launcherVersion: string;
  readonly badVersions: ReadonlySet<string>;
}

/**
 * Returns null when the app wasn't started by the launcher (no IPC channel, or
 * no launcher version), e.g. when run directly from source. Without a launcher
 * nobody can switch versions, so the app shouldn't download any.
 */
export function readLauncherContext(env: NodeJS.ProcessEnv, hasIpcChannel: boolean): LauncherContext | null {
  const launcherVersion = env[ENV_LAUNCHER_VERSION];
  if (!hasIpcChannel || !launcherVersion || !isValidVersion(launcherVersion)) {
    return null;
  }
  return { launcherVersion, badVersions: parseBadVersions(env[ENV_BAD_VERSIONS]) };
}

function parseBadVersions(raw: string | undefined): ReadonlySet<string> {
  if (!raw) {
    return new Set();
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value)) {
      return new Set(value.filter((item): item is string => typeof item === "string"));
    }
  } catch {
    // Fall through. Losing the list costs at most one repeat download of a
    // bad version, which the launcher will roll back again.
  }
  return new Set();
}
