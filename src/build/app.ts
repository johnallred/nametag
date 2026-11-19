// Bundles the app into the single, platform-independent app.cjs that a release
// consists of (ADR-0002).

import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { parseVersion } from "../shared/semver.ts";
import { decodePublicKey } from "../shared/signing.ts";
import { assertAllowedUpdateUrl } from "../shared/url-policy.ts";

export interface BuildAppOptions {
  readonly version: string;
  readonly outFile: string;
  /** Base64 SPKI Ed25519 public key. Without it, the build can't self-update. */
  readonly publicKey?: string;
  /** Default manifest location. Without it, one must come from config. */
  readonly manifestUrl?: string;
}

export async function buildApp({ version, outFile, publicKey, manifestUrl }: BuildAppOptions): Promise<void> {
  // Validate everything that gets baked in: a bad value here would ship to
  // every client in a bundle that can never update itself again.
  parseVersion(version);
  if (publicKey !== undefined) {
    decodePublicKey(publicKey);
  }
  if (manifestUrl !== undefined) {
    assertAllowedUpdateUrl(new URL(manifestUrl), "manifest URL");
  }

  await build({
    entryPoints: [fileURLToPath(new URL("../app/main.ts", import.meta.url))],
    outfile: outFile,
    bundle: true,
    platform: "node",
    target: "node22",
    // CommonJS, because the launcher loads releases with require().
    format: "cjs",
    define: {
      __NAMETAG_VERSION__: JSON.stringify(version),
      __NAMETAG_PUBLIC_KEY__: literal(publicKey),
      __NAMETAG_MANIFEST_URL__: literal(manifestUrl),
    },
    // Unminified, so stack traces in client logs are readable as-is.
    minify: false,
    legalComments: "none",
    logLevel: "warning",
  });
}

// esbuild's `define` takes source text; JSON.stringify(undefined) isn't a string.
function literal(value: string | undefined): string {
  return value === undefined ? "undefined" : JSON.stringify(value);
}
