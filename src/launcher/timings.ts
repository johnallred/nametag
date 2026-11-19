// Optional overrides for the supervisor's timings, read from the environment.
// They exist so tests and demos can run probation in seconds instead of
// minutes. The launcher deliberately has no config file: it's the part that
// can't be fixed by an update, so it should have as few moving parts as possible.

import type { SupervisorOptions } from "./supervisor.ts";

type Timings = Pick<SupervisorOptions, "healthTimeoutMs" | "probationMs" | "shutdownTimeoutMs">;

const VARIABLES = {
  healthTimeoutMs: "NAMETAG_HEALTH_TIMEOUT_MS",
  probationMs: "NAMETAG_PROBATION_MS",
  shutdownTimeoutMs: "NAMETAG_SHUTDOWN_TIMEOUT_MS",
} as const;

/** The overrides that are set and valid; anything else keeps its default. */
export function readTimingOverrides(env: NodeJS.ProcessEnv): Timings {
  const timings: { -readonly [K in keyof Timings]: number } = {};
  for (const [key, variable] of Object.entries(VARIABLES) as Array<[keyof Timings, string]>) {
    const value = Number(env[variable]);
    if (env[variable] && Number.isInteger(value) && value > 0) {
      timings[key] = value;
    }
  }
  return timings;
}
