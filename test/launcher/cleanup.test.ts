import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { cleanUp } from "../../src/launcher/cleanup.ts";
import { createLogger } from "../../src/shared/log.ts";
import { dataLayout } from "../../src/shared/paths.ts";
import { makeTempDir } from "../helpers.ts";

describe("cleanUp", () => {
  it("removes interrupted work and obsolete versions, keeping current, previous and anything unknown", async () => {
    const layout = dataLayout(await makeTempDir());
    for (const dir of ["1.0.0", "1.1.0", "1.2.0", "1.3.0.partial", "notes"]) {
      await mkdir(path.join(layout.versions, dir), { recursive: true });
    }
    await writeFile(path.join(layout.versions, "x.download.tmp"), "");
    await writeFile(path.join(layout.root, "current.123.abcd.tmp"), "");
    await writeFile(layout.current, "1.2.0\n");
    await writeFile(layout.appState, "{}");

    await cleanUp(layout, new Set(["1.2.0", "1.1.0"]), createLogger({ component: "test", sinks: [] }));

    assert.deepEqual((await readdir(layout.versions)).sort(), ["1.1.0", "1.2.0", "notes"]);
    assert.deepEqual((await readdir(layout.root)).sort(), ["app-state.json", "current", "versions"]);
  });

  it("copes with a data directory that has no versions folder yet", async () => {
    const layout = dataLayout(await makeTempDir());
    await cleanUp(layout, new Set(), createLogger({ component: "test", sinks: [] }));
  });
});
