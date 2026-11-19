// The supervisor runs one app version at a time and owns every transition
// between versions:
//
//   staged    app reports a verified release → repoint `current`, stop the
//             old app gracefully, start the new one on probation
//   probation new app must report healthy within healthTimeoutMs and keep
//             running for probationMs; otherwise roll back (ADR-0006)
//   crash     an app that already passed probation exits unexpectedly →
//             restart the same version with exponential backoff
//
// It deliberately knows nothing about manifests, downloads or signatures:
// that logic lives in the updatable app (ADR-0005).

import type { ChildProcess } from "node:child_process";
import { ENV_BAD_VERSIONS, ENV_LAUNCHER_VERSION, type AppMessage, type LauncherMessage } from "../shared/ipc.ts";
import type { Logger } from "../shared/log.ts";
import type { DataLayout } from "../shared/paths.ts";
import { compareVersions, isValidVersion } from "../shared/semver.ts";
import type { SpawnApp } from "./spawn.ts";
import { appPathFor, isInstalled, saveLauncherState, writeCurrent, type LauncherState } from "./state.ts";

export interface SupervisorOptions {
  readonly layout: DataLayout;
  readonly log: Logger;
  readonly launcherVersion: string;
  /** The version `current` names at startup. */
  readonly currentVersion: string;
  readonly state: LauncherState;
  readonly spawnApp: SpawnApp;
  readonly healthTimeoutMs?: number;
  readonly probationMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly restartBaseMs?: number;
  readonly restartMaxMs?: number;
}

/** One app process and what we know about it. */
interface Instance {
  readonly child: ChildProcess;
  readonly version: string;
  /** Where to roll back to if this instance fails probation; null if nowhere. */
  readonly rollbackTo: string | null;
  readonly exited: Promise<void>;
  readonly timers: NodeJS.Timeout[];
  healthy: boolean;
  passedProbation: boolean;
  /** Set when we asked it to stop, so its exit isn't treated as a crash. */
  expectedExit: boolean;
  /** Why we killed it, if we did. */
  failure: string | null;
  exitHandled: boolean;
}

export class Supervisor {
  readonly #options: Required<SupervisorOptions>;
  #state: LauncherState;
  #current: string;
  #instance: Instance | null = null;
  #restartTimer: NodeJS.Timeout | undefined;
  #consecutiveCrashes = 0;
  #switching = false;
  #stopped = false;

