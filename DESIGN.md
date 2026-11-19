# nametag: design

nametag is a small, long-running desktop program that keeps itself up to date. When a new
version is published, every running copy downloads it, verifies it, and swaps itself
over to it with no user involvement. If the new version fails to start, the copy rolls
back by itself. It runs on Windows, macOS and Linux.

The program's own job is deliberately trivial: it logs its version and a tick counter
every few seconds. The engineering effort is in the update path.

## Clarifying questions

The brief invites questions but warns that answers may be elusive. These are the
questions I would have asked, the answer I guessed, and what each guess led to.

| # | Question | Guessed answer | Consequence |
|---|----------|----------------|-------------|
| 1 | What does the program actually do? | It doesn't matter. Treat it as a stand-in for a real app. | A trivial long-running ticker. Long-running is the hard case for "seamless", so it's the one worth demonstrating. |
| 2 | Can we assume clients have Node (or any runtime) installed? | No. These are ordinary end-user machines. | The runtime ships with the program, embedded in a Node SEA launcher ([ADR-0001](docs/adr/0001-node-sea-typescript.md)). |
| 3 | Do users have admin rights? | Not reliably, and we must never prompt for elevation to update. | Per-user install into a user-writable data directory. |
| 4 | How quickly must a release reach clients? | Within hours is fine. Minutes isn't required. | Clients poll hourly with jitter instead of the server pushing ([ADR-0003](docs/adr/0003-poll-not-push.md)). |
| 5 | Can the program restart to update, and must we ask the user? | A restart of about a second is acceptable, with no prompt. | Graceful drain and restart. Zero-gap socket handoff is out of scope. |
| 6 | Must in-memory state survive an update? | Small application state, yes. Open connections, no. | The app persists its state on shutdown and resumes from it on start. |
| 7 | What's the threat model? | Assume the network or the download server could be compromised. | Ed25519-signed manifests, verified against a key compiled into the app ([ADR-0004](docs/adr/0004-signed-manifest.md)). |
| 8 | Should clients ever move to an older version? | Never because the server said so. Locally, yes, if a new version is broken. | Anti-downgrade rule on manifests. Automatic local rollback on failed health checks ([ADR-0006](docs/adr/0006-health-check-and-rollback.md)). |
| 9 | How many clients? | Potentially very many. | The server serves static files and could be replaced by a CDN. Poll jitter avoids a thundering herd. |
| 10 | Is OS code signing (Authenticode, Apple notarization) expected? | No certificates are available for an exercise. | Out of scope, listed under known limitations. |
| 11 | Must the updater itself be updatable? | The update *logic* must be. The bootstrap may be frozen. | The update logic lives in the versioned app, and the launcher stays minimal ([ADR-0005](docs/adr/0005-app-side-updater.md)). |
| 12 | Are release channels or staged rollouts required? | No. | One `stable` channel. The manifest format leaves room for both. |
| 13 | Must the program work offline? | Yes. A failed update check must never stop the program. | Update errors are logged and retried with backoff. The current version keeps running. |

## Architecture

```
            ┌──────────────── developer machine ───────────────┐
            │  release keygen   →  private key (never committed)│
            │  release publish  →  app.js + signed manifest     │
            └───────────────────────────┬───────────────────────┘
                                        │ copy to server
                                        ▼
            ┌──────────── update server (static files) ─────────┐
            │  GET /manifest.json                                │
            │  GET /artifacts/<version>/app.js                   │
            └───────────────────────────┬───────────────────────┘
                                        │ HTTPS poll
            ┌──────────────── client machine ───────▼───────────┐
            │  launcher (SEA exe, embeds Node)                   │
            │     │  spawns itself in app mode, IPC channel      │
            │     ▼                                              │
            │  app (versions/<current>/app.js)                   │
            │     ├─ ticker (the "real" program)                 │
            │     └─ updater: poll → verify → stage → notify     │
            └────────────────────────────────────────────────────┘
```

**Components**

- `src/shared/`: manifest types, signature verification, semver comparison. Used by the
  app and the release CLI.
