// Bounded, verified HTTP reads. The server is untrusted (ADR-0004), so every
// read has a size cap and a timeout, and a downloaded artifact is checked
// against the size and hash from the signed manifest before anyone uses it.

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { assertAllowedUpdateUrl } from "../shared/url-policy.ts";

export type Fetch = typeof fetch;

export interface FetchOptions {
  readonly fetch: Fetch;
  readonly signal: AbortSignal;
}

/** GETs a URL and returns its body as text, refusing bodies over `maxBytes`. */
export async function fetchTextLimited(url: URL, maxBytes: number, options: FetchOptions): Promise<string> {
  const body = await get(url, options);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of Readable.fromWeb(body)) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) {
      throw new Error(`response from ${url.href} exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface ExpectedArtifact {
  readonly size: number;
  readonly sha256: string;
}

/**
 * Streams `url` into `destination` and verifies it. On any failure the
 * partial file is removed and the error rethrown, so `destination` exists
 * afterwards only if it holds exactly the expected bytes.
 */
export async function downloadVerified(url: URL, destination: string, expected: ExpectedArtifact, options: FetchOptions): Promise<void> {
  try {
    const body = await get(url, options);
    const hash = createHash("sha256");
    let received = 0;

    // Count and hash in flight, aborting the moment the server sends more
    // than the manifest promised, rather than filling the disk first.
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > expected.size) {
          callback(new Error(`artifact exceeds its declared size of ${expected.size} bytes`));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(body), meter, createWriteStream(destination, { flush: true }), { signal: options.signal });

    if (received !== expected.size) {
      throw new Error(`artifact is ${received} bytes, expected ${expected.size}`);
    }
    const actual = hash.digest("hex");
    if (actual !== expected.sha256) {
      throw new Error(`artifact sha256 ${actual} does not match the signed manifest (${expected.sha256})`);
    }
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  }
}

async function get(url: URL, { fetch, signal }: FetchOptions): Promise<ReadableStream<Uint8Array>> {
  assertAllowedUpdateUrl(url, "update URL");
  // Node's fetch has no cache of its own, but proxies and CDNs in between do;
  // ask them to revalidate so a new manifest is seen promptly.
  const response = await fetch(url, { signal, headers: { "Cache-Control": "no-cache" } });
  // fetch follows redirects; make sure we didn't end up somewhere the policy forbids.
  if (response.url) {
    assertAllowedUpdateUrl(new URL(response.url), "redirect target");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GET ${url.href} failed: HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error(`GET ${url.href} returned no body`);
  }
  return response.body as ReadableStream<Uint8Array>;
}
