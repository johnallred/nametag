// A real update server over a temp release directory, for tests that need
// to publish releases and fetch them over HTTP.

import { writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { publish } from "../src/release/commands.ts";
import { createUpdateServer } from "../src/server/server.ts";
import { createLogger } from "../src/shared/log.ts";
import type { Release } from "../src/shared/manifest.ts";
import { generateSigningKeyPair, type EncodedKeyPair } from "../src/shared/signing.ts";
import { makeTempDir } from "./helpers.ts";

export interface ReleaseServer {
  readonly root: string;
  readonly keys: EncodedKeyPair;
  readonly manifestUrl: string;
  /** Publishes `content` as `version`, exactly as `release publish` would. */
  publishVersion(version: string, content: string, options?: { minLauncherVersion?: string; now?: Date }): Promise<Release>;
  close(): Promise<void>;
}

export const silentLogger = createLogger({ component: "test", sinks: [] });

export async function startReleaseServer(): Promise<ReleaseServer> {
  const dir = await makeTempDir();
  const root = path.join(dir, "releases");
  const keys = generateSigningKeyPair();
  const server = createUpdateServer({ root, log: silentLogger });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    root,
    keys,
    manifestUrl: `http://127.0.0.1:${port}/manifest.json`,
    async publishVersion(version, content, options = {}) {
      const artifactPath = path.join(dir, `app-${version}.js`);
      await writeFile(artifactPath, content);
      return publish({ artifactPath, version, privateKey: keys.privateKey, root, ...options });
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