- `src/launcher/`: the bootstrap. It takes the single-instance lock, starts the current
  version, swaps versions when the app asks it to, and rolls back on failure. It is kept
  small because it is the one piece that does not update itself.
- `src/app/`: the ticker and the updater.
- `src/server/`: a minimal static HTTP server for the manifest and artifacts.
- `src/release/`: `keygen` and `publish`.

**Process model**

The launcher executable runs in one of two modes. Started normally, it supervises the
app. Started with `--nametag-run-app <path>`, it loads and runs that app bundle. The
supervisor starts each app version as a child process in app mode, with an IPC channel
between them (`src/shared/ipc.ts`):

| Message | Direction | Meaning |
|---|---|---|
| `healthy` | app → launcher | Startup succeeded. Ends the health-check wait. |
| `staged` | app → launcher | A verified release is in `versions/<v>/`. |
| `shutdown` | launcher → app | Finish the current tick, save state, exit 0. On Windows this is the only graceful stop, since there is no SIGTERM. |

The launcher treats `staged` as a claim to check, not an order. The version must be
valid, newer than the current one, not on the bad list, and actually installed. If the
IPC channel closes because the launcher died, the app exits. Otherwise a restarted
launcher would start a second copy beside it.

The launcher has its own version (`src/launcher/version.ts`), bumped by hand, because a
launcher change has to be shipped to clients manually.

**Data directory** (per user, no admin rights needed)

| OS | Location |
|----|----------|
| Windows | `%LOCALAPPDATA%\nametag` |
| macOS | `~/Library/Application Support/nametag` |
| Linux | `$XDG_DATA_HOME/nametag` (default `~/.local/share/nametag`) |

```
nametag/
├── nametag[.exe]          launcher
├── current                text file containing the active version, e.g. "1.4.0"
├── versions/
│   ├── 1.3.0/app.js       previous version (the rollback target)
│   └── 1.4.0/app.js       current version
├── launcher-state.json    owned by the launcher: previous version, bad versions
├── app-state.json         owned by the app: tick counter, etc.
├── config.json            optional: manifest URL, poll interval
├── logs/                  rotating JSON-lines logs
└── nametag.lock           single-instance lock
```

Each file has exactly one writer. The launcher owns the pointer and its own state. The
app owns its state and the contents of `versions/`. Nothing is ever written by two
processes.

## Manifest

The signed bytes are carried as a string, so there's no JSON canonicalization problem.
The client verifies the signature over exactly the bytes it received, and only then
parses them.

```json
{
  "signed": "{\"version\":\"1.4.0\",\"channel\":\"stable\",\"publishedAt\":\"2026-11-18T12:00:00Z\",\"expiresAt\":\"2026-12-18T12:00:00Z\",\"minLauncherVersion\":\"1.0.0\",\"artifact\":{\"url\":\"artifacts/1.4.0/app.js\",\"size\":48211,\"sha256\":\"9f2c…\"}}",
  "signature": "<base64 Ed25519 signature over the UTF-8 bytes of `signed`>"
}
```

A client accepts a manifest only if **all** of these hold:

1. The signature verifies against the public key compiled into the running app.
2. `expiresAt` is in the future, so a stale manifest can't be frozen in place.
3. `channel` matches the client's channel.
4. `version` is strictly greater than the installed version, so an old signed manifest
   can't be replayed to force a downgrade.
5. `version` is not on the launcher's bad-versions list.
6. The running launcher's version is at least `minLauncherVersion`.

Expiry has an operational cost: if no release goes out before the manifest expires,
clients stop accepting it. `release refresh` re-signs the current release with a new
expiry date and changes nothing else. Run it on a schedule, for example weekly with the
default 30-day validity.

A release is a single, platform-independent `app.js` bundle. The runtime lives in the
launcher, so the same file works on every OS. There's no archive to unpack, which also
removes a whole class of path-traversal bugs.

## Update lifecycle

1. **Poll.** The app fetches `manifest.json` every hour (±10% jitter). On error, it backs
   off exponentially up to the normal interval. The app keeps running regardless.
2. **Verify.** The manifest is checked against the rules above. If nothing is acceptable,
   it waits for the next poll.
