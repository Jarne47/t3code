import { msg } from "gt-react";
// Helpers only the fork's legacy project tree uses; upstream removed that sidebar and these with it.
import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import type { SidebarProjectSortOrder } from "@t3tools/contracts/settings";
import type { ThreadSortInput } from "@t3tools/client-runtime/state/thread-sort";

import { desktopLocalBackendId } from "../connection/desktopLocal";
import type { ContextMenuItem } from "@t3tools/contracts";
import type { Thread } from "../types";
import { sortProjectsByActivity, type ThreadStatusPill } from "./Sidebar.logic";

const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";
const SIDEBAR_THREAD_PREWARM_LIMIT = 3;
// Status labels are msg() strings, so key by the same messages.
const THREAD_STATUS_PRIORITY: Record<string, number> = {
  [msg("Pending Approval")]: 5,
  [msg("Awaiting Input")]: 4,
  [msg("Guest Request")]: 3.75,
  [msg("Failed")]: 3.5,
  [msg("Working")]: 3,
  [msg("Connecting")]: 3,
  [msg("Waiting")]: 2.5,
  [msg("Plan Ready")]: 2,
  [msg("Completed")]: 1,
};

export function isWslConnectionTarget(target: ConnectionTarget): boolean {
  return desktopLocalBackendId(target)?.startsWith("wsl:") === true;
}

export async function archiveSelectedThreadEntries<
  TEntry extends { readonly threadKey: string },
  TResult extends { readonly _tag: "Success" | "Failure" },
>(input: {
  entries: readonly TEntry[];
  archive: (entry: TEntry, onArchived: () => void) => Promise<TResult>;
}): Promise<{
  archivedThreadKeys: readonly string[];
  mutationFailure: Extract<TResult, { readonly _tag: "Failure" }> | null;
  followupFailures: readonly Extract<TResult, { readonly _tag: "Failure" }>[];
}> {
  const archivedThreadKeys: string[] = [];
  const followupFailures: Extract<TResult, { readonly _tag: "Failure" }>[] = [];

  for (const entry of input.entries) {
    let didArchive = false;
    const result = await input.archive(entry, () => {
      didArchive = true;
    });
    if (didArchive || result._tag === "Success") archivedThreadKeys.push(entry.threadKey);
    if (result._tag === "Success") continue;
    const failure = result as Extract<TResult, { readonly _tag: "Failure" }>;
    if (didArchive) {
      followupFailures.push(failure);
      continue;
    }
    return { archivedThreadKeys, mutationFailure: failure, followupFailures };
  }

  return { archivedThreadKeys, mutationFailure: null, followupFailures };
}

export function buildMultiSelectThreadContextMenuItems(input: {
  count: number;
  hasRunningThread: boolean;
}): readonly ContextMenuItem<"mark-unread" | "archive" | "delete">[] {
  return [
    { id: "mark-unread", label: `Mark unread (${input.count})` },
    {
      id: "archive",
      label: `Archive (${input.count})`,
      disabled: input.hasRunningThread,
    },
    { id: "delete", label: `Delete (${input.count})`, destructive: true },
  ];
}

export function getSidebarThreadIdsToPrewarm<TThreadId>(
  visibleThreadIds: readonly TThreadId[],
  limit = SIDEBAR_THREAD_PREWARM_LIMIT,
): TThreadId[] {
  return visibleThreadIds.slice(0, Math.max(0, limit));
}

export function isContextMenuPointerDown(input: {
  button: number;
  ctrlKey: boolean;
  isMac: boolean;
}): boolean {
  if (input.button === 2) return true;
  return input.isMac && input.button === 0 && input.ctrlKey;
}

export function resolveProjectStatusIndicator(
  statuses: ReadonlyArray<ThreadStatusPill | null>,
): ThreadStatusPill | null {
  let highestPriorityStatus: ThreadStatusPill | null = null;

  for (const status of statuses) {
    if (status === null) continue;
    if (
      highestPriorityStatus === null ||
      (THREAD_STATUS_PRIORITY[status.label] ?? 0) >
        (THREAD_STATUS_PRIORITY[highestPriorityStatus.label] ?? 0)
    ) {
      highestPriorityStatus = status;
    }
  }

  return highestPriorityStatus;
}

export function shouldClearThreadSelectionOnMouseDown(target: HTMLElement | null): boolean {
  if (target === null) return true;
  return !target.closest(THREAD_SELECTION_SAFE_SELECTOR);
}

export function sortProjectsForSidebar<
  TProject extends {
    id: string;
    title: string;
    createdAt?: string | undefined;
    updatedAt?: string | undefined;
  },
  TThread extends Pick<Thread, "projectId" | "createdAt" | "updatedAt"> & ThreadSortInput,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  const threadsByProjectId = new Map<string, TThread[]>();
  for (const thread of threads) {
    const existing = threadsByProjectId.get(thread.projectId) ?? [];
    existing.push(thread);
    threadsByProjectId.set(thread.projectId, existing);
  }

  return sortProjectsByActivity(
    projects,
    sortOrder,
    (project) => threadsByProjectId.get(project.id) ?? [],
    (left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id),
  );
}
