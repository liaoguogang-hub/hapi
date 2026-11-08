# Local build of the Kestrel Android app

This repository is a local fork of [`tiann/hapi`](https://github.com/tiann/hapi), pushed to
`liaoguogang-hub/hapi` (remote `fork`; `upstream` points at `tiann/hapi`).

The user-facing product name is **Kestrel**. The application id
(`run.hapi.companion`), the Kotlin/iOS package namespaces, the
`hapicompanion://` deep-link scheme, the `HAPI_*` environment variables and
the `hapi` CLI binary name are unchanged upstream identifiers and stay as they
are — the rename is cosmetic and reversible.

It tracks one upstream commit and carries a small, self-contained patch that
adds model pickers the upstream Android client does not have.

| | |
|---|---|
| Upstream | `tiann/hapi` @ `2741217b8986aef1b26a10962cfcec9a0a375b5c` (2026-11-06) |
| Baseline tag | `upstream-2741217` (branch `upstream-base`) |
| Local branch | `main` |
| Application ID | `run.hapi.companion` |
| Current version | `0.34.3+local.11` (`hapiVersionCode=298943521`) |

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

### Navigation patch (`0.34.3+local.10`)

Three gaps reported from the phone, all modelled on the DSH remote app
(`~/Documents/DSH/DshRemote`), whose drawer *is* the conversation browser:

- **Drawer with agent grouping** — a hamburger opens a `ModalNavigationDrawer`
  that lists conversations grouped per agent, each group collapsible and
  captioned with the agent mark, its label and its count. Tapping a row opens
  that conversation and closes the drawer. DSH groups by workspace because its
  host serves a single agent; a Kestrel hub mixes several, so the groups are
  agents. Groups are ordered by size, rows keep the list's ordering.
- **Archived filter** — the drawer's view-options menu offers DSH's three
  states: hide archived (default), show everything, only archived. Sessions
  with `metadata.lifecycleState = archived` were listed unconditionally before.
  The filter runs before the calendar hints, so a day whose only sessions are
  archived does not light up with an empty list. It also governs the main list,
  not just the drawer.
- **Turn navigation** — a numbered turn list from the chat top bar (tap to
  jump) plus a rail of ticks down the right edge that can be tapped or
  scrubbed. Turns derive from user text blocks because hapi records no turn
  boundaries for imported or agent-authored history; jumping clears
  follow-the-tail so the viewport is not pulled back to the newest message.

Two behaviour notes that came out of device testing:

- Material3's `ModalNavigationDrawer` does not consume the system Back gesture.
  Without an explicit `BackHandler` (enabled while the drawer is open) Back
  exits the app instead of closing the drawer.
- The drawer search field writes the same query as the top-bar search, so the
  drawer and the list never disagree about what is filtered.

### Drawer paging and the search caret (`0.34.3+local.11`)

Both came straight from device feedback:

- **Five rows per agent, then +5.** A hub with 84 DeepSeek Harness sessions
  buried every other agent. Each group now shows five rows and a
  "Show N more conversations" button that reveals five more per tap, with a
  collapse row once the list is fully open.
- **Search caret no longer jumps.** Both search fields were driven straight off
  the view-model string. The local edit was replaced one frame later by the
  round-tripped value, and a String-based field re-derives the selection when
  its value changes from outside — so the second keystroke landed before the
  first (typing `abc` produced `cba`). Each field now keeps its own draft and
  only adopts an external value when it actually differs. Verified on the
  device: `input text abc` leaves `abc` in the field, both in the top bar and
  in the drawer.
- The drawer's search field also gained auto-focus; without it, tapping the
  magnifier opened an empty field that the keyboard did not target.

```
android/app/.../feature/home/SessionDrawer.kt        new: grouped browser
android/app/.../feature/chat/TurnNavigation.kt       new: turn list + rail
android/app/.../feature/home/HomeScreen.kt           drawer + Back handling
android/app/.../feature/home/HomeTopBar.kt           hamburger
android/app/.../feature/chat/ChatScreen.kt           turn entry + rail
android/app/.../feature/sessions/SessionListViewModel.kt  agent groups, archived tri-state
android/app/src/main/res/values{,-zh-rCN}/strings.xml     new labels
```

### Drawer sort order (`0.34.3+local.12`)

The drawer's view-options menu gained a "Sort order" section, matching the DSH
remote app's drawer: newest first (default), oldest first, or by name. Pinned
sessions stay on top in every mode — that part of the sidebar contract is not
user-sortable — and the choice feeds the list as well as the drawer.

Implementation note: the existing `sortSessionSummaries` comparator is the
shared web/Android ordering, so the alternate orders live in the view-model as
extra comparators layered under the same pinned-first prefix rather than being
pushed into `core/protocol`.

### Claude Code import (`0.34.3+local.7` hub/CLI)

Claude Code's CLI and the VS Code extension write one JSONL transcript per
session under `~/.claude/projects/<slug>/<sessionId>.jsonl`. `hapi claude-import`
reads that store and posts the mapped transcript to `/cli/claude/import`, which
reuses the append-only, idempotent, refuses-to-interleave guarantees of the DSH
and Kimi importers.

Two mapping decisions worth remembering:

- The project slug is a lossy encoding of the working directory, so every
  session's `cwd` is taken from the records, not from the folder name.
- One assistant message spans several records (one per content block: thinking,
  text, tool_use). Text blocks are merged and emitted once; tool traffic and
  thinking are dropped, which is what keeps a 400-message transcript readable on
  a phone.

The reverse direction needs no code: a Claude session started from the phone
runs the real `claude` CLI, so it lands in the same store VS Code reads.

### Filter-sheet sort (`0.34.3+local.13` APK)

The toolbar filter sheet gained the same three orderings the drawer already has
(newest first / oldest first / by name); both surfaces read and write one
view-model state, so they cannot disagree.

## Running e2e locally

The pinned Playwright Chromium cannot be downloaded on this machine (the CDN
is unreachable), and the revision already on disk is not the one Playwright
1.61 expects. Run against the installed Edge instead:

```powershell
$env:PLAYWRIGHT_CHANNEL = "msedge"
node node_modules\playwright\cli.js test e2e/share-turn.spec.ts
```

`PLAYWRIGHT_CHANNEL` is read by `playwright.config.ts`; unset, the config keeps
using the downloaded build (that is what CI does). Two traps:

- Invoke `node node_modules\playwright\cli.js`, not `node_modules\.bin\playwright`
  — that shim is a bun wrapper and fails with `EPERM: mkdir` on its transform
  cache.
- Run it from this full checkout, not from `build/`. The `build/` working copy
  has hand-materialised `node_modules` (single hoisted version per package), so
  `vite` resolves the wrong `rollup` and `@babel/*` the wrong `lru-cache`; the
  dev server never starts there.

## Remote mirrors

Local work mirrors to dedicated branches on the fork; `main` is deliberately
left alone because the local baseline is upstream `eab2ce5f` while the fork's
`main` tracks upstream 1787 commits further.

| Local tree | Remote ref |
|---|---|
| this tree (`D:\hapi-main`, APK work) | `fork/feature/kestrel-android` |
| `build/` (hub + CLI work) | `fork/feature/local-hub-cli-build` |
| `deploy/` | private repo `liaoguogang-hub/hapi-deploy` |

Push with `-c core.compression=0`: the SSH transport occasionally drops with
`early EOF` on this connection.

## Versioning scheme

Both values live in `android/gradle.properties`:

```properties
hapiVersionName=0.34.3+local.11
hapiVersionCode=298943521
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
hapiVersionName=0.34.3+local.4
hapiVersionCode=298943514
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
