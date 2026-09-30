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

/** Group already-sorted threads without changing their order within each project. */
export function groupActiveSidebarThreads<T extends ActiveThread>(
  threads: readonly T[],
  groups: ReadonlyMap<string, ActiveThreadProjectGroup>,
  projectOrder: readonly string[] = [],
): (ActiveThreadProjectGroup & { threads: T[] })[] {
  const buckets = new Map<string, ActiveThreadProjectGroup & { threads: T[] }>();
  for (const thread of threads) {
    const group = activeThreadProjectGroup(thread, groups);
    const bucket = buckets.get(group.key);
    if (bucket) bucket.threads.push(thread);
    else buckets.set(group.key, { ...group, threads: [thread] });
  }
  const ranks = new Map(projectOrder.map((key, index) => [key, index]));
  return [...buckets.values()].sort(
    (left, right) =>
      (ranks.get(left.key) ?? projectOrder.length) -
        (ranks.get(right.key) ?? projectOrder.length) ||
      left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: "base" }) ||
      left.key.localeCompare(right.key),
  );
}

/** Preserve saved positions for projects temporarily hidden by an empty Active section. */
export function reorderActiveProjectGroups(
  savedOrder: readonly string[],
  visibleKeys: readonly string[],
  activeKey: string,
  overKey: string,
): string[] {
  const from = visibleKeys.indexOf(activeKey);
  const to = visibleKeys.indexOf(overKey);
  if (from < 0 || to < 0 || from === to) return [...savedOrder];
  const moved = [...visibleKeys];
  moved.splice(from, 1);
  moved.splice(to, 0, activeKey);
  const visible = new Set(visibleKeys);
  let index = 0;
  return [...new Set([...savedOrder, ...visibleKeys])].map((key) =>
    visible.has(key) ? moved[index++]! : key,
  );
}

/** Grouping and thread sorting are independent; saved manual thread positions stay intact. */
export function sortActiveSidebarThreads<T extends ActiveThread>(
  threads: readonly T[],
  order: SidebarActiveSortOrder,
  groups: ReadonlyMap<string, ActiveThreadProjectGroup>,
  options: { groupByProject?: boolean; projectOrder?: readonly string[] } = {},
): T[] {
  const sorted =
    order === "manual"
      ? sortActiveThreadsByOrderKey(threads)
      : threads.toSorted(
          (left, right) =>
            getThreadSortTimestamp(right, order === "created_at" ? "created_at" : "updated_at") -
              getThreadSortTimestamp(left, order === "created_at" ? "created_at" : "updated_at") ||
            left.environmentId.localeCompare(right.environmentId) ||
            left.id.localeCompare(right.id),
        );
  return options.groupByProject || order === "project"
    ? groupActiveSidebarThreads(sorted, groups, options.projectOrder).flatMap(
        (group) => group.threads,
      )
    : sorted;
}