3. **Download.** It streams the artifact into `versions/<v>.partial/app.js`, hashing as
   it goes, with a request timeout. It aborts as soon as the download exceeds the
   declared `size`.
4. **Check.** The size and SHA-256 must match the signed manifest. If they don't, the
   `.partial` folder is deleted.
5. **Stage.** It renames `versions/<v>.partial/` to `versions/<v>/`.
6. **Notify.** The app sends the launcher `{ type: "staged", version }` over IPC.
7. **Swap.** The launcher writes the new version to a temp file
   (`current.<pid>.<random>.tmp`) and renames it over `current`. It records
   the old version as `previous` in `launcher-state.json`, then sends the app
   `{ type: "shutdown" }`.
8. **Drain.** The app finishes its current tick, saves `app-state.json`, and exits 0. If
   it hasn't exited after 5 s, the launcher kills it.
9. **Start.** The launcher spawns the new version, which loads `app-state.json` and carries
   on counting.
10. **Probation.** The new app must send `{ type: "healthy" }` within 10 s, and must not
    exit unexpectedly within 30 s of starting. If it fails either check, the launcher
    rolls back ([ADR-0006](docs/adr/0006-health-check-and-rollback.md)).

The process gap in steps 8–9 is typically about a second.

## Atomicity: what happens if we crash at each step

Every step either completes or leaves the previous state intact. On disk, the only
"commit" is the rename of `current`.

| Crash during… | State on disk afterwards | Recovery on next start |
|---|---|---|
| Download / hash check | A `versions/<v>.partial/` folder. `current` untouched. | `.partial` folders are deleted. The old version runs. |
| Rename `.partial` → `<v>` | Either the `.partial` folder or the complete `<v>` folder. `current` untouched. | The old version runs. The next poll re-stages (or finds `<v>` already staged). |
| Writing the `current` temp file | A stray `*.tmp` file. `current` untouched. | The temp file is deleted. The old version runs. |
| Rename temp file → `current` | `rename` is atomic: `current` names either the old version or the new one. | Whichever it names runs. If it's the new one, normal probation applies. |
| Probation of the new version | `current` names the new version, and `previous` is recorded. | The launcher runs the new version under probation again. A failure rolls back. |

`rename` within one directory is atomic on POSIX filesystems. On Windows, Node's
`fs.rename` uses `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`. Windows doesn't formally
guarantee that this is atomic, but on a local NTFS volume it behaves atomically in
practice. It can fail with `EPERM` while another process, typically antivirus, has the
file open, so renames are retried briefly before giving up. All temp files live inside the data directory, so
every rename stays on one filesystem.

**Cleanup** runs when the launcher starts. It keeps `current` and `previous`, and deletes
other version folders, `.partial` folders and temp files.

## Security model

| Threat | Mitigation |
|---|---|
| Tampered artifact (network or server) | The SHA-256 of the artifact is part of the signed manifest. |
| Tampered manifest | An Ed25519 signature over the exact manifest bytes. The public key is compiled into the app. |
| Replay of an old signed manifest to force a downgrade | Strictly-newer version rule. |
| Freeze attack (serving a stale manifest forever) | The signed `expiresAt` date. |
| Disk-filling or slow-loris download | The declared size is enforced while streaming, plus a request timeout. |
| Plain-HTTP interception | The client requires `https://`, except for `localhost` (development and tests). The signature is the real trust anchor either way. |
| Two instances racing over the data directory | An exclusive lock file. A second launcher exits. |
| Leaked signing key | **Not mitigated.** Key rotation is a known limitation (see below). |

The private key is generated by `release keygen`, read from a file path or an environment
variable, and never committed. Tests generate throwaway keys.

## Configuration

