import { useMemo, type ReactNode } from "react";
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
import { FolderIcon, GripVerticalIcon } from "lucide-react";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { reorderActiveProjectGroups } from "./activeThreadSort";

interface ProjectGroup {
  key: string;
  label: string;
  children: ReactNode;
}

function SortableProjectGroup({ group }: { group: ProjectGroup }) {
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
      <button
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`Move project ${group.label}`}
        className="mt-3 mb-1 flex w-full touch-none cursor-grab items-center gap-2 border-t border-sidebar-border/50 px-2 py-2 text-left text-xs font-medium text-sidebar-muted-foreground hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring active:cursor-grabbing"
      >
        <FolderIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{group.label}</span>
        <GripVerticalIcon aria-hidden className="size-3.5 shrink-0" />
      </button>
      <ul role="presentation" className="flex flex-col gap-px">
        {group.children}
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
