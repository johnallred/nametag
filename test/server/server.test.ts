import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createLogger } from "../../src/shared/log.ts";
import { createUpdateServer } from "../../src/server/server.ts";
import { makeTempDir } from "../helpers.ts";

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

// Raw requests, not fetch(): fetch normalizes "/../" away before sending,
// which would hide exactly the traversal attempts we want to test.
function send(server: Server, method: string, rawPath: string): Promise<RawResponse> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path: rawPath }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("update server", () => {
  let server: Server;
  let root: string;

  before(async () => {
    const base = await makeTempDir();
    root = path.join(base, "releases");
    await mkdir(path.join(root, "artifacts", "1.0.0"), { recursive: true });
    await writeFile(path.join(root, "manifest.json"), '{"signed":"{}","signature":"x"}');
    await writeFile(path.join(root, "artifacts", "1.0.0", "app.js"), "console.log('v1');");
    // Something an attacker would love to read, just outside the root.
    await writeFile(path.join(base, "secret.txt"), "private key material");

    server = createUpdateServer({ root, log: createLogger({ component: "server", sinks: [] }) });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("serves the manifest with revalidation required", async () => {
    const res = await send(server, "GET", "/manifest.json");
    assert.equal(res.status, 200);
    assert.equal(res.body, '{"signed":"{}","signature":"x"}');
    assert.equal(res.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(res.headers["cache-control"], "no-cache");
  });

  it("serves artifacts as immutable", async () => {
    const res = await send(server, "GET", "/artifacts/1.0.0/app.js");
    assert.equal(res.status, 200);
    assert.equal(res.body, "console.log('v1');");
    assert.equal(res.headers["content-length"], String("console.log('v1');".length));
    assert.match(String(res.headers["cache-control"]), /immutable/);
  });

  it("answers HEAD with headers and no body", async () => {
    const res = await send(server, "HEAD", "/artifacts/1.0.0/app.js");
    assert.equal(res.status, 200);
    assert.equal(res.body, "");
    assert.equal(res.headers["content-length"], String("console.log('v1');".length));
  });

  it("returns 404 for missing files and directories", async () => {
    assert.equal((await send(server, "GET", "/artifacts/9.9.9/app.js")).status, 404);
    assert.equal((await send(server, "GET", "/artifacts")).status, 404);
    assert.equal((await send(server, "GET", "/")).status, 404);
  });

  it("rejects other methods with 405", async () => {
    const res = await send(server, "POST", "/manifest.json");
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, "GET, HEAD");
  });

  for (const attempt of [
    "/../secret.txt",
    "/%2e%2e/secret.txt",
    "/artifacts/..%2f..%2fsecret.txt",
    "/%2e%2e%5csecret.txt",
    "/manifest.json%00.js",
    "/%E0%A4%A",
  ]) {
    it(`refuses to escape the root: ${attempt}`, async () => {
      const res = await send(server, "GET", attempt);
      assert.equal(res.status, 404);
      assert.doesNotMatch(res.body, /private key material/);
    });
  }

  it("refuses a symlink that points outside the root", { skip: process.platform === "win32" && "symlinks need privileges" }, async () => {
    await symlink(path.join(root, "..", "secret.txt"), path.join(root, "leak.txt"));
    const res = await send(server, "GET", "/leak.txt");
    assert.equal(res.status, 404);
  });
});
