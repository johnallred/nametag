import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Ticker } from "../../src/app/ticker.ts";
import { createLogger } from "../../src/shared/log.ts";

const silent = createLogger({ component: "test", sinks: [] });

describe("Ticker", () => {
  it("counts up from the initial value", async () => {
    const seen: number[] = [];
    const ticker = new Ticker({ intervalMs: 5, initialTicks: 10, log: silent, onTick: (ticks) => void seen.push(ticks) });
    ticker.start();
    await sleep(60);
    await ticker.stop();

    assert.ok(seen.length >= 2, `expected several ticks, got ${seen.length}`);
    assert.deepEqual(seen, seen.map((_, index) => 11 + index));
    assert.equal(ticker.ticks, seen.at(-1));
  });

  it("stop() waits for a tick in progress, and no ticks happen afterwards", async () => {
    let finished = 0;
    let started = 0;
    const ticker = new Ticker({
      intervalMs: 1,
      initialTicks: 0,
      log: silent,
      onTick: async () => {
        started += 1;
        await sleep(30);
        finished += 1;
      },
    });
    ticker.start();
    await sleep(10); // Now inside the first, slow tick.
    await ticker.stop();

    assert.equal(started, 1);
    assert.equal(finished, 1, "the in-flight tick completed before stop() resolved");
    await sleep(20);
    assert.equal(started, 1, "nothing ticked after stop()");
  });

  it("logs a failing tick and keeps going", async () => {
    const lines: string[] = [];
    let calls = 0;
    const ticker = new Ticker({
      intervalMs: 2,
      initialTicks: 0,
      log: createLogger({ component: "test", sinks: [(line) => lines.push(line)] }),
      onTick: () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("disk full");
        }
      },
    });
    ticker.start();
    await sleep(40);
    await ticker.stop();

    assert.ok(calls >= 2);
    assert.match(lines[0] ?? "", /tick failed.*disk full/);
  });
});
