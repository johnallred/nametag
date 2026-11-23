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

## Testing locally

The update server runs on your machine, so the whole loop (publish, download, verify,
switch, roll back) happens on one computer with no network or accounts.

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

## Testing remotely with GitHub

Here GitHub is the update server and your machine is just a client. Publishing a release
means pushing a tag. A workflow builds the app, signs the manifest, and attaches
`manifest.json` and `app-<version>.cjs` to a GitHub Release. The client polls
`https://github.com/<you>/nametag/releases/latest/download/manifest.json`, which always
points at the newest release. Nothing needs to change in the client: it already follows
redirects, requires HTTPS, and trusts only the signature.

```
git tag v1.1.0 ─push─▶ GitHub Action ─builds, signs─▶ Release (manifest.json + app-1.1.0.cjs)
                                                          ▲ HTTPS poll
                                       client on your machine (launcher + app)
```

**Requirements:** the repository must be **public**. GitHub serves
`releases/latest/download` anonymously only for public repositories, and the client sends
no credentials. You also need the [`gh` CLI](https://cli.github.com), signed in.

### One-time setup

1. **Use a signing key you're happy to publish with.** Either reuse `keys/signing.*` or
   create a fresh pair (`npm run release -- keygen --out keys-github`). Every client
   trusts only the public key it was built with, so changing keys later orphans installed
   clients.
2. **Give the workflows the keys.** The private key is a secret. The public key isn't, so
   it's a plain variable.

   ```sh
   gh secret set NAMETAG_SIGNING_KEY < keys/signing.key
   gh variable set NAMETAG_PUBLIC_KEY < keys/signing.pub
   ```

3. **Push the repository** to GitHub (`git push origin main`). CI runs the tests on all
   three operating systems.

### Run it

```sh
REPO=johnallred/nametag     # your GitHub owner/repo

# 1. Build the 1.0.0 client against GitHub, with the public key from step 2 above.
#    This uses its own folder, demo/github-client, so it doesn't collide with the
#    local demo's demo/client (`install` refuses to overwrite an existing install).
npm run build -- app --version 1.0.0 --out dist/app-1.0.0.cjs \
  --public-key keys/signing.pub \
  --manifest-url https://github.com/$REPO/releases/latest/download/manifest.json
npm run build -- launcher
npm run build -- install --launcher dist/launcher/nametag \
  --app dist/app-1.0.0.cjs --version 1.0.0 --out-dir demo/github-client

# 2. Publish 1.0.0 so the manifest exists. Wait for the Release workflow to go green.
git tag v1.0.0 && git push origin v1.0.0

# 3. Run the client. Polls every 30 s instead of hourly.
NAMETAG_DATA_DIR=demo/github-client NAMETAG_FIRST_CHECK_DELAY_SECONDS=0 \
  NAMETAG_POLL_INTERVAL_SECONDS=30 demo/github-client/nametag

# 4. In another terminal: ship a new version and watch the client switch.
git tag v1.1.0 && git push origin v1.1.0
```

On Windows, use the PowerShell forms from [Testing locally](#testing-locally). The version
comes from the tag (`v1.1.0` becomes `1.1.0`), so there's no file to edit before tagging.

About 30 to 90 seconds after the workflow finishes, the client logs that it downloaded
and staged 1.1.0, then switches to it. About 30 seconds after that it logs
`new version confirmed`. GitHub's CDN can briefly serve the previous manifest, so allow a
minute or two.

The broken-release test from [Testing locally](#testing-locally) works here too: tag a
commit whose app throws on start, and the client rolls back and never retries that
version. To withdraw a bad release, delete the GitHub Release and its tag.

### Keeping the manifest fresh

Manifests expire after 30 days. The
[refresh workflow](.github/workflows/refresh-manifest.yml) re-signs the latest release's
manifest every Monday, and you can run it by hand from the Actions tab. GitHub pauses
scheduled workflows in a public repository after 60 days without activity, so if clients
stop updating after a long quiet period, re-enable it there.

### Publishing without the workflow

The workflow runs exactly these commands, so you can do the same by hand:

```sh
npm run build -- app --version 1.1.0 --out dist/app-1.1.0.cjs \
  --public-key keys/signing.pub \
  --manifest-url https://github.com/$REPO/releases/latest/download/manifest.json
npm run release -- publish --artifact dist/app-1.1.0.cjs --version 1.1.0 \
  --key keys/signing.key --layout flat
gh release create v1.1.0 releases/manifest.json releases/app-1.1.0.cjs --latest
```

`--layout flat` puts `app-<version>.cjs` next to `manifest.json`, which is the shape of a
GitHub Release (a flat list of files). The default layout, `artifacts/<version>/app.cjs`,
is what the local server uses.

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
on Windows, macOS and Linux. The [release](.github/workflows/release.yml) and
[refresh](.github/workflows/refresh-manifest.yml) workflows handle GitHub publishing.

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
