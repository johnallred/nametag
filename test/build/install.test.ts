import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { assembleInstall } from "../../src/build/install.ts";
import { executableName } from "../../src/build/launcher.ts";
import { makeTempDir } from "../helpers.ts";

describe("assembleInstall", () => {
  it("lays out the launcher, one version and the current pointer", async () => {
    const dir = await makeTempDir();
    const appPath = path.join(dir, "app.js");
    const launcherPath = path.join(dir, "launcher-binary");
    await writeFile(appPath, "console.log('v1');");
    await writeFile(launcherPath, "binary");
    const outDir = path.join(dir, "install");

    await assembleInstall({ outDir, appPath, version: "1.0.0", launcherPath });

    assert.deepEqual((await readdir(outDir)).sort(), ["current", executableName(), "versions"].sort());
    assert.equal(await readFile(path.join(outDir, "current"), "utf8"), "1.0.0\n");
    assert.equal(await readFile(path.join(outDir, "versions", "1.0.0", "app.js"), "utf8"), "console.log('v1');");
  });

  it("refuses to overwrite an existing install", async () => {
    const dir = await makeTempDir();
    const appPath = path.join(dir, "app.js");
    await writeFile(appPath, "");
    const outDir = path.join(dir, "install");
    await assembleInstall({ outDir, appPath, version: "1.0.0" });
    await assert.rejects(assembleInstall({ outDir, appPath, version: "1.1.0" }), /already contains an install/);
  });
});
