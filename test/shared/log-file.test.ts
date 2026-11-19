import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { createFileSink } from "../../src/shared/log-file.ts";
import { makeTempDir } from "../helpers.ts";

describe("file sink", () => {
  it("appends lines to the file", async () => {
    const file = path.join(await makeTempDir(), "app.log");
    const sink = createFileSink(file);
    sink("one\n");
    sink("two\n");
    assert.equal(await readFile(file, "utf8"), "one\ntwo\n");
  });

  it("rotates by size and keeps only maxFiles rotated files", async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, "app.log");
    const sink = createFileSink(file, { maxBytes: 10, maxFiles: 2 });
    for (const line of ["aaaaaaa\n", "bbbbbbb\n", "ccccccc\n", "ddddddd\n"]) {
      sink(line);
    }

    assert.deepEqual((await readdir(dir)).sort(), ["app.log", "app.log.1", "app.log.2"]);
    assert.equal(await readFile(file, "utf8"), "ddddddd\n");
    assert.equal(await readFile(`${file}.1`, "utf8"), "ccccccc\n");
    assert.equal(await readFile(`${file}.2`, "utf8"), "bbbbbbb\n");
  });

  it("counts an existing file's size, so a restart doesn't let the log grow unbounded", async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, "app.log");
    await writeFile(file, "x".repeat(10));
    createFileSink(file, { maxBytes: 10 })("y\n");
    assert.equal(await readFile(`${file}.1`, "utf8"), "x".repeat(10));
    assert.equal(await readFile(file, "utf8"), "y\n");
  });
});
