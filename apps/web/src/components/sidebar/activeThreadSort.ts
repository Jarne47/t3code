import type { SidebarActiveSortOrder } from "@t3tools/contracts/settings";
import {
  getThreadSortTimestamp,
  sortActiveThreadsByOrderKey,
  type ThreadSortInput,
} from "@t3tools/client-runtime/state/thread-sort";

type ActiveThread = ThreadSortInput & {
  readonly id: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly activeOrderKey?: string | null | undefined;
  readonly unsettledAt?: string | null | undefined;
};

export interface ActiveThreadProjectGroup {
  readonly key: string;
  readonly label: string;
}

export function activeThreadProjectGroup(
  thread: Pick<ActiveThread, "environmentId" | "projectId">,
  groups: ReadonlyMap<string, ActiveThreadProjectGroup>,
): ActiveThreadProjectGroup {
  const key = `${thread.environmentId}:${thread.projectId}`;
  return groups.get(key) ?? { key, label: "Unavailable project" };
}

/** Automatic views leave the saved manual order intact; project groups use recency within each group. */
export function sortActiveSidebarThreads<T extends ActiveThread>(
  threads: readonly T[],
  order: SidebarActiveSortOrder,
  groups: ReadonlyMap<string, ActiveThreadProjectGroup>,
): T[] {
  if (order === "manual") return sortActiveThreadsByOrderKey(threads);
  return threads
    .map((thread) => ({
      thread,
      group: activeThreadProjectGroup(thread, groups),
      timestamp: getThreadSortTimestamp(
        thread,
        order === "created_at" ? "created_at" : "updated_at",
      ),
    }))
    .sort(
      (left, right) =>
        (order === "project"
          ? left.group.label.localeCompare(right.group.label, undefined, {
              numeric: true,
              sensitivity: "base",
            }) || left.group.key.localeCompare(right.group.key)
          : 0) ||
        right.timestamp - left.timestamp ||
        left.thread.environmentId.localeCompare(right.thread.environmentId) ||
        left.thread.id.localeCompare(right.thread.id),
    )
    .map(({ thread }) => thread);
}
