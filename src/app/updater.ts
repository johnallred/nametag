// The updater: poll the manifest, decide, download, verify, stage, and tell
// the launcher. It lives in the app, not the launcher, so its own bugs can be
// fixed by shipping an update (ADR-0005). See DESIGN.md#update-lifecycle.

import { createHash, type KeyObject } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { renameWithRetry } from "../shared/fs.ts";
import type { Logger } from "../shared/log.ts";
import { evaluateRelease, ManifestError, readSignedManifest, type Artifact, type Release, type RejectionReason } from "../shared/manifest.ts";
import type { DataLayout } from "../shared/paths.ts";
import { downloadVerified, fetchTextLimited, type Fetch } from "./download.ts";

export interface UpdaterOptions {
  readonly manifestUrl: string;
  /** The trust anchor, baked into the bundle at build time. */
  readonly publicKey: KeyObject;
  readonly installedVersion: string;
  readonly launcherVersion: string;
  readonly badVersions: ReadonlySet<string>;
  readonly layout: DataLayout;
  readonly log: Logger;
  readonly pollIntervalMs: number;
  /** Called once, after a release is fully staged. Polling stops at that point. */
  readonly onStaged: (version: string) => void;

  readonly channel?: string;
  /** Delay before the first check, so startup and the health check finish first. */
  readonly initialDelayMs?: number;
  /** First retry delay after a failed check; doubles per failure up to pollIntervalMs. */
  readonly retryBaseMs?: number;
  /** ±fraction applied to every delay so a fleet doesn't poll in lockstep. */
  readonly jitter?: number;
  readonly manifestTimeoutMs?: number;
  readonly downloadTimeoutMs?: number;
  readonly maxManifestBytes?: number;
  readonly fetch?: Fetch;
  readonly now?: () => Date;
  readonly random?: () => number;
}

export type CheckOutcome =
  | { readonly status: "staged"; readonly version: string }
  | { readonly status: "no-update"; readonly reason: RejectionReason; readonly detail: string };

// Rejections an operator should hear about; the rest are routine.
const NOTEWORTHY: ReadonlySet<RejectionReason> = new Set(["expired", "wrong-channel", "launcher-too-old"]);

export class Updater {
  readonly #options: Required<Omit<UpdaterOptions, "fetch">> & { fetch: Fetch };
  readonly #abort = new AbortController();
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #failures = 0;

  constructor(options: UpdaterOptions) {
    this.#options = {
      channel: "stable",
      initialDelayMs: 10_000,
      retryBaseMs: 60_000,
      jitter: 0.1,
      manifestTimeoutMs: 30_000,
      downloadTimeoutMs: 10 * 60_000,
      maxManifestBytes: 64 * 1024,
      fetch: globalThis.fetch,
      now: () => new Date(),
      random: Math.random,
      ...options,
    };
  }

  start(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#schedule(this.#options.initialDelayMs);
  }

  /** Stops polling and aborts any request in flight. */
  stop(): void {
    this.#running = false;
    clearTimeout(this.#timer);
    this.#abort.abort();
  }

  /** One full check. Throws on network, signature or verification failures. */
  async checkNow(): Promise<CheckOutcome> {
    const release = await this.#fetchManifest();
    const decision = evaluateRelease(release, {
      installedVersion: this.#options.installedVersion,
      launcherVersion: this.#options.launcherVersion,
      channel: this.#options.channel,
      badVersions: this.#options.badVersions,
      now: this.#options.now(),
    });
    if (!decision.accepted) {
      return { status: "no-update", reason: decision.reason, detail: decision.detail };
    }
    await this.#stage(release);
    return { status: "staged", version: release.version };
  }

  #schedule(delayMs: number): void {
    const spread = 1 + (this.#options.random() * 2 - 1) * this.#options.jitter;
    this.#timer = setTimeout(() => void this.#runScheduledCheck(), delayMs * spread);
    // The updater alone must never keep the process alive.
    this.#timer.unref();
  }

  async #runScheduledCheck(): Promise<void> {
    const { log, pollIntervalMs, retryBaseMs } = this.#options;
    try {
      const outcome = await this.checkNow();
      this.#failures = 0;
      if (outcome.status === "staged") {
        log.info("update staged", { stagedVersion: outcome.version });
        this.#running = false;
        this.#options.onStaged(outcome.version);
        return;
      }
      const level = NOTEWORTHY.has(outcome.reason) ? "warn" : "info";
      log[level]("no update", { reason: outcome.reason, detail: outcome.detail });
    } catch (error) {
      if (!this.#running) {
        return; // Aborted by stop(); not a failure.
      }
      this.#failures += 1;
      // A bad signature is worth shouting about: it means tampering or a key mix-up.
      const level = error instanceof ManifestError ? "error" : "warn";
      log[level]("update check failed", { error, consecutiveFailures: this.#failures });
    }
    if (this.#running) {
      const delay = this.#failures === 0 ? pollIntervalMs : Math.min(pollIntervalMs, retryBaseMs * 2 ** (this.#failures - 1));
      this.#schedule(delay);
    }
  }

  async #fetchManifest(): Promise<Release> {
    const { manifestUrl, maxManifestBytes, manifestTimeoutMs, publicKey } = this.#options;
    const text = await fetchTextLimited(new URL(manifestUrl), maxManifestBytes, {
      fetch: this.#options.fetch,
      signal: this.#signal(manifestTimeoutMs),
    });
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch {
      throw new ManifestError("manifest is not valid JSON");
    }
    return readSignedManifest(document, publicKey);
  }

  // Downloads into versions/<v>.partial/ and renames it to versions/<v>/ only
  // once verified. A crash at any point leaves at most a .partial folder, which
  // the launcher deletes at startup (DESIGN.md#atomicity).
  async #stage(release: Release): Promise<void> {
    const { layout, log } = this.#options;
    // Safe as a path segment: validateRelease guarantees MAJOR.MINOR.PATCH.
    const finalDir = path.join(layout.versions, release.version);
    if (await isStaged(finalDir, release.artifact)) {
      // A previous run staged it but died before telling the launcher.
      log.info("release already staged", { stagedVersion: release.version });
      return;
    }
    await rm(finalDir, { recursive: true, force: true });

    const partialDir = `${finalDir}.partial`;
    await rm(partialDir, { recursive: true, force: true });
    await mkdir(partialDir, { recursive: true });
    try {
      const url = new URL(release.artifact.url, this.#options.manifestUrl);
      log.info("downloading release", { stagedVersion: release.version, url: url.href, bytes: release.artifact.size });
      await downloadVerified(url, path.join(partialDir, "app.cjs"), release.artifact, {
        fetch: this.#options.fetch,
        signal: this.#signal(this.#options.downloadTimeoutMs),
      });
      await renameWithRetry(partialDir, finalDir);
    } catch (error) {
      await rm(partialDir, { recursive: true, force: true });
      throw error;
    }
  }

  #signal(timeoutMs: number): AbortSignal {
    return AbortSignal.any([this.#abort.signal, AbortSignal.timeout(timeoutMs)]);
  }
}

async function isStaged(dir: string, artifact: Artifact): Promise<boolean> {
  try {
    const content = await readFile(path.join(dir, "app.cjs"));
    return content.length === artifact.size && createHash("sha256").update(content).digest("hex") === artifact.sha256;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
