// The app's entry point: the code inside each versions/<v>/app.cjs bundle.
//
// Runs the ticker and, when started by the launcher, the updater, and speaks
// the launcher's IPC protocol (src/shared/ipc.ts).

import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { AppMessage, LauncherMessage } from "../shared/ipc.ts";
import { createLogger, stdoutSink, type Logger } from "../shared/log.ts";
import { createFileSink } from "../shared/log-file.ts";
import { dataLayout, resolveDataDir, type DataLayout } from "../shared/paths.ts";
import { decodePublicKey } from "../shared/signing.ts";
import { APP_VERSION, MANIFEST_URL, PUBLIC_KEY } from "./build-info.ts";
import { loadConfig, type AppConfig } from "./config.ts";
import { readLauncherContext } from "./launcher-context.ts";
import { loadAppState, saveAppState } from "./state.ts";
import { Ticker } from "./ticker.ts";
import { Updater } from "./updater.ts";

/** If a clean shutdown takes longer than this, something is stuck; exit anyway. */
const SHUTDOWN_DEADLINE_MS = 4000;

async function main(): Promise<void> {
  const layout = dataLayout(resolveDataDir());
  await mkdir(layout.logs, { recursive: true });
  const log = createLogger({
    component: "app",
    version: APP_VERSION,
    sinks: [stdoutSink, createFileSink(path.join(layout.logs, "app.log"))],
  });

  const config = await loadConfig({
    configFile: layout.config,
    env: process.env,
    builtInManifestUrl: MANIFEST_URL,
    log,
  });

  const state = await loadAppState(layout.appState, log);
  const ticker = new Ticker({
    intervalMs: config.tickIntervalMs,
    initialTicks: state.ticks,
    log,
    onTick: async (ticks) => {
      log.info("tick", { ticks });
      // Saved every tick, so even a crash loses at most one.
      await saveAppState(layout.appState, { ticks });
    },
  });
  ticker.start();

  const updater = createUpdater(config, layout, log);
  updater?.start();
  log.info("started", { dataDir: layout.root, ticks: state.ticks, updates: updater ? "enabled" : "disabled" });

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.info("shutting down", { reason });
    setTimeout(() => {
      log.error("shutdown deadline exceeded; exiting", { deadlineMs: SHUTDOWN_DEADLINE_MS });
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS).unref();

    updater?.stop();
    await ticker.stop();
    await saveAppState(layout.appState, { ticks: ticker.ticks });
    log.info("stopped", { ticks: ticker.ticks });
    process.exit(0);
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void shutdown(signal));
  }

  if (process.send) {
    // The launcher's shutdown request is also how a graceful stop works on
    // Windows, which has no SIGTERM.
    process.on("message", (message: unknown) => {
      if ((message as Partial<LauncherMessage> | null)?.type === "shutdown") {
        void shutdown("launcher request");
      }
    });
    // An app without its launcher is unsupervised, and a restarted launcher
    // would start a second copy alongside it. Better to exit.
    process.on("disconnect", () => void shutdown("launcher disconnected"));

    // Startup succeeded: state loaded, work running. This ends probation's
    // health-check wait (ADR-0006).
    const healthy: AppMessage = { type: "healthy" };
    process.send(healthy);
  }
}

/** The updater, or null (with the reason logged) when updates can't work. */
function createUpdater(config: AppConfig, layout: DataLayout, log: Logger): Updater | null {
  const disabled = (reason: string): null => {
    log.info("updates disabled", { reason });
    return null;
  };
  const launcher = readLauncherContext(process.env, typeof process.send === "function");
  if (!launcher) {
    return disabled("not started by the launcher");
  }
  if (!PUBLIC_KEY) {
    return disabled("no public key built in");
  }
  if (!config.manifestUrl) {
    return disabled("no manifest URL configured");
  }

  return new Updater({
    manifestUrl: config.manifestUrl,
    publicKey: decodePublicKey(PUBLIC_KEY),
    installedVersion: APP_VERSION,
    launcherVersion: launcher.launcherVersion,
    badVersions: launcher.badVersions,
    pollIntervalMs: config.pollIntervalMs,
    initialDelayMs: config.firstCheckDelayMs,
    layout,
    log,
    onStaged: (version) => {
      const message: AppMessage = { type: "staged", version };
      process.send?.(message);
    },
  });
}

main().catch((error: unknown) => {
  // The logger may not exist yet, so fall back to plain stderr.
  console.error("app failed to start:", error);
  process.exit(1);
});
