// Fake app versions for exercising the launcher with real processes. Each one
// speaks the IPC protocol and records what happens to it in events.log.

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SpawnApp } from "../../src/launcher/spawn.ts";

export interface FakeAppBehaviour {
  /** Report healthy at startup. Default true. */
  readonly healthy?: boolean;
  /** Exit with code 3 this long after starting. */
  readonly crashAfterMs?: number;
  /** Report this version as staged shortly after starting. */
  readonly stage?: string;
  /** Don't exit when asked to shut down. */
  readonly ignoreShutdown?: boolean;
}

export interface AppEvent {
  readonly event: "start" | "shutdown-requested" | "graceful-exit" | "crash";
  readonly version: string;
  readonly pid: number;
  readonly badVersions?: string;
  readonly launcherVersion?: string;
}

function source({ healthy = true, crashAfterMs, stage, ignoreShutdown = false }: FakeAppBehaviour): string {
  return `
const fs = require("node:fs");
const path = require("node:path");
const version = path.basename(__dirname);
const record = (event, extra = {}) =>
  fs.appendFileSync(path.join(process.env.NAMETAG_DATA_DIR, "events.log"),
    JSON.stringify({ event, version, pid: process.pid, ...extra }) + "\\n");

record("start", { badVersions: process.env.NAMETAG_BAD_VERSIONS, launcherVersion: process.env.NAMETAG_LAUNCHER_VERSION });
process.on("message", (message) => {
  if (message && message.type === "shutdown") {
    record("shutdown-requested");
    if (!${ignoreShutdown}) { record("graceful-exit"); process.exit(0); }
  }
});
${ignoreShutdown ? "" : 'process.on("disconnect", () => process.exit(0));'}
if (${healthy}) process.send({ type: "healthy" });
${crashAfterMs === undefined ? "" : `setTimeout(() => { record("crash"); process.exit(3); }, ${crashAfterMs});`}
${stage === undefined ? "" : `setTimeout(() => process.send({ type: "staged", version: ${JSON.stringify(stage)} }), 30);`}
setInterval(() => {}, 1000);
`;
}

export async function installFakeApp(dataDir: string, version: string, behaviour: FakeAppBehaviour = {}): Promise<void> {
  await mkdir(path.join(dataDir, "versions", version), { recursive: true });
  await writeFile(path.join(dataDir, "versions", version, "app.cjs"), source(behaviour));
}

export async function readEvents(dataDir: string): Promise<AppEvent[]> {
  const text = await readFile(path.join(dataDir, "events.log"), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AppEvent);
}

/** Runs fake apps with plain node (the real spawner re-runs the launcher). */
export const spawnWithNode: SpawnApp = (appPath, env) =>
  spawn(process.execPath, [appPath], { env, stdio: ["ignore", "ignore", "inherit", "ipc"] });
