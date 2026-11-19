# Node, packaged as a Single Executable Application, written in TypeScript

The program must run on Windows, macOS and Linux machines that have no runtime installed.
I'll be extending the code live, so it should be in the language I'm most fluent in. We
use Node: the launcher is built as a Node Single Executable Application (SEA), which
embeds the runtime in one executable per OS. The code is TypeScript, bundled with esbuild.

Node's standard library covers everything the update path needs: `fetch`, Ed25519 in
`crypto`, atomic `fs.rename`, IPC between processes and `node:test`. That means zero
runtime dependencies. Every line that runs on a client is code we wrote, and there's no
third-party supply chain in the update path.

## Considered options

- **Go or Rust**: a single static binary per OS with no embedded interpreter. That's a
  better fit for a self-replacing binary in the abstract, but it isn't my strongest
  language, and live extension matters more here.
- **Python with PyInstaller**: Ed25519 needs the third-party `cryptography` package.
  Frozen PyInstaller binaries are a common source of antivirus false positives on Windows
  and of signing quirks on macOS.
- **Plain JavaScript**: there'd be no build step for the code itself, but esbuild is
  needed anyway to produce the single file SEA embeds. Typed manifest and IPC message
  shapes are worth the small cost.

## Consequences

- The Node runtime version is fixed by the launcher. Upgrading it means updating the
  launcher, which doesn't update itself ([ADR-0002](0002-launcher-and-versioned-folders.md)).
- A release of the app is just JavaScript, so one artifact serves every OS.
