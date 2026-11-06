# Local build of the HAPI Android app

This repository is a local fork of [`tiann/hapi`](https://github.com/tiann/hapi).
It tracks one upstream commit and carries a small, self-contained patch that
adds model pickers the upstream Android client does not have.

| | |
|---|---|
| Upstream | `tiann/hapi` @ `2741217b8986aef1b26a10962cfcec9a0a375b5c` (2026-11-06) |
| Baseline tag | `upstream-2741217` (branch `upstream-base`) |
| Local branch | `main` |
| Application ID | `run.hapi.companion` |
| Current version | `0.34.3+local.1` (`hapiVersionCode=298943511`) |

## What the patch does

The upstream Android client could only switch models for two agents. This
patch adds model pickers for the three that matter on this machine, in both
places a model can be chosen:

- **New-session form** (`feature/newsession`) — Kimi and DeepSeek Harness now
  offer their catalogs; `buildSpawnRequest` sends the chosen model instead of
  dropping it.
- **In-session config sheet** (`feature/chat`) — Kimi, DeepSeek Harness and
  Claude all offer their catalogs.

Two details worth knowing:

- **Claude shows the served model, not the alias.** The upstream client used a
  static list (`Opus`, `Sonnet`, `Haiku`). This patch reads
  `GET /api/machines/:id/claude-models`, whose `displayName` carries the model
  actually behind each alias — on this machine `opus` is served by
  `MiniMax-M3[1M]`.
- **Offline sessions still show a catalog.** `GET /api/sessions/:id/kimi-models`
  only answers while the session's ACP connection is live. The patch falls back
  to the machine-scoped endpoint, so an offline session still lists models; the
  change applies when the session resumes (the sheet says so).

Changed files:

```
android/core/protocol/.../wire/ApiResponses.kt      new response types
android/core/data/.../api/HapiApi.kt                 new endpoints
android/core/data/.../api/ChatSessionApi.kt          interface widening
android/app/.../feature/chat/ChatViewModel.kt        session config sheet
android/app/.../feature/newsession/NewSession*.kt    new-session form
+ three test files
```

## Versioning scheme

Both values live in `android/gradle.properties`:

```properties
hapiVersionName=0.34.3+local.1
hapiVersionCode=298943511
```

- `hapiVersionName` — upstream's release string plus a `+local.N` marker, where
  `N` is the local patch level. The marker keeps a local build distinguishable
  from the Play Store release at a glance.
- `hapiVersionCode` — upstream's Play build is `298943510`, so local builds
  take `298943511` and up. Android refuses an install whose versionCode is not
  greater than the installed one, so this range keeps local builds
  installable as an upgrade over any upstream build, and keeps later local
  builds upgradeable over earlier ones.

**To cut a new local release:** bump `N` and the code together.

```properties
hapiVersionName=0.34.3+local.2
hapiVersionCode=298943512
```

## Building

```powershell
cd D:\hapi-main\android
.\gradlew.bat :app:assembleDebug
```

Output: `android\app\build\outputs\apk\debug\app-debug.apk`

> `android/local.properties` must use **forward slashes**:
> `sdk.dir=C:/Users/guoga/AppData/Local/Android/Sdk`.
> A backslash-escaped colon (`C\:\Users\...`) makes Gradle fail with
> `java.io.IOException: Invalid file path` during task-graph calculation —
> the error points nowhere near the cause.

Release copies (versioned filename + checksum) are produced by:

```powershell
D:\KimiCode\build-apk.ps1
```

which builds, stamps the version into the filename, writes a `.sha256` next to
it, and optionally installs over ADB.

## Updating from upstream

The git transport to GitHub is unreliable from this machine, so the baseline
was imported from a codeload tarball. Once the network allows:

```powershell
git fetch origin main
git checkout -b update/<new-sha>
git rebase upstream-base origin/main     # replay the local patch
```

If the patch does not apply cleanly, resolve the conflicts in the two
ViewModels — that is where all of it lives — and re-run
`.\gradlew.bat :app:assembleDebug`.

To import a new baseline the same way the original was imported:

```powershell
curl -L -o up.tgz https://codeload.github.com/tiann/hapi/tar.gz/<sha>
tar -xzf up.tgz --exclude="cli/.cursorrules"
git checkout -b upstream-<sha>
# copy the upstream tree over, then:
git commit -m "chore: import upstream <sha>"
git tag -a upstream-<sha>
```

## Runtime dependencies for the features this patch enables

The Android client is only the UI. The machine-side pieces live outside this
repository:

- `HAPI_DSH_ACP_COMMAND` — points at `D:\KimiCode\dsh-acp.cmd`, a wrapper
  that keeps DSH's startup log line out of the ACP JSON-RPC stream. Without it
  the DeepSeek Harness catalog cannot be read at all.
- `HAPI_KIMI_PATH` — `...\npm\kimi.cmd`; Windows cannot resolve a bare `kimi`.
- `C:\Users\guoga\AppData\Roaming\npm\agent.cmd` — a stub for Cursor's `agent`
  binary. Without it the runner's Cursor probe raises an unhandled EPIPE and
  the runner exits.

See `D:\KimiCode\LOCAL-BUILD.md` for the machine-side notes.
