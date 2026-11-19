// A size-rotated log file sink. Each process writes its own file (launcher.log,
// app.log), so no two processes ever append to or rotate the same file.

import { appendFileSync, renameSync, statSync } from "node:fs";
import type { Sink } from "./log.ts";

export interface FileSinkOptions {
  /** Rotate once the current file would exceed this many bytes. */
  readonly maxBytes?: number;
  /** How many rotated files (file.1 … file.N) to keep. */
  readonly maxFiles?: number;
}

/**
 * Appends each line synchronously. Logging is low-volume, and synchronous
 * writes mean the last lines before a crash are on disk, which is exactly
 * when they matter most.
 */
export function createFileSink(file: string, { maxBytes = 1_000_000, maxFiles = 3 }: FileSinkOptions = {}): Sink {
  let size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
  return (line) => {
    const bytes = Buffer.byteLength(line);
    if (size > 0 && size + bytes > maxBytes) {
      rotate(file, maxFiles);
      size = 0;
    }
    appendFileSync(file, line);
    size += bytes;
  };
}

// file.N-1 → file.N, …, file → file.1. Renaming onto file.N replaces the
// oldest, so at most maxFiles rotated files exist.
function rotate(file: string, maxFiles: number): void {
  for (let index = maxFiles - 1; index >= 1; index--) {
    renameIfExists(`${file}.${index}`, `${file}.${index + 1}`);
  }
  renameIfExists(file, `${file}.1`);
}

function renameIfExists(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}
