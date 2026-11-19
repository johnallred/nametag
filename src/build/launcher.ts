// Builds the launcher as a Node Single Executable Application (ADR-0001): the
// launcher bundle injected into a copy of the node binary, so clients need no
// runtime installed. Follows https://nodejs.org/api/single-executable-applications.html
// for Node 22, which needs the `postject` tool (a build-time dependency only).
//
// The executable is built for the OS it's built on; CI builds one per OS.

import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

const run = promisify(execFile);

// Fixed by Node: the marker postject flips to tell node a blob is present.
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

export function executableName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "nametag.exe" : "nametag";
}

/** Bundles the launcher into one CommonJS file (also runnable with plain node). */
export async function bundleLauncher(outFile: string): Promise<void> {
  await build({
    entryPoints: [fileURLToPath(new URL("../launcher/main.ts", import.meta.url))],
    outfile: outFile,
    bundle: true,
    platform: "node",
    target: "node22",
    // SEA requires a CommonJS entry script.
    format: "cjs",
    minify: false,
    legalComments: "none",
    logLevel: "warning",
  });
}

/** Builds the launcher executable into `outDir` and returns its path. */
export async function buildLauncherExecutable(outDir: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const bundle = path.join(outDir, "launcher.cjs");
  const blob = path.join(outDir, "sea-prep.blob");
  const seaConfig = path.join(outDir, "sea-config.json");
  const executable = path.join(outDir, executableName());

  await bundleLauncher(bundle);
  await writeFile(
    seaConfig,
    JSON.stringify({
      main: bundle,
      output: blob,
      disableExperimentalSEAWarning: true,
      // Snapshots and code caches tie the blob to one exact node build; we
      // don't need the startup speed, so keep it portable.
      useSnapshot: false,
      useCodeCache: false,
    }),
  );
  await run(process.execPath, ["--experimental-sea-config", seaConfig]);

  await copyFile(process.execPath, executable);
  await chmod(executable, 0o755);
  if (process.platform === "darwin") {
    // The copied node binary is signed; injecting invalidates that signature.
    await run("codesign", ["--remove-signature", executable]);
  }

  const postject = createRequire(import.meta.url).resolve("postject/dist/cli.js");
  await run(process.execPath, [
    postject,
    executable,
    "NODE_SEA_BLOB",
    blob,
    "--sentinel-fuse",
    SEA_FUSE,
    ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : []),
  ]);

  if (process.platform === "darwin") {
    // Ad-hoc signature: required for arm64 Macs to run it at all. Real
    // distribution needs a Developer ID signature and notarization (DESIGN.md,
    // known limitations).
    await run("codesign", ["--sign", "-", executable]);
  }
  return executable;
}
