// Runtime settings (DESIGN.md#configuration). Each setting comes from the first
// valid source in this order:
//
//   1. environment variable   (tests, the demo, one-off debugging)
//   2. config.json in the data directory   (operators)
//   3. the value baked into the bundle at build time, or a default
//
// An invalid value is logged and skipped rather than fatal: a typo in a config
// file must not stop the program, or its ability to update, from working.
//
// The signing public key is deliberately *not* configurable. It's the trust
// anchor, so it only ever comes from the signed bundle itself.

import { readFile } from "node:fs/promises";
import type { Logger } from "../shared/log.ts";
import { isAllowedUpdateUrl } from "../shared/url-policy.ts";

export interface AppConfig {
  /** Undefined means updates are disabled (e.g. a development build). */
  readonly manifestUrl: string | undefined;
  readonly pollIntervalMs: number;
  /** Delay before the first update check, so startup and probation settle first. */
  readonly firstCheckDelayMs: number;
  readonly tickIntervalMs: number;
}

export interface ConfigSources {
  readonly configFile: string;
  readonly env: NodeJS.ProcessEnv;
  readonly builtInManifestUrl: string | undefined;
  readonly log: Logger;
}

const DEFAULT_POLL_INTERVAL_SECONDS = 60 * 60;
const DEFAULT_FIRST_CHECK_DELAY_SECONDS = 10;
const DEFAULT_TICK_INTERVAL_MS = 5000;

export async function loadConfig({ configFile, env, builtInManifestUrl, log }: ConfigSources): Promise<AppConfig> {
  const file = await readConfigFile(configFile, log);
  const pick = <T>(name: string, candidates: ReadonlyArray<readonly [string, unknown]>, parse: (value: unknown) => T | undefined, fallback: T): T => {
    for (const [source, value] of candidates) {
      if (value === undefined || value === "") {
        continue;
      }
      const parsed = parse(value);
      if (parsed !== undefined) {
        return parsed;
      }
      log.warn("ignoring invalid setting", { setting: name, source, value });
    }
    return fallback;
  };

  return {
    manifestUrl: pick(
      "manifestUrl",
      [
        ["env NAMETAG_MANIFEST_URL", env.NAMETAG_MANIFEST_URL],
        ["config.json", file.manifestUrl],
        ["built in", builtInManifestUrl],
      ],
      parseUpdateUrl,
      undefined,
    ),
    pollIntervalMs:
      1000 *
      pick(
        "pollIntervalSeconds",
        [
          ["env NAMETAG_POLL_INTERVAL_SECONDS", env.NAMETAG_POLL_INTERVAL_SECONDS],
          ["config.json", file.pollIntervalSeconds],
        ],
        parsePositiveNumber,
        DEFAULT_POLL_INTERVAL_SECONDS,
      ),
    firstCheckDelayMs:
      1000 *
      pick(
        "firstCheckDelaySeconds",
        [
          ["env NAMETAG_FIRST_CHECK_DELAY_SECONDS", env.NAMETAG_FIRST_CHECK_DELAY_SECONDS],
          ["config.json", file.firstCheckDelaySeconds],
        ],
        parseNonNegativeNumber,
        DEFAULT_FIRST_CHECK_DELAY_SECONDS,
      ),
    tickIntervalMs: pick(
      "tickIntervalMs",
      [
        ["env NAMETAG_TICK_INTERVAL_MS", env.NAMETAG_TICK_INTERVAL_MS],
        ["config.json", file.tickIntervalMs],
      ],
      parsePositiveNumber,
      DEFAULT_TICK_INTERVAL_MS,
    ),
  };
}

async function readConfigFile(configFile: string, log: Logger): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(configFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("could not read config file; using defaults", { configFile, error });
    }
    return {};
  }
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Reported below.
  }
  log.warn("config file is not a JSON object; using defaults", { configFile });
  return {};
}

function parseUpdateUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !URL.canParse(value)) {
    return undefined;
  }
  const url = new URL(value);
  return isAllowedUpdateUrl(url) ? url.href : undefined;
}

// Environment variables arrive as strings, config.json values as numbers.
function parsePositiveNumber(value: unknown): number | undefined {
  const number = parseNonNegativeNumber(value);
  return number !== undefined && number > 0 ? number : undefined;
}

function parseNonNegativeNumber(value: unknown): number | undefined {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number >= 0 ? number : undefined;
}
