# HANDOFF (updated 2026-11-23)

## Done
- `release publish --layout flat`: writes app-<version>.cjs next to manifest.json
  (GitHub release assets are flat). Default layout unchanged. Tests added (174 pass).
- .github/workflows/release.yml: on v* tag, test, build, sign, `gh release create --latest`.
- .github/workflows/refresh-manifest.yml: weekly re-sign of latest manifest (30-day expiry).
- README: "Testing locally" and "Testing remotely with GitHub" sections.

## Not done / not verified
- Workflows have never run on GitHub (no push yet). gh CLI flags unverified in Actions.
- Real GitHub redirect to the CDN, and the latest/download caching delay, are untested.
- Remote demo installs to demo/github-client (local demo keeps demo/client).
- Launcher binaries are not attached to releases; first install is still `build install`.

## Next, and why
1. Set secret NAMETAG_SIGNING_KEY + variable NAMETAG_PUBLIC_KEY, make repo public
   (anonymous latest/download needs it), push, tag v1.0.0, watch the Release workflow.
2. Tag v1.1.0 with a client built from the GitHub manifest URL; confirm it updates.
3. Decide whether to use a fresh key pair for the public repo (keys/ is gitignored).