| Setting | Default | Override |
|---|---|---|
| Manifest URL | built in at release time | `config.json` → `manifestUrl`, env `NAMETAG_MANIFEST_URL` |
| Poll interval | 1 hour | `config.json` → `pollIntervalSeconds`, env `NAMETAG_POLL_INTERVAL_SECONDS` |
| First update check | 10 seconds after start | `config.json` → `firstCheckDelaySeconds`, env `NAMETAG_FIRST_CHECK_DELAY_SECONDS` |
| Tick interval | 5 seconds | `config.json` → `tickIntervalMs`, env `NAMETAG_TICK_INTERVAL_MS` |
| Launcher health timeout / probation / shutdown deadline | 10 s / 30 s / 5 s | env `NAMETAG_HEALTH_TIMEOUT_MS`, `NAMETAG_PROBATION_MS`, `NAMETAG_SHUTDOWN_TIMEOUT_MS` (tests and demos; the launcher has no config file, to keep it minimal) |
| Data directory | per-OS location above | env `NAMETAG_DATA_DIR` (used by tests) |

Environment variables take precedence over `config.json`, which takes precedence over
built-in values. An invalid value is logged and skipped, never fatal. The signing public
key is deliberately not configurable: it's the trust anchor, so it comes only from the
signed bundle.

The launcher also tells the app its own version (`NAMETAG_LAUNCHER_VERSION`) and the
versions it has rolled back from (`NAMETAG_BAD_VERSIONS`). The app only enables its
updater when it was started by the launcher, because without a launcher nobody can
switch versions.

## Logging

The launcher and the app both write JSON lines to stdout and to `logs/`, rotated by size.
Every line includes the timestamp, level, component (`launcher`/`app`), version and PID,
so a failed update on a client machine can be reconstructed from its logs alone.

## Testing

- **Unit tests** (`node:test`): signature verification, every manifest acceptance rule,
  semver comparison, staging and cleanup.
- **End-to-end test**: start the real server, publish v1, run the launcher, publish v2,
  and assert that the running process reports v2. Variants cover a release with a bad
  signature (it must be ignored) and a release that crashes on start (it must be rolled
  back and marked bad).
- **CI**: GitHub Actions runs the tests and builds the SEA launcher on Windows, macOS and
  Linux.

## Known limitations and future work

| Limitation | Why it's acceptable for now | How it would be addressed |
|---|---|---|
| The launcher doesn't update itself | It's small and changes rarely. `minLauncherVersion` stops the app from staging releases the launcher can't run, and logs that a manual update is needed. | Stage a new launcher beside the old one. On Windows, rename the running exe aside (allowed while it's running) and move the new one into place. On POSIX, `rename` over it. Then re-exec. |
| Upgrading the Node runtime requires a launcher update | It follows from the item above. | Same as above. |
| No OS code signing or notarization | No certificates for an exercise. | Authenticode for the Windows launcher. Developer ID signing and notarization on macOS. |
| No key rotation | One key keeps the trust model simple to reason about. | Ship the next public key in a signed release before retiring the current one, or move to a root-key/online-key scheme like TUF. |
| No zero-gap handoff | Question 5: a gap of about a second is acceptable. | Hand listening sockets to the new process. This differs per OS. |
| No staged rollout | Not required (question 12). | Add a rollout percentage to the manifest. Clients compare it against a stable hash of an install ID. |
| No MSI, pkg or deb installers | Unpacking an archive into the data directory is enough to demonstrate the update path. | Native installers that do the same per-user install. |
| The single-instance lock is a PID file | Node has no portable OS file lock. A stale lock from a crashed launcher is detected by checking whether its PID is alive. | If the OS reuses a dead launcher's PID, the lock looks held until that process exits. Two launchers starting at the same instant over a stale lock could both clear it. A named pipe or Unix socket lock, which the OS releases on exit, would close both gaps. |
| Single-file releases only | The app is one bundle. | A release becomes a file list, each file with its own hash, staged the same way. |

## Decision records

1. [Node, SEA and TypeScript](docs/adr/0001-node-sea-typescript.md)
2. [Launcher plus versioned folders](docs/adr/0002-launcher-and-versioned-folders.md)
3. [Clients poll; the server doesn't push](docs/adr/0003-poll-not-push.md)
4. [Ed25519-signed manifest](docs/adr/0004-signed-manifest.md)
5. [Update logic lives in the app, not the launcher](docs/adr/0005-app-side-updater.md)
6. [Health check and automatic rollback](docs/adr/0006-health-check-and-rollback.md)
