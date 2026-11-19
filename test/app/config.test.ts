import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../../src/app/config.ts";
import { createLogger } from "../../src/shared/log.ts";
import { makeTempDir } from "../helpers.ts";

async function load(options: { file?: unknown; env?: NodeJS.ProcessEnv; builtIn?: string } = {}) {
  const configFile = path.join(await makeTempDir(), "config.json");
  if (options.file !== undefined) {
    await writeFile(configFile, typeof options.file === "string" ? options.file : JSON.stringify(options.file));
  }
  const lines: string[] = [];
  const config = await loadConfig({
    configFile,
    env: options.env ?? {},
    builtInManifestUrl: options.builtIn,
    log: createLogger({ component: "test", sinks: [(line) => lines.push(line)] }),
  });
  return { config, warnings: lines.filter((line) => line.includes('"level":"warn"')) };
}

describe("loadConfig", () => {
  it("uses defaults when nothing is configured", async () => {
    const { config, warnings } = await load();
    assert.deepEqual(config, { manifestUrl: undefined, pollIntervalMs: 3_600_000, firstCheckDelayMs: 10_000, tickIntervalMs: 5000 });
    assert.deepEqual(warnings, []);
  });

  it("prefers env over config.json over the built-in value", async () => {
    const builtIn = "https://built.in/manifest.json";
    const file = { manifestUrl: "https://from.file/manifest.json", pollIntervalSeconds: 120, tickIntervalMs: 250 };

    assert.equal((await load({ builtIn })).config.manifestUrl, builtIn);
    assert.equal((await load({ builtIn, file })).config.manifestUrl, file.manifestUrl);
    const { config } = await load({
      builtIn,
      file,
      env: { NAMETAG_MANIFEST_URL: "http://localhost:8080/manifest.json", NAMETAG_POLL_INTERVAL_SECONDS: "0.5", NAMETAG_TICK_INTERVAL_MS: "10" },
    });
    assert.deepEqual(config, { manifestUrl: "http://localhost:8080/manifest.json", pollIntervalMs: 500, firstCheckDelayMs: 10_000, tickIntervalMs: 10 });
  });

  it("skips an invalid value with a warning and falls through to the next source", async () => {
    const { config, warnings } = await load({
      builtIn: "https://built.in/manifest.json",
      file: { manifestUrl: "not a url", pollIntervalSeconds: -5 },
      env: { NAMETAG_TICK_INTERVAL_MS: "fast" },
    });
    assert.deepEqual(config, { manifestUrl: "https://built.in/manifest.json", pollIntervalMs: 3_600_000, firstCheckDelayMs: 10_000, tickIntervalMs: 5000 });
    assert.equal(warnings.length, 3);
  });

  it("refuses a plain-HTTP manifest URL that isn't localhost", async () => {
    const { config, warnings } = await load({ env: { NAMETAG_MANIFEST_URL: "http://updates.example.com/manifest.json" } });
    assert.equal(config.manifestUrl, undefined);
    assert.equal(warnings.length, 1);
  });

  for (const [label, file] of [
    ["invalid JSON", "{ nope"],
    ["a JSON array", "[1, 2]"],
  ] as const) {
    it(`ignores a config file containing ${label}, with a warning`, async () => {
      const { config, warnings } = await load({ file });
      assert.equal(config.pollIntervalMs, 3_600_000);
      assert.equal(warnings.length, 1);
    });
  }
});

describe("firstCheckDelaySeconds", () => {
  it("accepts zero, for an immediate first check", async () => {
    const { config } = await load({ env: { NAMETAG_FIRST_CHECK_DELAY_SECONDS: "0" } });
    assert.equal(config.firstCheckDelayMs, 0);
  });
});
