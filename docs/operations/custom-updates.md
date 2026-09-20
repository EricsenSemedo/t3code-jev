# Personal desktop updates and upstream sync

This fork publishes its own Linux and Windows desktop updates for T3 Code Personal. It does not deploy the
upstream relay, hosted web app, or npm package.

`custom-desktop-nightly.yml` runs daily and only from `main`. It first skips when `main` is
already the commit behind the latest Personal nightly tag. For a new commit it resolves one nightly
version, builds the Linux x64 AppImage and Windows x64 NSIS installer from that exact commit, and
publishes one prerelease in `${{ github.repository }}`. The release is created only after both
platform builds succeed and contains the AppImage with `nightly-linux.yml`, plus the Windows
`.exe`, its `.exe.blockmap`, and `nightly.yml`.

Each packaging job sets `T3CODE_DESKTOP_UPDATE_REPOSITORY` from `github.repository`, so Electron
checks this fork's releases. Windows also receives the matching Linux CLI archive for its bundled WSL backend.
That archive is built and smoke-tested from the same commit and version. Builds are unsigned unless a future, separate signing decision adds signing
configuration.

The Windows NSIS installer remains per-user and does not require elevation. The current
upstream Electron Builder includes its own corrected installer memory handling; no older
installer backport is retained.

Enable Actions and grant the workflow `contents: write` only when ready to publish. Do not run a
manual dispatch or create a release until that review is complete. The workflow intentionally
does not publish npm packages, deploy a relay, or deploy a hosted web app.

CI also builds both platforms with a run-specific nightly version and uploads `desktop-preview-*`
artifacts. Download those artifacts to test an installer before merging; CI does not create a
GitHub Release.

`upstream-sync.yml` fetches `pingdotgg/t3code` main on weekday mornings, merges it into
`automation/upstream-main`, and opens or updates a pull request. Because PRs created with the
workflow token do not automatically start PR workflows, it dispatches the fork's CI workflow for
that review branch. A merge conflict aborts the run without creating a branch or pull request.
The workflow never resets `main` and never auto-merges: the dispatched CI and a review must pass
before merging the sync PR.

Keep current upstream dependencies, native helpers, and vendored reference snapshots together
when syncing. Reapply only the fork-specific UI, routing, speech, identity, and update changes;
never restore older whole files to resolve conflicts.
