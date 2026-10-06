# Personal sidebar fork

This fork tracks [pingdotgg/t3code](https://github.com/pingdotgg/t3code). Customizations live on the default branch, `main`. The `origin` remote is the fork and `official` is the original repository; `official/main` remains the unmodified upstream reference. Use these names so T3 groups fork checkouts across computers under `Jarne47/t3code`. The former `itamar/sidebar-customizations` branch is retained for historical reference.

## Download

Open [Releases](https://github.com/Jarne47/t3code/releases/latest) and install the same release on both computers:

- **Windows:** `T3-Code-<version>-x64.exe` (Intel/AMD 64-bit, includes the matching WSL backend).
- **Mac:** `T3-Code-<version>-arm64.zip` (Apple Silicon). Extract **T3 Code (Itamar).app** into Applications.

These personal packages are not signed with Microsoft's or Apple's commercial signing certificates. macOS packages have an ad-hoc signature. They use their own data directory, `~/.t3-itamar`, and do not automatically import nightly history or connections. The personal app has no official auto-update feed.

### Update the installed app

Starting with `0.0.46-itamar.20261003.2`, **Settings → About** checks the personal GitHub releases. Choose **Download update**, then **Restart and update**; the sidebar also offers available app updates. Install this version manually once on each computer to enable the updater. The **Updates Available: providers** notification updates provider tools separately.

The app checks package size and GitHub's SHA-256 checksum before installation. Windows installs into the running executable's directory. macOS stages and validates the signed bundle beside the running `.app`, replaces that same path after quitting, and restores the previous bundle if replacement fails. Open an installed, writable Mac copy rather than one running from a disk image or App Translocation. Personal builds follow only `Jarne47/t3code` releases; Stable/Nightly track switching is unavailable. Updating the app does not pull or build a source checkout, and only published packages are offered.

### Keep your Windows nightly history

Before the personal app's first launch, quit nightly completely. In the installer, leave **Run T3 Code (Itamar)** unchecked. Copy the history and preferences with this PowerShell command. It refuses to replace an existing personal history database; the original nightly files remain in place.

```powershell
$source = Join-Path $env:USERPROFILE '.t3\userdata'
$target = Join-Path $env:USERPROFILE '.t3-itamar\userdata'
if (Test-Path (Join-Path $target 'state.sqlite')) { throw 'Personal history already exists; do not overwrite it.' }
if (!(Test-Path (Join-Path $source 'state.sqlite'))) { throw 'Nightly history was not found at the default location.' }
New-Item -ItemType Directory -Path $target -Force | Out-Null
Get-ChildItem -LiteralPath $source -Filter 'state.sqlite*' | Copy-Item -Destination $target
foreach ($name in @('client-settings.json', 'settings.json', 'keybindings.json', 'attachments', 'themes')) {
    $item = Join-Path $source $name
    if (Test-Path $item) { Copy-Item -LiteralPath $item -Destination $target -Recurse }
}
```

Then launch the personal app and sign in to T3 Connect. Its environment registration and browser sign-in are separate from nightly. If your history is stored in WSL or you customized `T3CODE_HOME`, use the actual environment's data location instead of these defaults.

## Connect the computers

On both computers, open **Settings → Connections**, sign in to the same **T3 Connect** account you used in nightly, and enable T3 Connect for the local environment. Select the other computer's environment to work there. Keep both computers running and reachable for access in both directions.

Each environment owns its conversations, project files, terminals, and agent sessions. Connecting gives the other computer access to that environment; it does not merge or copy two independent histories. Installing this build does not transfer Windows nightly history into the new personal environment.

## Sidebar controls

- **Mod+Shift+B** switches between the new sidebar and the legacy project tree. You can also use the layout button beside the sidebar toggle, the command palette, or the existing legacy-sidebar setting. Rebind `sidebar.toggleLayout` in Settings → Keybindings. Mod is Command on macOS and Control elsewhere.
- The new sidebar's sort menu offers **Manual order**, **Last user message**, and **Newest created**, plus an independent **Group by project** switch. Each group initially shows five threads, with **See more** and **See less** controls. Click its heading to fold or unfold the project; folding is remembered on this client and leaves settle and snooze status unchanged. Drag the grip to move an entire group; its order is saved. The selected sort applies inside each group. Logical project worktrees stay together. Keyboard users can focus the grip, press Space, move with the arrow keys, and press Space to drop (Escape cancels).
- Automatic sorting is a desktop/web view preference. It does not rewrite manual positions or change the native mobile app's ordering. Turn grouping off and choose Manual order to drag individual threads; pinning and other thread-menu actions remain available in every view.
- Pinned threads retain their own order above active threads, with section labels and a subtle theme-aware accent tint.

## Run locally

Install Vite+ (`vp`) using the upstream README and load the shell environment printed by its installer (on this Mac: `source ~/.config/vite-plus/env`), then:

```sh
vp env install 24
vp env exec --node 24 -- vp install --frozen-lockfile
./scripts/fork-dev.sh
```

Open the local pairing URL printed by the dev runner. The fork uses `.t3/` inside this checkout for its data; it does not run against the installed app's database. To use the Electron development shell instead:

```sh
vp env exec --node 24 -- vp run dev:desktop --home-dir "$PWD/.t3"
```

## Update from the team

With a clean working tree on `main`:

```sh
./scripts/fork-update.sh
```

This merges upstream `main`, installs locked dependencies, runs focused checks, and builds the web client. You can supply an upstream release tag instead of `main`. A tag older than your current base does not downgrade the fork. On a conflict, resolve it and run `./scripts/fork-check.sh`, or cancel with `git merge --abort`. A failed check stops the update before the build.

The command first fast-forwards from the personal fork to pick up weekly maintenance, then merges upstream. If your local branch has diverged, it stops for manual reconciliation. It does not push, install, or deploy. Push the verified branch with `git push origin HEAD`. Official desktop updates replace the official application; they do not preserve this fork's changes. The personal package uses its own release updater, so official updates cannot replace the customizations.

## Weekly maintenance on this Mac

The LaunchAgent `com.itamar.t3code-weekly-maintenance` runs Sundays at 09:00 in the Mac's local time. It fetches `official/main`, merges into the latest personal fork in a disposable worktree, installs locked dependencies, runs `fork-check.sh`, and builds the web client. Only successful updates are pushed to `origin/main`; conflicts or failed checks stop the run. No force pushes, desktop installation, restarts, or writes to app history occur. The working checkout is left untouched; run `fork-update.sh` before building the next desktop version.

Latest results and command output are in `~/Library/Application Support/t3code-maintenance/latest.json` and `latest.log`. macOS notifications are attempted when updates succeed or need attention, subject to notification settings. The task requires this Mac and your logged-in session; a scheduled run missed during sleep runs on wake, while one missed during shutdown waits for the next Sunday. No changes means no dependency install or tests are needed.

Run now or disable the schedule:

```sh
launchctl kickstart "gui/$(id -u)/com.itamar.t3code-weekly-maintenance"
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.itamar.t3code-weekly-maintenance.plist"
```

After disabling, remove that plist to prevent registration at the next login. The installed script lives beside the status report; after editing `scripts/fork-maintenance.py`, copy it there to update the scheduled runner.

## Personal desktop app

The installed macOS app is **T3 Code (Itamar)** in `/Applications`. Its runtime data is in `~/.t3-itamar/userdata`, and its browser profile is in `~/Library/Application Support/t3code-itamar`. The first installation receives a read-only SQLite snapshot of the original history plus attachments, themes, and settings. Later history changes are independent; do not copy the original database over an in-use fork.

Personal packages use versions such as `0.0.44-itamar.20260930.1`. This suffix selects the separate application identity and data defaults and omits the official update feed. Stable/nightly build identities remain unchanged.

For updates, run `./scripts/fork-update.sh`, then `./scripts/fork-package.sh`. The latter builds a macOS ZIP under `release/itamar` but does not install or launch it. Quit the personal app before replacing its bundle; the separate data directory is retained. Rust is needed for the resource monitor unless an existing matching binary is cached. The initial Mac build reused the installed official ARM64 monitor, whose source was unchanged by the upstream sync.

The local ZIP is not notarized. After extracting the app into `/Applications`, apply and verify a local ad-hoc signature before launching:

```sh
codesign --force --deep --sign - '/Applications/T3 Code (Itamar).app'
codesign --verify --deep --strict '/Applications/T3 Code (Itamar).app'
```

## Build another matching release

In [this repository](https://github.com/Jarne47/t3code/actions/workflows/build-personal.yml), run **Actions → Build personal desktops → Run workflow** with a full source commit from `Jarne47/t3code` and a unique version such as `0.0.44-itamar.20260930.2`. The workflow builds Mac, Windows, and the Windows WSL backend from that one commit, then publishes a release only after all builds succeed. Release notes record the source commit; `SHA256SUMS` records the download checksums.

The workflow uses the public production configuration from upstream's `.env.example`. It does not package local conversations, sign-in sessions, pairing credentials, or private files.

## Imported conversations

Already-imported Codex and Claude conversations refresh from their linked local transcripts every 30 seconds. New messages append without replacing T3 messages or thread settings. An external follow-up reactivates a settled thread. Refresh waits while T3 is working; it does not discover new sessions in the background. Use the existing import action for new conversations. Like the original importer, refresh reads a bounded recent tail and does not backfill older gaps before the latest T3 message.

Claude's selected 200k window is enforced when its session starts. Changing between 200k and 1M resumes the conversation in a new Claude process on the next idle turn; active work must finish or be stopped first.
