import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

const tempDirs: string[] = [];

// Registered once, at import time (top level of the test file), so it runs
// when the whole file finishes. Calling after() inside makeTempDir instead
// would attach it to whichever hook or test is running, and a dir created in
// a before() hook would be deleted as soon as that hook returned.
after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

/** A fresh temp directory, removed when the current test file finishes. */
export async function makeTempDir(prefix = "nametag-test-"): Promise<string> {
  // realpath: on macOS os.tmpdir() is a symlink (/var -> /private/var), which
  // would otherwise make path comparisons in tests flaky.
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}
