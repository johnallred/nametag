// Entry point for builds:
//
//   build app --version <x.y.z> [--out dist/app.js]

import { parseArgs } from "node:util";
import { buildApp } from "./app.ts";

const USAGE = "usage: build app --version <x.y.z> [--out <file>]";

async function main(argv: readonly string[]): Promise<void> {
  const [target, ...rest] = argv;
  if (target !== "app") {
    throw new Error(target === undefined ? "missing build target" : `unknown build target "${target}"`);
  }
  const { values } = parseArgs({
    args: [...rest],
    options: { version: { type: "string" }, out: { type: "string", default: "dist/app.js" } },
  });
  if (!values.version) {
    throw new Error("build app needs --version");
  }
  await buildApp({ version: values.version, outFile: values.out });
  console.log(`built app ${values.version} -> ${values.out}`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`${(error as Error).message}\n\n${USAGE}`);
  process.exit(1);
});
