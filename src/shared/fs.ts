// Crash-safe file replacement. Everything that must be all-or-nothing on disk
// (the manifest, the `current` pointer, state files) goes through here.
// See DESIGN.md#atomicity-what-happens-if-we-crash-at-each-step.

import { randomBytes } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

export interface WriteOptions {
  /** File permissions for a newly created file, e.g. 0o600 for secrets. */
  readonly mode?: number;
}

/**
 * Replaces `target` with `data` so that readers only ever see the old content
 * or the new content, never a partial write, even if the process crashes.
 *
 * The data is written and flushed to a temp file beside the target (same
 * directory, so same filesystem), then renamed over it.
 */
export async function writeFileAtomic(target: string, data: string | Uint8Array, options: WriteOptions = {}): Promise<void> {
  // Unique per call, so two writers can't clobber each other's temp file.
  // The .tmp suffix is what startup cleanup looks for.
  const temp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    // `flush` fsyncs before closing, so the rename can't land before the data does.
    await writeFile(temp, data, { flush: true, ...(options.mode === undefined ? {} : { mode: options.mode }) });
    await renameWithRetry(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

// On Windows, a rename fails with EPERM/EACCES/EBUSY while another process
// (typically antivirus or a search indexer) briefly has the file open. Those
// locks clear within milliseconds, so a short retry is the standard remedy.
const TRANSIENT_RENAME_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_ATTEMPTS = 10;

export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (attempt >= RENAME_ATTEMPTS || !TRANSIENT_RENAME_ERRORS.has(code)) {
        throw error;
      }
      await sleep(20 * attempt);
    }
  }
}
