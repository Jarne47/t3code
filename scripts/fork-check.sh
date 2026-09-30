#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
(
  cd packages/contracts
  vp env exec --node 24 -- vp test run src/settings.test.ts src/keybindings.test.ts
)
(
  cd apps/web
  vp env exec --node 24 -- vp test run --project unit src/components/sidebar/activeThreadSort.test.ts src/keybindings.test.ts src/components/Sidebar.logic.test.ts src/components/Sidebar.drag.test.ts src/components/settings/KeybindingsSettings.logic.test.ts src/components/settings/settingsSearch.test.ts
)
vp env exec --node 24 -- vp run --filter @t3tools/web typecheck

env -u ELECTRON_RUN_AS_NODE vp env exec --node 24 -- vp test run apps/desktop/src/app/DesktopEnvironment.test.ts scripts/build-desktop-artifact.test.ts
vp env exec --node 24 -- vp run --filter @t3tools/desktop typecheck
