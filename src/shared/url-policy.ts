// Which URLs the updater may fetch from (DESIGN.md#security-model).
//
// HTTPS everywhere, except plain HTTP to the local machine so tests and the demo
// need no certificates. The Ed25519 signature is the real trust anchor either
// way; HTTPS adds privacy and stops trivial tampering with what we *request*.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isAllowedUpdateUrl(url: URL): boolean {
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
}

export function assertAllowedUpdateUrl(url: URL, what: string): void {
  if (!isAllowedUpdateUrl(url)) {
    throw new Error(`${what} must use https (or http to localhost): ${url.href}`);
  }
}
