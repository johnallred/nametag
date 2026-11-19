// Startup cleanup (DESIGN.md#atomicity). Every interrupted operation leaves
// recognisable debris: *.partial folders, *.tmp files, or version folders that
// are neither current nor the rollback target. All of it is safe to delete
// because the lock guarantees no app or other launcher is running.

import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../shared/log.ts";
import type { DataLayout } from "../shared/paths.ts";
import { isValidVersion } from "../shared/semver.ts";

export async function cleanUp(layout: DataLayout, keep: ReadonlySet<string>, log: Logger): Promise<void> {
  for (const name of await list(layout.root)) {
    if (name.endsWith(".tmp")) {
      await remove(path.join(layout.root, name), log);
    }
  }
  for (const name of await list(layout.versions)) {
    const obsolete = isValidVersion(name) && !keep.has(name);
    if (name.endsWith(".partial") || name.endsWith(".tmp") || obsolete) {
      await remove(path.join(layout.versions, name), log);
    }
    // Anything else isn't ours to judge; leave it alone.
  }
}

async function list(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => []);
}

async function remove(target: string, log: Logger): Promise<void> {
  try {
    await rm(target, { recursive: true, force: true });
    log.info("cleaned up", { path: target });
  } catch (error) {
    // Not worth failing startup over; we'll try again next time.
    log.warn("cleanup failed", { path: target, error });
  }
}
