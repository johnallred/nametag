# Releases are trusted via an Ed25519-signed manifest, not via HTTPS

A self-updater is, by design, a channel for running remote code on every client. Whoever
controls what it downloads controls the fleet. TLS protects the network hop, but it
doesn't protect against a compromised server or CDN.

So `release publish` signs the manifest with an Ed25519 private key that never leaves
the developer's machine. The manifest names the artifact's size and SHA-256. The
corresponding public key is compiled into the app. A client runs nothing unless the
signature verifies and the downloaded artifact's hash matches the signed hash.

The signature covers the exact bytes of the manifest. The `signed` field is a JSON string
that is verified first and parsed second, so there's no canonical-JSON problem.

The signed content also defends against attacks that a valid signature alone can't stop:

- **Anti-rollback**: a client accepts only a strictly newer version, so an attacker can't
  replay an old, validly signed manifest to downgrade clients onto a version with a known
  vulnerability.
- **Freshness**: a signed `expiresAt` date stops an attacker from freezing clients on an
  old release by serving a stale manifest indefinitely.

## Considered options

- **HTTPS only**: this trusts every server and CDN on the path, and anyone holding the
  server's TLS key.
- **Sign each artifact separately, without a manifest**: this proves an artifact is
  genuine but not that it's *current*, so it can't express anti-rollback or freshness.
- **TUF (The Update Framework)**: the thorough answer, with role separation and key
  rotation, but far heavier than this exercise warrants. The design is TUF-shaped enough
  to grow toward it.
- **RSA or ECDSA**: both work. Ed25519 has small keys, deterministic signatures, no
  parameter choices to get wrong, and is built into Node's `crypto`.

## Consequences

- Plain HTTP is allowed for `localhost`, so tests and the demo need no certificates. The
  signature is the trust anchor either way.
- A leaked private key compromises the fleet. There's no key rotation yet. That's
  documented as a known limitation, along with the route to rotation: ship the next
  public key in a signed release.
