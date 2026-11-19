// A running client (launcher plus app) for end-to-end tests, with everything
// both processes log. Works with the launcher run from source or the built
// SEA executable.

import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { waitFor } from "./helpers.ts";

export const LAUNCHER_SOURCE = fileURLToPath(new URL("../src/launcher/main.ts", import.meta.url));

export interface LogRecord {
  readonly msg: string;
  readonly component: "launcher" | "app";
  readonly version: string;
  readonly [field: string]: unknown;
}

export class RunningClient {
  readonly records: LogRecord[] = [];
  readonly #process: ChildProcess;
  readonly #exited: Promise<void>;

  /** Starts `command args…` as the launcher, with fast test timings. */
  constructor(command: string, args: readonly string[], dataDir: string) {
    this.#process = spawn(command, args, {
      env: {
        ...process.env,
        NAMETAG_DATA_DIR: dataDir,
        NAMETAG_TICK_INTERVAL_MS: "50",
        NAMETAG_POLL_INTERVAL_SECONDS: "0.2",
        NAMETAG_FIRST_CHECK_DELAY_SECONDS: "0",
        NAMETAG_HEALTH_TIMEOUT_MS: "5000",
        NAMETAG_PROBATION_MS: "1000",
      },
      // stderr is captured, not shown: a broken release's crash is expected noise.
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.#exited = new Promise((resolve) => this.#process.once("exit", () => resolve()));
    this.#process.stderr?.resume();
    createInterface({ input: this.#process.stdout! }).on("line", (line) => {
      try {
        this.records.push(JSON.parse(line) as LogRecord);
      } catch {
        // Not a log line; ignore.
      }
    });
  }

  /** The launcher run from source with node. */
  static fromSource(dataDir: string): RunningClient {
    return new RunningClient(process.execPath, [LAUNCHER_SOURCE], dataDir);
  }

  /** Waits until a log record matches, and returns it. */
  async waitForLog(what: string, match: Partial<LogRecord>, timeoutMs = 10_000): Promise<LogRecord> {
    const find = () => this.records.find((record) => Object.entries(match).every(([key, value]) => record[key] === value));
    await waitFor(() => find() !== undefined, timeoutMs, what);
    return find()!;
  }

  async stop(): Promise<void> {
    // On Windows this is a hard kill; the app then exits on IPC disconnect.
    this.#process.kill("SIGTERM");
    await this.#exited;
  }
}

export async function readCurrent(dataDir: string): Promise<string> {
  return (await readFile(path.join(dataDir, "current"), "utf8")).trim();
}
