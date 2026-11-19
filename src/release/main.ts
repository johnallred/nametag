// Entry point for the release tool:
//
//   release keygen  [--out <dir>]
//   release publish --artifact <app.js> --version <x.y.z> [--root <dir>]
//                   [--key <file> | NAMETAG_SIGNING_KEY=<base64>]
//                   [--channel stable] [--min-launcher 1.0.0] [--valid-days 30]

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { keygen, publish } from "./commands.ts";

const USAGE = `usage:
  release keygen  [--out <dir>]
  release publish --artifact <app.js> --version <x.y.z> [--root <dir>]
                  [--key <file> | env NAMETAG_SIGNING_KEY]
                  [--channel <name>] [--min-launcher <x.y.z>] [--valid-days <n>]`;

class UsageError extends Error {}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "keygen":
      return runKeygen(rest);
    case "publish":
      return runPublish(rest);
    default:
      throw new UsageError(command === undefined ? "missing command" : `unknown command "${command}"`);
  }
}

async function runKeygen(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({ args: [...args], options: { out: { type: "string", default: "keys" } } });
  const result = await keygen(values.out);
  console.log(`private key: ${result.privateKeyPath}  (keep secret, never commit)`);
  console.log(`public key:  ${result.publicKeyPath}`);
  console.log(`\n${result.publicKey}`);
}

async function runPublish(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      artifact: { type: "string" },
      version: { type: "string" },
      root: { type: "string", default: "releases" },
      key: { type: "string" },
      channel: { type: "string", default: "stable" },
      "min-launcher": { type: "string", default: "1.0.0" },
      "valid-days": { type: "string", default: "30" },
    },
  });
  if (!values.artifact || !values.version) {
    throw new UsageError("publish needs --artifact and --version");
  }

  const release = await publish({
    artifactPath: values.artifact,
    version: values.version,
    privateKey: await loadPrivateKey(values.key),
    root: values.root,
    channel: values.channel,
    minLauncherVersion: values["min-launcher"],
    validDays: Number(values["valid-days"]),
  });
  console.log(`published ${release.version} to ${values.root} (sha256 ${release.artifact.sha256}, expires ${release.expiresAt})`);
}

// The key comes from a file or the environment (for CI secrets), never from a
// command-line argument, where it would land in shell history and `ps` output.
async function loadPrivateKey(keyFile: string | undefined): Promise<string> {
  if (keyFile) {
    return readFile(keyFile, "utf8");
  }
  const fromEnv = process.env.NAMETAG_SIGNING_KEY;
  if (fromEnv) {
    return fromEnv;
  }
  throw new UsageError("no signing key: pass --key <file> or set NAMETAG_SIGNING_KEY");
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof UsageError || (error as NodeJS.ErrnoException).code?.startsWith("ERR_PARSE_ARGS")) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  console.error(`release failed: ${(error as Error).message}`);
  process.exit(1);
});
