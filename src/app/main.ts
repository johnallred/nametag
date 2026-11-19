// The app's entry point: the code inside each versions/<v>/app.js bundle.
//
// For now it runs standalone (`node src/app/main.ts`). The updater and the
// launcher's IPC channel (health reports, shutdown requests) plug in here in
// later slices.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createLogger, stdoutSink, type Logger } from "../shared/log.ts";
import { createFileSink } from "../shared/log-file.ts";
import { dataLayout, resolveDataDir } from "../shared/paths.ts";
import { APP_VERSION } from "./build-info.ts";
import { loadAppState, saveAppState } from "./state.ts";
import { Ticker } from "./ticker.ts";

const DEFAULT_TICK_INTERVAL_MS = 5000;
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

  const state = await loadAppState(layout.appState, log);
  const ticker = new Ticker({
    intervalMs: tickInterval(log),
    initialTicks: state.ticks,
    log,
    onTick: async (ticks) => {
      log.info("tick", { ticks });
      // Saved every tick, so even a crash loses at most one.
      await saveAppState(layout.appState, { ticks });
    },
  });
  ticker.start();
  log.info("started", { dataDir: layout.root, ticks: state.ticks });

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

    await ticker.stop();
    await saveAppState(layout.appState, { ticks: ticker.ticks });
    log.info("stopped", { ticks: ticker.ticks });
    process.exit(0);
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void shutdown(signal));
  }
}

function tickInterval(log: Logger): number {
  const raw = process.env.NAMETAG_TICK_INTERVAL_MS;
  if (raw === undefined) {
    return DEFAULT_TICK_INTERVAL_MS;
  }
  const value = Number(raw);
  if (Number.isInteger(value) && value > 0) {
    return value;
  }
  log.warn("ignoring invalid NAMETAG_TICK_INTERVAL_MS", { value: raw });
  return DEFAULT_TICK_INTERVAL_MS;
}

main().catch((error: unknown) => {
  // The logger may not exist yet, so fall back to plain stderr.
  console.error("app failed to start:", error);
  process.exit(1);
});
