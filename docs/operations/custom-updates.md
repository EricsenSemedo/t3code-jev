# Personal desktop updates and upstream sync

This fork publishes its own Linux and Windows desktop updates for T3 Code Personal. It does not deploy the
upstream relay, hosted web app, or npm package.

`custom-desktop-nightly.yml` runs hourly and after a validated upstream merge, only from `main`.
It compares `main` with the newest
published Personal nightly release in this repository; ordinary Git tags, including tags brought in
by an upstream merge, cannot suppress the first Personal release. Unchanged source is skipped;
new commits do not wait for the upstream project's six-hour release interval. The workflow
resolves one version using the cross-workflow run ID, builds the Linux x64 AppImage and Windows x64 NSIS
installer from that exact commit, and publishes one prerelease in `${{ github.repository }}`. The
release is created only after both platform builds succeed and contains the AppImage with
`nightly-linux.yml`, plus the Windows `.exe`, its `.exe.blockmap`, and `nightly.yml`.

Each packaging job sets `T3CODE_DESKTOP_UPDATE_REPOSITORY` from `github.repository`, so Electron
checks this fork's releases. Windows also receives the matching Linux CLI archive for its bundled WSL backend.
That archive is built and smoke-tested from the same commit and version. Builds are unsigned unless a future, separate signing decision adds signing
configuration.

The Windows NSIS installer remains per-user and does not require elevation. The current
upstream Electron Builder includes its own corrected installer memory handling; no older
installer backport is retained.

For the first release, merge the reviewed Personal source into the repository default branch,
enable the Personal desktop nightly workflow, and confirm GitHub Actions may grant its requested
`contents: write` permission. Then dispatch that workflow from `main`. Do not run a manual dispatch
or create a release until that review is complete. The workflow intentionally does not publish npm
packages, deploy a relay, or deploy a hosted web app.

CI also builds both platforms with a run-specific nightly version and uploads `desktop-preview-*`
artifacts. Download those artifacts to test an installer before merging; CI does not create a
GitHub Release.

`upstream-sync.yml` fetches `pingdotgg/t3code` main hourly without importing upstream release tags
and opens a pull request from `automation/upstream-main`. Each batch is the longest contiguous
first-parent upstream prefix whose merged diff changes at most 100 files, so CodeRabbit can review
it. An open batch stays stable while checks and review run; only a newer Personal `main` refreshes
its base. The workflow explicitly dispatches CI for the proposed revision and retries a missing
dispatch on its next run. A merge conflict or an oversized first upstream commit aborts the run for
manual resolution; it never resets Personal changes.

`complete-upstream-sync.yml` runs after CI and every 15 minutes. It executes code from trusted `main`
and automatically merges only when the proposed revision includes current `main`, passes the full
CI suite and both installer builds, has CodeRabbit approval on that exact revision, and has no
unresolved review threads, requested changes or unsuccessful checks. Missing reviews are requested
at most hourly to recover from review rate limits. A merge explicitly dispatches publication;
the hourly release schedule also recovers from a failed dispatch.

Conflicts, failed tests and review findings require a fix before automation continues. Inspect the
sync PR and its Actions runs for the waiting reason. GitHub schedules and reviewer capacity can
delay delivery; hourly checks do not guarantee a new installable build every hour. The desktop
update button offers the tested Personal build once publication completes.

Keep current upstream dependencies, native helpers, and vendored reference snapshots together
when syncing. Reapply only the fork-specific UI, routing, speech, identity, and update changes;
never restore older whole files to resolve conflicts.
