// Assembles what a fresh install looks like: the data directory with the
// launcher, one app version, and `current` pointing at it. Packaging this
// directory as a per-OS archive or installer is outside this project's scope
// (DESIGN.md, known limitations); unpacking it into the data directory is
// the whole installation.

import { access, chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseVersion } from "../shared/semver.ts";
import { executableName } from "./launcher.ts";

export interface InstallOptions {
  readonly outDir: string;
  readonly appPath: string;
  readonly version: string;
  /** The launcher executable; omitted for installs run by a dev launcher. */
  readonly launcherPath?: string;
}

export async function assembleInstall({ outDir, appPath, version, launcherPath }: InstallOptions): Promise<void> {
  parseVersion(version);
  const current = path.join(outDir, "current");
  if (await access(current).then(() => true, () => false)) {
    throw new Error(`${outDir} already contains an install`);
  }

  await mkdir(path.join(outDir, "versions", version), { recursive: true });
  await copyFile(appPath, path.join(outDir, "versions", version, "app.cjs"));
  if (launcherPath) {
    const target = path.join(outDir, executableName());
    await copyFile(launcherPath, target);
    await chmod(target, 0o755);
  }
  // Written last: an install without `current` is visibly incomplete.
  await writeFile(current, `${version}\n`);
}
