// The release manifest: its shape, how it's signed and verified, and the rules
// a client applies before acting on it. See DESIGN.md#manifest and ADR-0004.

import type { KeyObject } from "node:crypto";
import { compareVersions, isValidVersion } from "./semver.ts";
import { signBytes, verifyBytes } from "./signing.ts";

export interface Artifact {
  /** Location of app.js, resolved relative to the manifest's own URL. */
  readonly url: string;
  /** Exact size in bytes. Downloads are aborted as soon as they exceed it. */
  readonly size: number;
  /** Lowercase hex SHA-256 of the artifact. */
  readonly sha256: string;
}

export interface Release {
  readonly version: string;
  readonly channel: string;
  /** ISO 8601 UTC timestamps, e.g. "2026-11-18T12:00:00Z". */
  readonly publishedAt: string;
  readonly expiresAt: string;
  /** Oldest launcher able to run this release (ADR-0002). */
  readonly minLauncherVersion: string;
  readonly artifact: Artifact;
}

/**
 * What's actually served as manifest.json. `signed` holds the release as a JSON
 * string, and the signature covers its exact UTF-8 bytes. Clients verify first
 * and parse second, so no canonical JSON encoding is needed.
 */
export interface SignedManifest {
  readonly signed: string;
  readonly signature: string;
}

export class ManifestError extends Error {
  override name = "ManifestError";
}

export function createSignedManifest(release: Release, privateKey: KeyObject): SignedManifest {
  // Validate on the way out too, so the release tool can never publish a
  // manifest that clients would reject as malformed.
  const signed = JSON.stringify(validateRelease(release));
  return { signed, signature: signBytes(Buffer.from(signed, "utf8"), privateKey) };
}

/**
 * Verifies a manifest's signature and returns the release it describes.
 * Throws ManifestError if the manifest is malformed or the signature is invalid.
 *
 * A valid signature only proves who published the release. Whether this client
 * should install it is decided separately by `evaluateRelease`.
 */
export function readSignedManifest(document: unknown, publicKey: KeyObject): Release {
  if (!isRecord(document) || typeof document.signed !== "string" || typeof document.signature !== "string") {
    throw new ManifestError("manifest must be an object with string fields 'signed' and 'signature'");
  }
  if (!verifyBytes(Buffer.from(document.signed, "utf8"), document.signature, publicKey)) {
    throw new ManifestError("manifest signature is invalid");
  }

  let release: unknown;
  try {
    release = JSON.parse(document.signed);
  } catch {
    // Correctly signed but not JSON: a bug in the release tool, not an attack.
    throw new ManifestError("signed manifest content is not valid JSON");
  }
  return validateRelease(release);
}

export interface InstallContext {
  readonly installedVersion: string;
  readonly launcherVersion: string;
  readonly channel: string;
  /** Versions this client has rolled back from (ADR-0006). */
  readonly badVersions: ReadonlySet<string>;
  readonly now: Date;
}

export type RejectionReason = "expired" | "wrong-channel" | "not-newer" | "known-bad" | "launcher-too-old";

export type Decision =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: RejectionReason; readonly detail: string };

/** Decides whether a verified release should be installed on this client. */
export function evaluateRelease(release: Release, context: InstallContext): Decision {
  // Freshness: stops an attacker freezing clients on an old release by
  // replaying a stale (but validly signed) manifest forever.
  if (Date.parse(release.expiresAt) <= context.now.getTime()) {
    return reject("expired", `manifest expired at ${release.expiresAt}`);
  }
  if (release.channel !== context.channel) {
    return reject("wrong-channel", `release is for channel "${release.channel}", client is on "${context.channel}"`);
  }
  // Anti-rollback: only strictly newer versions, so an old signed manifest
  // can't be used to push clients back onto a vulnerable version.
  if (compareVersions(release.version, context.installedVersion) <= 0) {
    return reject("not-newer", `release ${release.version} is not newer than installed ${context.installedVersion}`);
  }
  if (context.badVersions.has(release.version)) {
    return reject("known-bad", `release ${release.version} previously failed its health check here`);
  }
  if (compareVersions(context.launcherVersion, release.minLauncherVersion) < 0) {
    return reject(
      "launcher-too-old",
      `release ${release.version} needs launcher ${release.minLauncherVersion}, this is ${context.launcherVersion}; manual update required`,
    );
  }
  return { accepted: true };
}

function reject(reason: RejectionReason, detail: string): Decision {
  return { accepted: false, reason, detail };
}

// --- Validation -------------------------------------------------------------
//
// Hand-written rather than schema-library based, to keep zero runtime
// dependencies (ADR-0001). Unknown fields are ignored, so a future manifest can
// add fields (e.g. a rollout percentage) without breaking older clients.

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export function validateRelease(value: unknown): Release {
  if (!isRecord(value)) {
    throw new ManifestError("release must be an object");
  }
  const artifact = value.artifact;
  if (!isRecord(artifact)) {
    throw new ManifestError("release.artifact must be an object");
  }

  const release: Release = {
    version: requireVersion(value, "version"),
    channel: requireNonEmptyString(value, "channel"),
    publishedAt: requireTimestamp(value, "publishedAt"),
    expiresAt: requireTimestamp(value, "expiresAt"),
    minLauncherVersion: requireVersion(value, "minLauncherVersion"),
    artifact: {
      url: requireNonEmptyString(artifact, "url", "artifact.url"),
      size: requireSize(artifact),
      sha256: requireSha256(artifact),
    },
  };

  if (Date.parse(release.expiresAt) <= Date.parse(release.publishedAt)) {
    throw new ManifestError("release.expiresAt must be after release.publishedAt");
  }
  return release;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(record: Record<string, unknown>, key: string, label = key): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ManifestError(`release.${label} must be a non-empty string`);
  }
  return value;
}

function requireVersion(record: Record<string, unknown>, key: string): string {
  const value = requireNonEmptyString(record, key);
  if (!isValidVersion(value)) {
    throw new ManifestError(`release.${key} must be a MAJOR.MINOR.PATCH version, got "${value}"`);
  }
  return value;
}

function requireTimestamp(record: Record<string, unknown>, key: string): string {
  const value = requireNonEmptyString(record, key);
  if (!UTC_TIMESTAMP_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ManifestError(`release.${key} must be an ISO 8601 UTC timestamp, got "${value}"`);
  }
  return value;
}

function requireSize(artifact: Record<string, unknown>): number {
  const value = artifact.size;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ManifestError("release.artifact.size must be a positive integer");
  }
  return value;
}

function requireSha256(artifact: Record<string, unknown>): string {
  const value = requireNonEmptyString(artifact, "sha256", "artifact.sha256");
  if (!SHA256_PATTERN.test(value)) {
    throw new ManifestError("release.artifact.sha256 must be 64 lowercase hex characters");
  }
  return value;
}
