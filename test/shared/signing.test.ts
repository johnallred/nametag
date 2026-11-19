import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import {
  decodePrivateKey,
  decodePublicKey,
  generateSigningKeyPair,
  signBytes,
  verifyBytes,
} from "../../src/shared/signing.ts";

const data = Buffer.from("hello, fleet");

describe("signing", () => {
  const pair = generateSigningKeyPair();
  const publicKey = decodePublicKey(pair.publicKey);
  const privateKey = decodePrivateKey(pair.privateKey);

  it("round-trips a signature through the encoded keys", () => {
    const signature = signBytes(data, privateKey);
    assert.equal(verifyBytes(data, signature, publicKey), true);
  });

  it("rejects a signature over different data", () => {
    const signature = signBytes(data, privateKey);
    assert.equal(verifyBytes(Buffer.from("hello, fleet!"), signature, publicKey), false);
  });

  it("rejects a signature from a different key", () => {
    const other = decodePrivateKey(generateSigningKeyPair().privateKey);
    assert.equal(verifyBytes(data, signBytes(data, other), publicKey), false);
  });

  it("rejects a signature with junk characters that base64 decoding would ignore", () => {
    const signature = signBytes(data, privateKey);
    assert.equal(verifyBytes(data, `${signature.slice(0, 10)}!${signature.slice(10)}`, publicKey), false);
  });

  it("tolerates surrounding whitespace in a private key read from a file", () => {
    assert.doesNotThrow(() => decodePrivateKey(`${pair.privateKey}\n`));
  });

  it("refuses keys that aren't ed25519", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPublic = rsa.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    assert.throws(() => decodePublicKey(rsaPublic), /expected an ed25519 key/);
  });
});
