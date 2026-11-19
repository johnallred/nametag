import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { writeFileAtomic } from "../../src/shared/fs.ts";
import { makeTempDir } from "../helpers.ts";

describe("writeFileAtomic", () => {
  it("creates a file and replaces it, leaving no temp files behind", async () => {
    const dir = await makeTempDir();
    const target = path.join(dir, "current");

    await writeFileAtomic(target, "1.0.0");
    await writeFileAtomic(target, "1.1.0");

    assert.equal(await readFile(target, "utf8"), "1.1.0");
    assert.deepEqual(await readdir(dir), ["current"]);
  });

  it("cleans up its temp file and rethrows when the write fails", async () => {
    const dir = await makeTempDir();
    // The target's directory doesn't exist, so the temp write itself fails.
    await assert.rejects(writeFileAtomic(path.join(dir, "missing", "file"), "x"), { code: "ENOENT" });
    assert.deepEqual(await readdir(dir), []);
  });

  it("applies the requested mode to a new file", { skip: process.platform === "win32" && "POSIX modes" }, async () => {
    const dir = await makeTempDir();
    const target = path.join(dir, "secret");
    await writeFileAtomic(target, "x", { mode: 0o600 });
    assert.equal((await stat(target)).mode & 0o777, 0o600);
  });
});
