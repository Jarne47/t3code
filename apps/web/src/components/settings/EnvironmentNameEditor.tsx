import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { PencilIcon } from "lucide-react";
import { useId, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

export function EnvironmentNameEditor({
  environmentId,
  label,
  serverConfig,
  connected,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly serverConfig: ServerConfig | null;
  readonly connected: boolean;
}) {
  const allowed = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const formId = useId();
  const supported = serverConfig?.environment.capabilities.environmentName === true;
  const systemLabel = serverConfig?.environment.systemLabel ?? label;
  const current = serverConfig?.settings.environmentName ?? "";
  const disabled = !connected || !allowed || !supported;

  const save = async () => {
    if (disabled || busy) return;
    setBusy(true);
    try {
      const result = await updateSettings({
        environmentId,
        input: { patch: { environmentName: draft.trim() || null } },
      });
      if (result._tag === "Success") setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        variant="ghost-muted"
        size="icon-xs"
        aria-label={`Rename ${label}`}
        title={
          !connected
            ? "Connect to rename this environment"
            : !supported
              ? "Update this environment's server to rename it"
              : !allowed
                ? "Your connection cannot change this environment's settings"
                : "Rename environment"
        }
        disabled={disabled}
        onClick={() => {
          setDraft(current);
          setOpen(true);
        }}
      >
        <PencilIcon className="size-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Rename environment</DialogTitle>
            <DialogDescription>
              This name appears on every device connected to this T3 environment. Leave it empty to
              use the system name, {systemLabel}.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <form
              id={formId}
              className="grid gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <Label htmlFor={inputId}>T3 name</Label>
              <Input
                id={inputId}
                autoFocus
                maxLength={100}
                value={draft}
                placeholder={systemLabel}
                disabled={busy || disabled}
                onChange={(event) => setDraft(event.target.value)}
              />
            </form>
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              form={formId}
              disabled={disabled || busy || (draft.trim() || "") === current}
            >
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
