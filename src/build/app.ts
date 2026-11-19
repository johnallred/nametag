// Bundles the app into the single, platform-independent app.js that a release
// consists of (ADR-0002).

import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { parseVersion } from "../shared/semver.ts";

export interface BuildAppOptions {
  readonly version: string;
  readonly outFile: string;
}

export async function buildApp({ version, outFile }: BuildAppOptions): Promise<void> {
  parseVersion(version);
  await build({
    entryPoints: [fileURLToPath(new URL("../app/main.ts", import.meta.url))],
    outfile: outFile,
    bundle: true,
    platform: "node",
    target: "node22",
    // CommonJS, because the launcher loads releases with require().
    format: "cjs",
    define: { __NAMETAG_VERSION__: JSON.stringify(version) },
    // Unminified, so stack traces in client logs are readable as-is.
    minify: false,
    legalComments: "none",
    logLevel: "warning",
  });
}
