# Releasing the inluck-net fork

This fork distributes standalone archives through GitHub Releases only. Never
publish `@concord-ai/concord-mcp` to npm or this fork to the MCP Registry.

## Prepare a release

1. Start from an upstream release tag on the `inluck/v0.16` patch branch.
2. Update `package.json` and `src/version.ts` to the same fork version, for
   example `0.16.0-inluck.1`. Keep the version distinct from upstream's.
3. Run `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, and
   `pnpm build` with Node 22.12 or newer.
4. Review the exact commits and get human review for authentication or other
   security-sensitive changes before releasing.
5. Push the branch. Tag its reviewed head as `v0.16.0-inluck.1` and push that
   tag only after confirming `.github/workflows/release.yml` has no npm or MCP
   Registry publishing step.

The tag workflow verifies the code, builds four platform-specific standalone
archives, and creates a GitHub Release with `install.sh`, the archives, and
SHA-256 files. `install.sh` downloads from this fork's releases.

## Install on a host

Set `CONCORD_VERSION=0.16.0-inluck.1` when running the fork's `install.sh` to
pin the exact release. Do not rerun an older upstream `concord setup` after
installing: it can replace local instructions and Codex configuration. Check
the global instructions mode and Codex hook trust, then verify a managed Codex
session can send and receive messages while idle.
