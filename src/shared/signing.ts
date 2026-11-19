// Ed25519 signing and verification (ADR-0004).
//
// Keys travel as base64 strings so they can be put in an environment variable,
// a file, or compiled into the app bundle as a string constant:
//   public key:  DER-encoded SubjectPublicKeyInfo (SPKI), base64
//   private key: DER-encoded PKCS#8, base64

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

export interface EncodedKeyPair {
  readonly publicKey: string;
  readonly privateKey: string;
}

export function generateSigningKeyPair(): EncodedKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}

export function decodePublicKey(base64: string): KeyObject {
  const key = createPublicKey({ key: Buffer.from(base64, "base64"), format: "der", type: "spki" });
  assertEd25519(key);
  return key;
}

export function decodePrivateKey(base64: string): KeyObject {
  const key = createPrivateKey({ key: Buffer.from(base64.trim(), "base64"), format: "der", type: "pkcs8" });
  assertEd25519(key);
  return key;
}

/** Signs `data` and returns the signature as base64. */
export function signBytes(data: Uint8Array, privateKey: KeyObject): string {
  // Ed25519 hashes internally, so the digest algorithm argument must be null.
  return sign(null, data, privateKey).toString("base64");
}

/** Returns true only if `signature` (base64) is a valid signature of `data`. */
export function verifyBytes(data: Uint8Array, signature: string, publicKey: KeyObject): boolean {
  const signatureBytes = Buffer.from(signature, "base64");
  // Buffer.from silently drops invalid base64 characters, so re-encode and
  // compare to make sure we're verifying the exact signature we were given.
  if (signatureBytes.toString("base64") !== signature) {
    return false;
  }
  return verify(null, data, publicKey, signatureBytes);
}

// A key of the wrong type would make verify() throw or, worse, use a different
// algorithm than the one ADR-0004 promises. Fail loudly at load time instead.
function assertEd25519(key: KeyObject): void {
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`expected an ed25519 key, got ${key.asymmetricKeyType ?? "unknown"}`);
  }
}
