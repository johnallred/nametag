// The launcher's own bookkeeping (launcher-state.json), plus the `current`
// pointer. The launcher is the only writer of both.

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../shared/fs.ts";
import type { Logger } from "../shared/log.ts";
import type { DataLayout } from "../shared/paths.ts";
import { isValidVersion } from "../shared/semver.ts";

export interface LauncherState {
  /** The version that was current before the last switch: the rollback target. */
  readonly previous: string | null;
  /**
   * A version switched to but not yet confirmed healthy. Persisted so that if
   * the launcher itself restarts mid-probation, it resumes probation (and can
   * still roll back) instead of trusting an unproven version.
   */
  readonly probation: string | null;
  /** Versions that failed probation here and must never be staged again. */
  readonly badVersions: readonly string[];
}

export const INITIAL_LAUNCHER_STATE: LauncherState = { previous: null, probation: null, badVersions: [] };

/** Loads state, falling back to the initial state if it's missing or unreadable. */
export async function loadLauncherState(layout: DataLayout, log: Logger): Promise<LauncherState> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(layout.launcherState, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("could not read launcher state; starting fresh", { error });
    }
    return INITIAL_LAUNCHER_STATE;
  }
  const record = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const version = (field: unknown) => (typeof field === "string" && isValidVersion(field) ? field : null);
  return {
    previous: version(record.previous),
    probation: version(record.probation),
    badVersions: Array.isArray(record.badVersions) ? record.badVersions.filter((item) => version(item) !== null) : [],
  };
}

export async function saveLauncherState(layout: DataLayout, state: LauncherState): Promise<void> {
  await writeFileAtomic(layout.launcherState, `${JSON.stringify(state, null, 2)}\n`);
}

export function appPathFor(layout: DataLayout, version: string): string {
  return path.join(layout.versions, version, "app.js");
}

export async function isInstalled(layout: DataLayout, version: string): Promise<boolean> {
  return access(appPathFor(layout, version)).then(
    () => true,
    () => false,
  );
}

/** The version named by `current`, if it's valid and installed; otherwise null. */
export async function readCurrent(layout: DataLayout): Promise<string | null> {
  const text = await readFile(layout.current, "utf8").catch(() => null);
  const version = text?.trim();
  return version && isValidVersion(version) && (await isInstalled(layout, version)) ? version : null;
}

/** Atomically repoints `current`. This rename is the commit point of an update. */
export async function writeCurrent(layout: DataLayout, version: string): Promise<void> {
  await writeFileAtomic(layout.current, `${version}\n`);
}
