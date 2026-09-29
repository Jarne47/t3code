import { ArrowDownWideNarrowIcon, ChevronDownIcon } from "lucide-react";
import { SidebarActiveSortOrder } from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";

const isActiveSortOrder = Schema.is(SidebarActiveSortOrder);

const SORT_LABELS = {
  manual: "Manual order",
  updated_at: "Last user message",
  created_at: "Newest created",
  project: "Project A–Z",
} satisfies Record<SidebarActiveSortOrder, string>;

export function SidebarSortMenu({ disabled }: { disabled: boolean }) {
  const order = useClientSettings((settings) => settings.sidebarActiveSortOrder);
  const updateSettings = useUpdateClientSettings();
  return (
    <div className="mt-1 flex items-center justify-end">
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost-muted"
              size="xs"
              disabled={disabled}
              aria-label="Sort active threads"
            />
          }
        >
          <ArrowDownWideNarrowIcon className="size-3.5" />
          {SORT_LABELS[order]}
          <ChevronDownIcon className="size-3" />
        </MenuTrigger>
        <MenuPopup align="end">
          <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
            Sort active threads
          </div>
          <MenuRadioGroup
            value={order}
            onValueChange={(value) => {
              if (isActiveSortOrder(value)) {
                void updateSettings({ sidebarActiveSortOrder: value });
              }
            }}
          >
            {Object.entries(SORT_LABELS).map(([value, label]) => (
              <MenuRadioItem key={value} value={value}>
                {label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          <p className="max-w-56 px-2 py-1 text-xs text-muted-foreground">
            Choose Manual order to drag threads. Pinned threads always stay on top.
          </p>
        </MenuPopup>
      </Menu>
    </div>
  );
}
