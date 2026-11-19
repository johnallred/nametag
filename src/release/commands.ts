// The developer-side release tool: generate the signing key, and publish a
// built app.js into a release directory that the update server serves.

import { createHash, createPublicKey, type KeyObject } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../shared/fs.ts";
import { createSignedManifest, readSignedManifest, type Release } from "../shared/manifest.ts";
import { compareVersions, parseVersion } from "../shared/semver.ts";
import { decodePrivateKey, generateSigningKeyPair } from "../shared/signing.ts";

export const PRIVATE_KEY_FILE = "signing.key";
export const PUBLIC_KEY_FILE = "signing.pub";
export const MANIFEST_FILE = "manifest.json";

export interface KeygenResult {
  readonly privateKeyPath: string;
  readonly publicKeyPath: string;
  readonly publicKey: string;
}

/** Writes a new key pair into `outDir`. Never overwrites an existing key. */
export async function keygen(outDir: string): Promise<KeygenResult> {
  const pair = generateSigningKeyPair();
  const privateKeyPath = path.join(outDir, PRIVATE_KEY_FILE);
  const publicKeyPath = path.join(outDir, PUBLIC_KEY_FILE);

  await mkdir(outDir, { recursive: true });
  // `wx` fails if the file exists: silently replacing a signing key would
  // orphan every installed client, which only trusts the old one.
  await writeFile(privateKeyPath, `${pair.privateKey}\n`, { flag: "wx", mode: 0o600 });
  await writeFile(publicKeyPath, `${pair.publicKey}\n`, { flag: "wx" });
  return { privateKeyPath, publicKeyPath, publicKey: pair.publicKey };
}

export interface PublishOptions {
  /** The built app bundle to release. */
  readonly artifactPath: string;
  readonly version: string;
  /** Base64 PKCS#8 Ed25519 private key. */
  readonly privateKey: string;
  /** The release directory served by the update server. */
  readonly root: string;
  readonly channel?: string;
  readonly minLauncherVersion?: string;
  /** How long the signed manifest stays valid (DESIGN.md#manifest). */
  readonly validDays?: number;
  readonly now?: Date;
}

/**
 * Copies the artifact into `<root>/artifacts/<version>/app.js` and replaces
 * `<root>/manifest.json` with a newly signed manifest pointing at it.
 *
 * The manifest is written last and atomically, so clients see either the
 * previous release or the complete new one, never a manifest pointing at a
 * missing artifact. Re-running after a crash is safe.
 */
export async function publish(options: PublishOptions): Promise<Release> {
  const {
    artifactPath,
    version,
    root,
    channel = "stable",
    minLauncherVersion = "1.0.0",
    validDays = 30,
    now = new Date(),
  } = options;
  parseVersion(version);
  parseVersion(minLauncherVersion);
  const expiresAt = expiryFrom(now, validDays);

  const privateKey = decodePrivateKey(options.privateKey);
  const previous = await readCurrentRelease(root, createPublicKey(privateKey));
  if (previous && compareVersions(version, previous.version) <= 0) {
    // Clients only accept strictly newer versions (ADR-0004), so publishing
    // this would be ignored at best. Catch the mistake here instead.
    throw new Error(`version ${version} is not newer than the published ${previous.version}`);
  }

  const artifact = await readFile(artifactPath);
  const sha256 = createHash("sha256").update(artifact).digest("hex");
  const relativeUrl = `artifacts/${version}/app.js`;
  await storeArtifact(path.join(root, relativeUrl), artifact, sha256);

  const release: Release = {
    version,
    channel,
    publishedAt: toUtcTimestamp(now),
    expiresAt,
    minLauncherVersion,
    artifact: { url: relativeUrl, size: artifact.length, sha256 },
  };
  await writeManifest(root, release, privateKey);
  return release;
}

export interface RefreshOptions {
  readonly root: string;
  /** Base64 PKCS#8 Ed25519 private key. */
  readonly privateKey: string;
  readonly validDays?: number;
  readonly now?: Date;
}

/**
 * Re-signs the current release with a new expiry date, changing nothing else.
 *
 * Manifests expire so a stale one can't be replayed forever (ADR-0004). The
 * flip side is that if no release goes out before expiry, clients stop
 * accepting updates. Run this on a schedule (e.g. weekly, with the default
 * 30-day validity) to keep the current manifest fresh between releases.
 */
export async function refresh({ root, privateKey: encodedKey, validDays = 30, now = new Date() }: RefreshOptions): Promise<Release> {
  const expiresAt = expiryFrom(now, validDays);
  const privateKey = decodePrivateKey(encodedKey);
  const current = await readCurrentRelease(root, createPublicKey(privateKey));
  if (!current) {
    throw new Error(`no ${MANIFEST_FILE} in ${root}; publish a release first`);
  }
  // Refuse to extend the life of a manifest whose artifact has gone missing
  // or changed: every client would download it and fail verification.
  const artifact = await readFile(path.join(root, current.artifact.url)).catch(() => null);
  if (!artifact || createHash("sha256").update(artifact).digest("hex") !== current.artifact.sha256) {
    throw new Error(`artifact for ${current.version} is missing or doesn't match the manifest`);
  }

  const refreshed: Release = { ...current, expiresAt };
  await writeManifest(root, refreshed, privateKey);
  return refreshed;
}

async function writeManifest(root: string, release: Release, privateKey: KeyObject): Promise<void> {
  const manifest = createSignedManifest(release, privateKey);
  await writeFileAtomic(path.join(root, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
}

function expiryFrom(now: Date, validDays: number): string {
  if (!Number.isFinite(validDays) || validDays <= 0) {
    throw new Error(`validDays must be positive, got ${validDays}`);
  }
  return toUtcTimestamp(new Date(now.getTime() + validDays * 24 * 60 * 60 * 1000));
}

/** The release currently in `<root>/manifest.json`, or null if none yet. */
async function readCurrentRelease(root: string, publicKey: KeyObject): Promise<Release | null> {
  let text: string;
  try {
    text = await readFile(path.join(root, MANIFEST_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  try {
    return readSignedManifest(JSON.parse(text), publicKey);
  } catch (error) {
    // Most likely the wrong key file. Publishing anyway would ship a manifest
    // that every installed client rejects.
    throw new Error(`existing ${MANIFEST_FILE} can't be verified with this signing key: ${(error as Error).message}`);
  }
}

// Artifacts are immutable once published: clients and CDNs cache them forever.
// An identical file may already be there if an earlier publish crashed before
// writing the manifest; anything else is an error.
async function storeArtifact(destination: string, content: Buffer, sha256: string): Promise<void> {
  const existing = await readFile(destination).catch(() => null);
  if (existing) {
    if (createHash("sha256").update(existing).digest("hex") !== sha256) {
      throw new Error(`${destination} already exists with different content; artifacts are immutable`);
    }
    return;
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFileAtomic(destination, content);
}

function toUtcTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
