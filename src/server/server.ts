// The update server: a minimal static file server for a release directory laid
// out by `release publish`:
//
//   <root>/manifest.json
//   <root>/artifacts/<version>/app.cjs
//
// It holds no state and has no API, so in production it can be swapped for a
// bucket behind a CDN (ADR-0003). TLS is expected to be terminated in front of it.

import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Logger } from "../shared/log.ts";

export interface UpdateServerOptions {
  /** The release directory to serve. */
  readonly root: string;
  readonly log: Logger;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
};

export function createUpdateServer(options: UpdateServerOptions): Server {
  return createServer((request, response) => {
    handle(request, response, options).catch((error: unknown) => {
      options.log.error("request failed", { url: request.url, error });
      if (!response.headersSent) {
        respond(response, 500);
      } else {
        // Mid-stream failure: cut the connection so the client sees a
        // truncated download, never a "complete" short one.
        response.destroy();
      }
    });
  });
}

async function handle(request: IncomingMessage, response: ServerResponse, { root, log }: UpdateServerOptions): Promise<void> {
  const started = performance.now();
  response.on("finish", () => {
    log.info("request", {
      method: request.method,
      url: request.url,
      status: response.statusCode,
      ms: Math.round(performance.now() - started),
    });
  });

  if (request.method !== "GET" && request.method !== "HEAD") {
    respond(response, 405, { Allow: "GET, HEAD" });
    return;
  }

  const filePath = await resolveInsideRoot(root, request.url ?? "/");
  const info = filePath === null ? null : await stat(filePath).catch(() => null);
  if (filePath === null || info === null || !info.isFile()) {
    respond(response, 404);
    return;
  }

  response.writeHead(200, {
    "Content-Type": CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream",
    "Content-Length": info.size,
    "Cache-Control": cacheControlFor(filePath),
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  await pipeline(createReadStream(filePath), response);
}

// The manifest changes with every release, so caches must revalidate it.
// Artifacts never change once published (a new release gets a new version
// path), so they can be cached forever, which is what makes a CDN effective.
function cacheControlFor(filePath: string): string {
  return path.basename(filePath) === "manifest.json" ? "no-cache" : "public, max-age=31536000, immutable";
}

/**
 * Maps a request URL to a real file path inside `root`, or returns null.
 *
 * Containment is checked on fully resolved real paths (after percent-decoding
 * and following symlinks), so neither `..` segments in any encoding nor a
 * symlink pointing outside the root can escape it.
 */
export async function resolveInsideRoot(root: string, requestUrl: string): Promise<string | null> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, "http://localhost").pathname);
  } catch {
    return null; // Malformed percent-encoding.
  }
  if (pathname.includes("\0")) {
    return null;
  }

  const realRoot = await realpath(root);
  const realCandidate = await realpath(path.join(realRoot, pathname)).catch(() => null);
  if (realCandidate === null) {
    return null;
  }
  const relative = path.relative(realRoot, realCandidate);
  const escapes = relative === "" || relative.split(path.sep)[0] === ".." || path.isAbsolute(relative);
  return escapes ? null : realCandidate;
}

function respond(response: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...headers });
  response.end(`${status}\n`);
}
