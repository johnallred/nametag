// Entry point for builds:
//
//   build app      --version <x.y.z> [--out dist/app.cjs]
//                  [--public-key keys/signing.pub] [--manifest-url <url>]
//   build launcher [--out-dir dist/launcher]
//   build install  --app <app.cjs> --version <x.y.z> --out-dir <dir> [--launcher <exe>]

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { buildApp } from "./app.ts";
import { assembleInstall } from "./install.ts";
import { buildLauncherExecutable } from "./launcher.ts";

const USAGE = `usage:
  build app      --version <x.y.z> [--out <file>] [--public-key <file>] [--manifest-url <url>]
  build launcher [--out-dir <dir>]
  build install  --app <app.cjs> --version <x.y.z> --out-dir <dir> [--launcher <exe>]`;

async function main(argv: readonly string[]): Promise<void> {
  const [target, ...rest] = argv;
  switch (target) {
    case "app":
      return runBuildApp(rest);
    case "launcher":
      return runBuildLauncher(rest);
    case "install":
      return runBuildInstall(rest);
    default:
      throw new Error(target === undefined ? "missing build target" : `unknown build target "${target}"`);
  }
}

async function runBuildApp(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      version: { type: "string" },
      out: { type: "string", default: "dist/app.cjs" },
      "public-key": { type: "string" },
      "manifest-url": { type: "string" },
    },
  });
  if (!values.version) {
    throw new Error("build app needs --version");
  }
  const publicKey = values["public-key"] ? (await readFile(values["public-key"], "utf8")).trim() : undefined;
  if (!publicKey) {
    console.warn("warning: no --public-key; this build will not be able to update itself");
  }

  await buildApp({
    version: values.version,
    outFile: values.out,
    ...(publicKey ? { publicKey } : {}),
    ...(values["manifest-url"] ? { manifestUrl: values["manifest-url"] } : {}),
  });
  console.log(`built app ${values.version} -> ${values.out}`);
}

async function runBuildLauncher(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({ args: [...args], options: { "out-dir": { type: "string", default: "dist/launcher" } } });
  const executable = await buildLauncherExecutable(values["out-dir"]);
  console.log(`built launcher -> ${executable}`);
}

async function runBuildInstall(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      app: { type: "string" },
      version: { type: "string" },
      "out-dir": { type: "string" },
      launcher: { type: "string" },
    },
  });
  if (!values.app || !values.version || !values["out-dir"]) {
    throw new Error("build install needs --app, --version and --out-dir");
  }
  await assembleInstall({
    outDir: values["out-dir"],
    appPath: values.app,
    version: values.version,
    ...(values.launcher ? { launcherPath: values.launcher } : {}),
  });
  console.log(`assembled install of ${values.version} -> ${values["out-dir"]}`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`${(error as Error).message}\n\n${USAGE}`);
  process.exit(1);
});
