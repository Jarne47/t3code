# Personal sidebar fork

This fork tracks [pingdotgg/t3code](https://github.com/pingdotgg/t3code). Customizations live on `itamar/sidebar-customizations`; `main` remains an upstream reference. The `personal` remote is the fork and `upstream` is the original repository.

## Sidebar controls

- **Mod+Shift+B** switches between the new sidebar and the legacy project tree. You can also use the layout button beside the sidebar toggle, the command palette, or the existing legacy-sidebar setting. Rebind `sidebar.toggleLayout` in Settings → Keybindings. Mod is Command on macOS and Control elsewhere.
- The new sidebar's sort menu offers **Manual order**, **Last user message**, and **Newest created**, plus an independent **Group by project** switch. With grouping enabled, drag a project header to move its entire group; its order is saved. The selected sort applies inside each group. Logical project worktrees stay together. Keyboard users can focus a header, press Space, move with the arrow keys, and press Space to drop (Escape cancels).
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

With a clean working tree on the customization branch:

```sh
./scripts/fork-update.sh
```

This merges upstream `main`, installs locked dependencies, runs focused checks, and builds the web client. You can supply an upstream release tag instead of `main`. A tag older than your current base does not downgrade the fork. On a conflict, resolve it and run `./scripts/fork-check.sh`, or cancel with `git merge --abort`. A failed check stops the update before the build.

The command does not push, install, or deploy. Push the verified branch with `git push personal HEAD`. There is no scheduled synchronization or custom release feed yet. Official desktop updates replace the official application; they do not preserve this fork's changes. The personal package deliberately has no auto-update feed, so official updates cannot replace the customizations.

## Personal desktop app

The installed macOS app is **T3 Code (Itamar)** in `/Applications`. Its runtime data is in `~/.t3-itamar/userdata`, and its browser profile is in `~/Library/Application Support/t3code-itamar`. The first installation receives a read-only SQLite snapshot of the original history plus attachments, themes, and settings. Later history changes are independent; do not copy the original database over an in-use fork.

Personal packages use versions such as `0.0.44-itamar.20260930.1`. This suffix selects the separate application identity and data defaults and omits the official update feed. Stable/nightly build identities remain unchanged.

For updates, run `./scripts/fork-update.sh`, then `./scripts/fork-package.sh`. The latter builds a macOS ZIP under `release/itamar` but does not install or launch it. Quit the personal app before replacing its bundle; the separate data directory is retained. Rust is needed for the resource monitor unless an existing matching binary is cached. The initial Mac build reused the installed official ARM64 monitor, whose source was unchanged by the upstream sync.

The local ZIP is not notarized. After extracting the app into `/Applications`, apply and verify a local ad-hoc signature before launching:

```sh
codesign --force --deep --sign - '/Applications/T3 Code (Itamar).app'
codesign --verify --deep --strict '/Applications/T3 Code (Itamar).app'
```
