// Entry point: node src/server/main.ts --root ./releases [--port 8080] [--host 127.0.0.1]

import { statSync } from "node:fs";
import { parseArgs } from "node:util";
import { createLogger } from "../shared/log.ts";
import { createUpdateServer } from "./server.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string", default: "releases" },
    port: { type: "string", default: "8080" },
    // Loopback by default: exposing the server is a deliberate act, normally
    // behind a TLS-terminating proxy.
    host: { type: "string", default: "127.0.0.1" },
  },
});

const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`invalid --port "${values.port}"`);
  process.exit(2);
}

// Fail fast on a mistyped --root, rather than starting up and answering
// every request with a 500.
if (!statSync(values.root, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`release directory "${values.root}" does not exist`);
  process.exit(2);
}

const log = createLogger({ component: "server" });
const server = createUpdateServer({ root: values.root, log });

server.listen(port, values.host, () => {
  log.info("listening", { root: values.root, address: server.address() });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log.info("shutting down", { signal });
    server.close(() => process.exit(0));
    // Don't let a slow download hold shutdown hostage.
    server.closeAllConnections();
  });
}
