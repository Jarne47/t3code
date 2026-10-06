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
import { cn } from "../../lib/utils";
import { resolveProjectExpanded, useUiStateStore } from "../../uiStateStore";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import {
  resolveSidebarV2GroupStatus,
  resolveThreadLastVisitedAt,
  SIDEBAR_V2_TOP_STATUS_PRESENTATION,
  type SidebarV2StatusThread,
} from "../Sidebar.logic";
import { reorderActiveProjectGroups } from "./activeThreadSort";
import { SidebarV2StatusIcon } from "./SidebarV2StatusIcon";

interface ProjectGroup {
  key: string;
  label: string;
  // Missing for threads whose project is unavailable; those keep a plain folder icon.
  project?: ProjectFaviconProject | null | undefined;
  children: readonly ReactNode[];
  /** Every thread in the folder, including rows behind "See more", for the header status. */
  statusThreads: readonly {
    readonly key: string;
    readonly thread: SidebarV2StatusThread;
    readonly wokeAt: string | null;
  }[];
}

function SortableProjectGroup({ group }: { group: ProjectGroup }) {
  const expanded = useUiStateStore((state) =>
    resolveProjectExpanded(state.projectExpandedById, [group.key]),
  );
  const setProjectExpanded = useUiStateStore((state) => state.setProjectExpanded);
  // Shown expanded and collapsed alike, so a folded project still says it needs you.
  const statusKind = useUiStateStore((state) =>
    resolveSidebarV2GroupStatus(
      group.statusThreads.map(({ key, thread, wokeAt }) => ({
        thread,
        wokeAt,
        lastVisitedAt: resolveThreadLastVisitedAt(
          thread.lastVisitedAt,
          state.threadLastVisitedAtById[key],
        ),
      })),
    ),
  );
  const status = statusKind === null ? null : SIDEBAR_V2_TOP_STATUS_PRESENTATION[statusKind];
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
          aria-label={`${expanded ? "Collapse" : "Expand"} project ${group.label}${
            status ? `, ${status.label}` : ""
          }`}
          onClick={() => setProjectExpanded(group.key, !expanded)}
          className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          {expanded ? (
            <ChevronDownIcon aria-hidden className="size-3.5 shrink-0" />
          ) : (
            <ChevronRightIcon aria-hidden className="size-3.5 shrink-0" />
          )}
          {group.project ? (
            <ProjectFavicon project={group.project} className="size-3.5 shrink-0" />
          ) : (
            <FolderIcon aria-hidden className="size-3.5 shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate">{group.label}</span>
          {statusKind !== null && status !== null ? (
            <span className={cn("inline-flex shrink-0 items-center gap-1", status.className)}>
              <SidebarV2StatusIcon kind={statusKind} className="size-3.5 shrink-0" />
              {status.label}
            </span>
          ) : null}
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
