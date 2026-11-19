import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLogger } from "../../src/shared/log.ts";

function capture() {
  const lines: string[] = [];
  const log = createLogger({
    component: "test",
    version: "1.2.3",
    sinks: [(line) => lines.push(line)],
    now: () => new Date("2026-11-18T12:00:00Z"),
  });
  const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { log, lines, records };
}

describe("logger", () => {
  it("writes one JSON object per line with the standard fields", () => {
    const { log, lines, records } = capture();
    log.info("hello", { answer: 42 });

    assert.equal(lines.length, 1);
    assert.ok(lines[0]?.endsWith("}\n"));
    assert.deepEqual(records()[0], {
      time: "2026-11-18T12:00:00.000Z",
      level: "info",
      msg: "hello",
      component: "test",
      version: "1.2.3",
      pid: process.pid,
      answer: 42,
    });
  });

  it("adds child fields to every line", () => {
    const { log, records } = capture();
    log.child({ requestId: "abc" }).warn("careful");
    assert.equal(records()[0]?.requestId, "abc");
    assert.equal(records()[0]?.level, "warn");
  });

  it("serializes errors instead of logging {}", () => {
    const { log, records } = capture();
    log.error("boom", { error: Object.assign(new Error("disk full"), { code: "ENOSPC" }) });
    const error = records()[0]?.error as Record<string, unknown>;
    assert.equal(error.message, "disk full");
    assert.equal(error.code, "ENOSPC");
    assert.match(String(error.stack), /disk full/);
  });

  it("survives a sink that throws", () => {
    const seen: string[] = [];
    const log = createLogger({
      component: "test",
      sinks: [
        () => {
          throw new Error("pipe closed");
        },
        (line) => seen.push(line),
      ],
    });
    assert.doesNotThrow(() => log.info("still here"));
    assert.equal(seen.length, 1);
  });
});