  constructor(options: SupervisorOptions) {
    this.#options = {
      healthTimeoutMs: 10_000,
      probationMs: 30_000,
      shutdownTimeoutMs: 5_000,
      restartBaseMs: 1_000,
      restartMaxMs: 60_000,
      ...options,
    };
    this.#state = options.state;
    this.#current = options.currentVersion;
  }

  get currentVersion(): string {
    return this.#current;
  }

  get state(): LauncherState {
    return this.#state;
  }

  start(): void {
    // If we were restarted mid-probation, the current version is still unproven.
    const resuming = this.#state.probation === this.#current && this.#state.previous !== null;
    if (resuming) {
      this.#options.log.warn("resuming probation after launcher restart", { version: this.#current });
    }
    this.#launch(this.#current, resuming ? this.#state.previous : null);
  }

  /** Stops the app gracefully. Nothing is restarted afterwards. */
  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#restartTimer);
    if (this.#instance) {
      await this.#stopInstance(this.#instance);
    }
  }

  #launch(version: string, rollbackTo: string | null): void {
    const { layout, log, launcherVersion, spawnApp, healthTimeoutMs, probationMs } = this.#options;
    const child = spawnApp(appPathFor(layout, version), {
      ...process.env,
      NAMETAG_DATA_DIR: layout.root,
      [ENV_LAUNCHER_VERSION]: launcherVersion,
      [ENV_BAD_VERSIONS]: JSON.stringify(this.#state.badVersions),
    });

    let markExited = () => {};
    const instance: Instance = {
      child,
      version,
      rollbackTo,
      exited: new Promise((resolve) => (markExited = resolve)),
      timers: [],
      healthy: false,
      passedProbation: false,
      expectedExit: false,
      failure: null,
      exitHandled: false,
    };
    this.#instance = instance;
    log.info("app starting", { appVersion: version, pid: child.pid, probation: rollbackTo !== null, rollbackTo });

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (instance.exitHandled) {
        return;
      }
      instance.exitHandled = true;
      markExited();
      this.#onExit(instance, code, signal);
    };
    child.on("message", (message: unknown) => this.#onMessage(instance, message));
    child.once("exit", onExit);
    child.once("error", (error) => {
      log.error("app process error", { appVersion: version, error });
      // A failed spawn emits 'error' but may never emit 'exit'.
      if (child.pid === undefined) {
        onExit(null, null);
      }
    });

    instance.timers.push(
      setTimeout(() => {
        if (!instance.healthy && !instance.exitHandled) {
          this.#fail(instance, `no health report within ${healthTimeoutMs}ms`);
        }
      }, healthTimeoutMs),
      setTimeout(() => void this.#passProbation(instance), probationMs),
    );
  }

  #onMessage(instance: Instance, message: unknown): void {
    const typed = message as Partial<AppMessage> | null;
    if (typed?.type === "healthy") {
      if (!instance.healthy) {
        instance.healthy = true;
        this.#options.log.info("app healthy", { appVersion: instance.version });
      }
    } else if (typed?.type === "staged" && typeof typed.version === "string") {
      this.#onStaged(instance, typed.version).catch((error: unknown) => {
        this.#options.log.error("switching versions failed; staying on current", { error });
      });
    } else {
      this.#options.log.warn("ignoring unknown message from app", { message });
    }
  }

  async #onStaged(instance: Instance, next: string): Promise<void> {
    const { layout, log } = this.#options;
    // The app is updatable and so, from here, untrusted: check its claim.
    const problem = !isValidVersion(next)
      ? "not a valid version"
      : compareVersions(next, this.#current) <= 0
        ? `not newer than current ${this.#current}`
        : this.#state.badVersions.includes(next)
          ? "previously failed here"
          : !(await isInstalled(layout, next))
            ? "not found in versions/"
            : null;
    if (problem) {
      log.warn("ignoring staged release", { stagedVersion: next, problem });
      return;
    }
    if (this.#instance !== instance || !instance.healthy || this.#switching || this.#stopped) {
      log.warn("ignoring staged release; not in a state to switch", { stagedVersion: next });
      return;
    }

    const from = this.#current;
    this.#switching = true;
    try {
      // State first, then the pointer: if we crash between the two, `current`
      // still names the old version and the stale probation entry is ignored.
      await this.#saveState({ ...this.#state, previous: from, probation: next });
      await writeCurrent(layout, next); // The commit point.
      this.#current = next;
      log.info("switching version", { from, to: next });
      await this.#stopInstance(instance);
    } finally {
      this.#switching = false;
    }
    if (!this.#stopped) {
      this.#launch(next, from);
    }
  }

  async #passProbation(instance: Instance): Promise<void> {
    if (this.#instance !== instance || !instance.healthy || instance.exitHandled) {
      return;
    }
    instance.passedProbation = true;
    this.#consecutiveCrashes = 0;
    if (this.#state.probation === instance.version) {
      this.#options.log.info("new version confirmed", { appVersion: instance.version });
      await this.#saveState({ ...this.#state, probation: null }).catch((error: unknown) => {
        this.#options.log.error("could not record confirmation", { error });
      });
    }
  }

  #fail(instance: Instance, reason: string): void {
    this.#options.log.error("app failed health check; stopping it", { appVersion: instance.version, reason });
    instance.failure = reason;
    instance.child.kill("SIGKILL");
  }

  #onExit(instance: Instance, code: number | null, signal: NodeJS.Signals | null): void {
    const { log } = this.#options;
    for (const timer of instance.timers) {
      clearTimeout(timer);
    }
    if (this.#instance === instance) {
      this.#instance = null;
    }
    if (instance.expectedExit || this.#switching || this.#stopped) {
      log.info("app exited", { appVersion: instance.version, code, signal });
      return;
    }

    const failure = instance.failure ?? `exited unexpectedly (code ${code}, signal ${signal})`;
    if (instance.rollbackTo !== null && !instance.passedProbation) {
      void this.#rollBack(instance.version, instance.rollbackTo, failure);
    } else {
      this.#scheduleRestart(instance, failure);
    }
  }

  async #rollBack(failed: string, target: string, failure: string): Promise<void> {
    const { layout, log } = this.#options;
    log.error("new version failed probation; rolling back", { failed, to: target, failure });
    try {
      await this.#saveState({
        previous: null,
        probation: null,
        badVersions: [...new Set([...this.#state.badVersions, failed])],
      });
      await writeCurrent(layout, target);
    } catch (error) {
      // Run the known-good version regardless; the disk can catch up later.
      log.error("could not record rollback on disk", { error });
    }
    this.#current = target;
    if (!this.#stopped) {
      this.#launch(target, null);
    }
  }

  #scheduleRestart(instance: Instance, failure: string): void {
    const { log, restartBaseMs, restartMaxMs } = this.#options;
    this.#consecutiveCrashes = instance.passedProbation ? 1 : this.#consecutiveCrashes + 1;
    const delayMs = Math.min(restartMaxMs, restartBaseMs * 2 ** (this.#consecutiveCrashes - 1));
    log.error("app stopped unexpectedly; restarting", {
      appVersion: instance.version,
      failure,
      delayMs,
      consecutiveCrashes: this.#consecutiveCrashes,
    });
    this.#restartTimer = setTimeout(() => {
      if (!this.#stopped) {
        this.#launch(this.#current, null);
      }
    }, delayMs);
  }

  /** Asks the app to shut down, killing it if it doesn't within the deadline. */
  async #stopInstance(instance: Instance): Promise<void> {
    instance.expectedExit = true;
    if (instance.exitHandled) {
      return;
    }
    const { log, shutdownTimeoutMs } = this.#options;
    if (instance.child.connected) {
      const message: LauncherMessage = { type: "shutdown" };
      // The callback form reports a closed channel instead of throwing.
      instance.child.send(message, (error) => {
        if (error) {
          log.warn("could not send shutdown request", { error });
        }
      });
    }
    const deadline = setTimeout(() => {
      log.warn("app did not shut down in time; killing it", { appVersion: instance.version, shutdownTimeoutMs });
      instance.child.kill("SIGKILL");
    }, shutdownTimeoutMs);
    await instance.exited;
    clearTimeout(deadline);
  }

  async #saveState(state: LauncherState): Promise<void> {
    await saveLauncherState(this.#options.layout, state);
    this.#state = state;
  }
}
