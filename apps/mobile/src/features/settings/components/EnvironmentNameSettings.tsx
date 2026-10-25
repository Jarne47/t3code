import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import { SettingsSection } from "./SettingsSection";

export function EnvironmentNameSettings({
  environmentId,
  config,
  connected,
}: {
  readonly environmentId: EnvironmentId;
  readonly config: ServerConfig;
  readonly connected: boolean;
}) {
  const allowed = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const supported = config.environment.capabilities.environmentName === true;
  const disabled = !connected || !allowed || !supported || saving;
  const current = config.settings.environmentName ?? "";
  const value = draft ?? current;
  const changed = value.trim() !== current;

  const save = async () => {
    if (disabled || !changed) return;
    setSaving(true);
    try {
      const result = await updateSettings({
        environmentId,
        input: { patch: { environmentName: value.trim() || null } },
      });
      if (result._tag === "Success") setDraft(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection title="T3 name">
      <View className="gap-3 p-4">
        <View className="flex-row items-center gap-3">
          <AppTextInput
            accessibilityLabel="T3 name"
            value={value}
            onChangeText={setDraft}
            maxLength={100}
            editable={!disabled}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            placeholder={config.environment.systemLabel ?? config.environment.label}
            onSubmitEditing={() => void save()}
            className="min-h-11 min-w-0 flex-1 rounded-xl border-continuous bg-card px-3 text-base text-foreground"
          />
          {changed ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save T3 name"
              disabled={disabled}
              onPress={() => void save()}
              className="rounded-full bg-subtle-strong px-4 py-2 active:opacity-70 disabled:opacity-40"
            >
              <Text className="text-sm font-t3-medium text-foreground">
                {saving ? "Saving…" : "Save"}
              </Text>
            </Pressable>
          ) : null}
        </View>
        <Text className="text-sm text-foreground-muted">
          {supported
            ? "Appears on every connected device. Leave empty to use the system name."
            : "Update this environment's server to give it a custom T3 name."}
        </Text>
      </View>
    </SettingsSection>
  );
}
