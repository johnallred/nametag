# nametag

A desktop program that keeps itself up to date. When a new version is published, every
running copy downloads it, verifies its signature, and switches over to it with no user
involvement. If the new version fails to start, the copy rolls back on its own. It runs
on Windows, macOS and Linux, and clients need nothing installed.

The program's own job is deliberately trivial: it logs a counter every few seconds. All
the engineering is in the update path.

- **[DESIGN.md](DESIGN.md)**: the clarifying questions I'd have asked, with the answers
  I assumed, plus the architecture, update lifecycle, crash-safety analysis, security
  model and known limitations.
- **[docs/adr/](docs/adr/)**: six decision records for the choices most worth
  challenging.

## How it works

```
release CLI ──signs──▶ manifest.json + app.cjs ──served by──▶ update server
                                                                  │ HTTPS poll
launcher (single executable, embeds Node) ◀──IPC──▶ app (versions/<v>/app.cjs)
  supervises, switches, rolls back                    ticks, polls, verifies, stages
```

- **Signed releases.** The release CLI signs the manifest with Ed25519. The manifest
  names the artifact's size and SHA-256. Clients verify both against a public key built
  into the app, so a compromised server can't push code.
- **A launcher that never replaces a running file.** Each version lives in its own
  folder. An update is a new folder plus an atomic rename of a one-line `current`
  pointer. The launcher is a Node Single Executable Application, so the runtime ships
  with it.
- **Update logic in the app, not the launcher.** The app does the polling, verifying and
  staging, so bugs in that logic can be fixed by shipping an update. The launcher only
  starts versions, switches them, and rolls back.
- **Probation and rollback.** A new version must report healthy within 10 s and stay up
  for 30 s. Otherwise the launcher switches back and never tries that version again.

## Try it

Needs Node 22.18 or later. The commands below use a POSIX shell. On Windows PowerShell,
set environment variables with `$env:NAME="value"`. The launcher is
`dist\launcher\nametag.exe`, and the installed client is `demo\client\nametag.exe`.

```sh
npm install

# 1. Create a signing key (keys/ is gitignored).
npm run release -- keygen

# 2. Build two app versions that trust that key and poll a local server,
#    and the launcher executable for this OS.
npm run build -- app --version 1.0.0 --out dist/app-1.0.0.cjs \
  --public-key keys/signing.pub --manifest-url http://127.0.0.1:8080/manifest.json
npm run build -- app --version 1.1.0 --out dist/app-1.1.0.cjs \
  --public-key keys/signing.pub --manifest-url http://127.0.0.1:8080/manifest.json
npm run build -- launcher

# 3. Publish 1.0.0, and install it as a client would have it.
npm run release -- publish --artifact dist/app-1.0.0.cjs --version 1.0.0 --key keys/signing.key
npm run build -- install --launcher dist/launcher/nametag \
  --app dist/app-1.0.0.cjs --version 1.0.0 --out-dir demo/client

# 4. In a second terminal: serve releases/ on port 8080.
npm run server

# 5. In a third terminal: run the client. Checks every 2 s instead of hourly.
NAMETAG_DATA_DIR=demo/client NAMETAG_FIRST_CHECK_DELAY_SECONDS=0 \
  NAMETAG_POLL_INTERVAL_SECONDS=2 demo/client/nametag

# 6. Back in the first terminal: publish 1.1.0 and watch the client switch.
npm run release -- publish --artifact dist/app-1.1.0.cjs --version 1.1.0 --key keys/signing.key
```

In the client's log you'll see 1.0.0 download and stage 1.1.0, then shut down
gracefully. 1.1.0 starts and carries on counting from the same tick. About 30 seconds
later, the launcher logs `new version confirmed`.

Some things to try next:

- **A broken release.** Publish a file containing `throw new Error("broken")` as 1.2.0.
  The launcher rolls back to 1.1.0 and records 1.2.0 as bad.
- **A tampered release.** Edit a byte of `releases/manifest.json` or of an artifact. The
  client logs the failed verification and keeps running what it has.
- **A crash mid-update.** Kill the client at any point and restart it. It starts the
  last committed version and cleans up whatever was half-done.
- **Keeping the manifest fresh.** Manifests expire after 30 days, so a stale one can't
  be replayed. Run `npm run release -- refresh --key keys/signing.key` periodically
  between releases.

Every setting and its override is listed in
[DESIGN.md → Configuration](DESIGN.md#configuration).

## Tests

```sh
npm run typecheck
npm test            # unit, integration and end-to-end tests (~10 s)
npm run test:sea    # builds the single executable and updates through it
```

The end-to-end tests ([test/e2e/](test/e2e/update.test.ts)) run the real launcher over
real bundles against a real update server. They check that a new release is switched
to with its state carried across, that a release signed with another key is ignored,
and that a release that crashes on start is rolled back.
[CI](.github/workflows/ci.yml) runs everything, including the single-executable test,
on Windows, macOS and Linux.

## Layout

```
src/shared/     manifest format and rules, signing, semver, atomic writes, logging
src/app/        the program: ticker, persisted state, updater, config
src/launcher/   lock, cleanup, supervisor (switching, probation, rollback)
src/server/     static update server
src/release/    keygen, publish, refresh
src/build/      app bundle, launcher executable, install layout
test/           mirrors src/, plus e2e/ and smoke/
```

There are no runtime dependencies. Everything that runs on a client uses Node's standard
library only. The development dependencies are TypeScript, esbuild and `postject`
(which builds the executable).
