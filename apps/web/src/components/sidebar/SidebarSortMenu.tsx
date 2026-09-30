import { ArrowDownWideNarrowIcon, ChevronDownIcon } from "lucide-react";
import { SidebarActiveSortOrder } from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";

const isActiveSortOrder = Schema.is(SidebarActiveSortOrder);

const SORT_LABELS = {
  manual: "Manual order",
  updated_at: "Last user message",
  created_at: "Newest created",
} satisfies Record<Exclude<SidebarActiveSortOrder, "project">, string>;

export function SidebarSortMenu({ disabled }: { disabled: boolean }) {
  const savedOrder = useClientSettings((settings) => settings.sidebarActiveSortOrder);
  const grouped =
    useClientSettings((settings) => settings.sidebarGroupActiveThreads) || savedOrder === "project";
  const order = savedOrder === "project" ? "updated_at" : savedOrder;
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
          {grouped ? "Grouped by project" : SORT_LABELS[order]}
          <ChevronDownIcon className="size-3" />
        </MenuTrigger>
        <MenuPopup align="end">
          <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
            {grouped ? "Sort threads within projects" : "Sort active threads"}
          </div>
          <MenuRadioGroup
            value={order}
            onValueChange={(value) => {
              if (isActiveSortOrder(value)) {
                void updateSettings({
                  sidebarActiveSortOrder: value,
                  sidebarGroupActiveThreads: grouped,
                });
              }
            }}
          >
            {Object.entries(SORT_LABELS).map(([value, label]) => (
              <MenuRadioItem key={value} value={value}>
                {label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          <MenuSeparator />
          <MenuCheckboxItem
            checked={grouped}
            onCheckedChange={(checked) => {
              void updateSettings({
                sidebarGroupActiveThreads: checked,
                sidebarActiveSortOrder: order,
              });
            }}
          >
            Group by project
          </MenuCheckboxItem>
          <p className="max-w-56 px-2 py-1 text-xs text-muted-foreground">
            {grouped
              ? "Drag project headers to arrange groups. Pinned threads stay on top."
              : "Choose Manual order to drag threads. Pinned threads always stay on top."}
          </p>
        </MenuPopup>
      </Menu>
    </div>
  );
}
