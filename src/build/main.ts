// Entry point for builds:
//
//   build app --version <x.y.z> [--out dist/app.js]
//             [--public-key keys/signing.pub] [--manifest-url <url>]

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { buildApp } from "./app.ts";

const USAGE = "usage: build app --version <x.y.z> [--out <file>] [--public-key <file>] [--manifest-url <url>]";

async function main(argv: readonly string[]): Promise<void> {
  const [target, ...rest] = argv;
  if (target !== "app") {
    throw new Error(target === undefined ? "missing build target" : `unknown build target "${target}"`);
  }
  const { values } = parseArgs({
    args: [...rest],
    options: {
      version: { type: "string" },
      out: { type: "string", default: "dist/app.js" },
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

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`${(error as Error).message}\n\n${USAGE}`);
  process.exit(1);
});
