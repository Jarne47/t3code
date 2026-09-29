# Personal sidebar fork

This fork tracks [pingdotgg/t3code](https://github.com/pingdotgg/t3code). Customizations live on `itamar/sidebar-customizations`; `main` remains an upstream reference. The `personal` remote is the fork and `upstream` is the original repository.

## Sidebar controls

- **Mod+Shift+B** switches between the new sidebar and the legacy project tree. You can also use the layout button beside the sidebar toggle, the command palette, or the existing legacy-sidebar setting. Rebind `sidebar.toggleLayout` in Settings → Keybindings. Mod is Command on macOS and Control elsewhere.
- The new sidebar's sort menu offers **Manual order**, **Last user message**, **Newest created**, and **Project A–Z**. Project view keeps logical project worktrees together and sorts threads within each project by their last user message. All projects remain visible.
- Automatic sorting is a desktop/web view preference. It does not rewrite manual positions or change the native mobile app's ordering. Choose Manual order to drag threads; pinning and other thread-menu actions remain available in every view.
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

The command does not push, install, or deploy. Push the verified branch with `git push personal HEAD`. There is no scheduled synchronization or custom release feed yet. Official desktop updates replace the official application; they do not preserve this fork's changes. Use the local development shell until a separate packaged application and update channel are set up.
