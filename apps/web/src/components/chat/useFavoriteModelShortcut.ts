import {
  ANTIGRAVITY_DEFAULT_MODEL,
  FAVORITE_MODEL_KEYBINDING_COMMANDS,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";
import { useEffect, useEffectEvent, useMemo } from "react";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { modelPickerJumpIndexFromCommand, resolveShortcutCommand } from "../../keybindings";
import { isEditableFocused } from "../../lib/editableFocus";
import { getTerminalFocusOwner } from "../../lib/terminalFocus";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { providerModelKey, sortProviderModelItems } from "../../modelOrdering";
import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "../../providerInstances";
import type { ModelEsque } from "./providerIconUtils";

/** Closed-picker jumps follow the same selectable favorites order as the picker. */
export function useFavoriteModelShortcut(input: {
  enabled: boolean;
  favorites: ClientSettings["favorites"];
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey: string | null;
  keybindings: ResolvedKeybindingsConfig;
  terminalOpen: boolean;
  getModelDisabledReason: (instanceId: ProviderInstanceId, model: string) => string | null;
  onSelect: (instanceId: ProviderInstanceId, model: string) => void;
}) {
  const {
    enabled,
    favorites,
    instanceEntries,
    modelOptionsByInstance,
    lockedProvider,
    lockedContinuationGroupKey,
    keybindings,
    terminalOpen,
    getModelDisabledReason,
    onSelect,
  } = input;
  const selectModel = useEffectEvent(onSelect);
  const models = useMemo(() => {
    const favoriteKeys = new Set(
      favorites.map((favorite) => providerModelKey(favorite.provider, favorite.model)),
    );
    const candidates = [];
    for (const [instanceId, options] of modelOptionsByInstance) {
      const entry = instanceEntries.find((entry) => entry.instanceId === instanceId);
      if (!entry || !isProviderInstancePickerReady(entry)) continue;
      if (
        lockedProvider !== null &&
        (entry.driverKind !== lockedProvider ||
          (lockedContinuationGroupKey && entry.continuationGroupKey !== lockedContinuationGroupKey))
      )
        continue;
      for (const option of options) {
        if (
          option.isUnavailable ||
          (entry.driverKind === "antigravity" && option.slug === ANTIGRAVITY_DEFAULT_MODEL) ||
          !favoriteKeys.has(providerModelKey(instanceId, option.slug)) ||
          getModelDisabledReason(instanceId, option.slug)
        )
          continue;
        candidates.push({ instanceId, slug: option.slug });
      }
    }
    return sortProviderModelItems(candidates, {
      instanceOrder: instanceEntries.map((entry) => entry.instanceId),
    });
  }, [
    favorites,
    getModelDisabledReason,
    instanceEntries,
    lockedContinuationGroupKey,
    lockedProvider,
    modelOptionsByInstance,
  ]);

  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        isCommandPaletteOpen() ||
        isModelPickerOpen() ||
        getTerminalFocusOwner() !== null
      )
        return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: false,
          terminalOpen,
          modelPickerOpen: false,
          editableFocus: isEditableFocused(event.target),
          composerFocus: document.activeElement?.getAttribute("data-testid") === "composer-editor",
        },
      });
      const favoriteIndex = FAVORITE_MODEL_KEYBINDING_COMMANDS.findIndex(
        (favoriteCommand) => favoriteCommand === command,
      );
      const index =
        favoriteIndex === -1 ? modelPickerJumpIndexFromCommand(command ?? "") : favoriteIndex;
      if (index === null) return;
      event.preventDefault();
      event.stopPropagation();
      const model = models[index];
      if (model) selectModel(model.instanceId, model.slug);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [enabled, keybindings, models, terminalOpen]);
}
