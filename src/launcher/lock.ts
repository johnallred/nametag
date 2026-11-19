// Single-instance lock. Two launchers would race over `current` and versions/,
// so a second one must exit instead.
//
// A PID file rather than an OS file lock: Node has no portable flock(), and a
// PID file is easy to inspect when debugging. A lock left by a crashed
// launcher is detected by checking whether its PID is still alive.
//
// Known gaps, acceptable for a per-user desktop app: if the OS reuses a dead
// launcher's PID for an unrelated process, the stale lock looks alive until
// that process exits; and two launchers starting at the same instant over a
// stale lock could both clear it.

import { readFileSync, unlinkSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";

export interface Lock {
  /** Synchronous, so it can run in a process 'exit' handler. */
  release(): void;
}

/** Takes the lock, or returns null if another live process holds it. */
export async function acquireLock(file: string): Promise<Lock | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(file, `${process.pid}\n`, { flag: "wx" });
      return { release: () => releaseIfOurs(file) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    const holder = Number.parseInt(await readFile(file, "utf8").catch(() => ""), 10);
    if (Number.isInteger(holder) && holder > 0 && isAlive(holder)) {
      return null;
    }
    // Stale: its owner is gone. Remove it and try once more.
    await rm(file, { force: true });
  }
  return null;
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else, so it's alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function releaseIfOurs(file: string): void {
  try {
    if (Number.parseInt(readFileSync(file, "utf8"), 10) === process.pid) {
      unlinkSync(file);
    }
  } catch {
    // Already gone: nothing to release.
  }
}
