import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { acquireLock } from "../../src/launcher/lock.ts";
import { makeTempDir } from "../helpers.ts";

describe("acquireLock", () => {
  it("is exclusive until released", async () => {
    const file = path.join(await makeTempDir(), "nametag.lock");
    const lock = await acquireLock(file);
    assert.ok(lock);
    assert.equal((await readFile(file, "utf8")).trim(), String(process.pid));
    assert.equal(await acquireLock(file), null, "a second holder is refused");

    lock.release();
    const again = await acquireLock(file);
    assert.ok(again, "free again after release");
    again.release();
  });

  it("takes over a lock left by a process that no longer exists", async () => {
    const file = path.join(await makeTempDir(), "nametag.lock");
    // A real PID that has certainly exited.
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    await writeFile(file, `${deadPid}\n`);

    const lock = await acquireLock(file);
    assert.ok(lock);
    lock.release();
  });

  it("takes over a lock file with garbage in it", async () => {
    const file = path.join(await makeTempDir(), "nametag.lock");
    await writeFile(file, "not a pid");
    const lock = await acquireLock(file);
    assert.ok(lock);
    lock.release();
  });

  it("release() leaves a lock alone that someone else now holds", async () => {
    const file = path.join(await makeTempDir(), "nametag.lock");
    const lock = await acquireLock(file);
    assert.ok(lock);
    await writeFile(file, "1\n"); // As if another launcher took over.
    lock.release();
    assert.equal(await readFile(file, "utf8"), "1\n");
  });
});
