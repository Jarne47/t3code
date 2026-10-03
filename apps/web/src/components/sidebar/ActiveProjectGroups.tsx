import { useId, useMemo, useState, type ReactNode } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDownIcon, ChevronRightIcon, FolderIcon, GripVerticalIcon } from "lucide-react";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { resolveProjectExpanded, useUiStateStore } from "../../uiStateStore";
import { reorderActiveProjectGroups } from "./activeThreadSort";

interface ProjectGroup {
  key: string;
  label: string;
  children: readonly ReactNode[];
}

function SortableProjectGroup({ group }: { group: ProjectGroup }) {
  const expanded = useUiStateStore((state) =>
    resolveProjectExpanded(state.projectExpandedById, [group.key]),
  );
  const setProjectExpanded = useUiStateStore((state) => state.setProjectExpanded);
  const [showAll, setShowAll] = useState(false);
  const listId = useId();
  const visibleChildren = showAll ? group.children : group.children.slice(0, 5);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: group.key });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={isDragging ? "relative z-20 rounded-md bg-sidebar shadow-lg" : undefined}
    >
      <div className="mt-3 mb-1 flex items-center border-t border-sidebar-border/50 text-xs font-medium text-sidebar-muted-foreground">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-label={`${expanded ? "Collapse" : "Expand"} project ${group.label}`}
          onClick={() => setProjectExpanded(group.key, !expanded)}
          className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          {expanded ? (
            <ChevronDownIcon aria-hidden className="size-3.5 shrink-0" />
          ) : (
            <ChevronRightIcon aria-hidden className="size-3.5 shrink-0" />
          )}
          <FolderIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{group.label}</span>
          <span className="tabular-nums">{group.children.length}</span>
        </button>
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={`Move project ${group.label}`}
          className="touch-none cursor-grab px-2 py-2 hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring active:cursor-grabbing"
        >
          <GripVerticalIcon aria-hidden className="size-3.5 shrink-0" />
        </button>
      </div>
      <ul
        id={listId}
        hidden={!expanded}
        role="presentation"
        className={expanded ? "flex flex-col gap-px" : "hidden"}
      >
        {expanded && visibleChildren}
        {expanded && group.children.length > 5 && (
          <li>
            <button
              type="button"
              onClick={() => setShowAll((value) => !value)}
              className="w-full px-3 py-2 text-left text-xs text-sidebar-muted-foreground hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              {showAll ? "See less" : `See more (${group.children.length - 5})`}
            </button>
          </li>
        )}
      </ul>
    </li>
  );
}

/** A separate sortable context moves whole projects; thread actions stay on their rows. */
export function ActiveProjectGroups({ groups }: { groups: readonly ProjectGroup[] }) {
  const savedOrder = useClientSettings((settings) => settings.sidebarActiveProjectOrder);
  const updateSettings = useUpdateClientSettings();
  const keys = useMemo(() => groups.map((group) => group.key), [groups]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  return (
    <li>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
        onDragEnd={({ active, over }) => {
          if (!over || active.id === over.id) return;
          void updateSettings({
            sidebarActiveProjectOrder: reorderActiveProjectGroups(
              savedOrder,
              keys,
              String(active.id),
              String(over.id),
            ),
          });
        }}
      >
        <SortableContext items={keys} strategy={verticalListSortingStrategy}>
          <ul role="presentation">
            {groups.map((group) => (
              <SortableProjectGroup key={group.key} group={group} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </li>
  );
}
