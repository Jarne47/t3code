import { describe, expect, it } from "vite-plus/test";
import {
  activeThreadProjectGroup,
  reorderActiveProjectGroups,
  sortActiveSidebarThreads,
} from "./activeThreadSort";

const groups = new Map([
  ["local:a", { key: "alpha", label: "Alpha" }],
  ["local:a-worktree", { key: "alpha", label: "Alpha" }],
  ["local:b", { key: "beta", label: "Beta" }],
  ["remote:a", { key: "remote-alpha", label: "Alpha" }],
]);
const thread = (
  id: string,
  overrides: Partial<{
    environmentId: string;
    projectId: string;
    createdAt: string;
    updatedAt: string;
    latestUserMessageAt: string | null;
    activeOrderKey: string;
  }> = {},
) => ({
  id,
  environmentId: "local",
  projectId: "a",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  latestUserMessageAt: null,
  ...overrides,
});
const ids = (rows: readonly ReturnType<typeof thread>[]) => rows.map((row) => row.id);

describe("active sidebar sorting", () => {
  it("sorts by user messages rather than background updates or saved manual positions", () => {
    const rows = [
      thread("old", {
        latestUserMessageAt: "2026-09-02T00:00:00Z",
        updatedAt: "2026-09-29T00:00:00Z",
        activeOrderKey: "a",
      }),
      thread("recent", { latestUserMessageAt: "2026-09-20T00:00:00Z", activeOrderKey: "z" }),
      thread("fallback", { updatedAt: "2026-09-10T00:00:00Z" }),
    ];
    expect(ids(sortActiveSidebarThreads(rows, "updated_at", groups))).toEqual([
      "recent",
      "fallback",
      "old",
    ]);
    expect(ids(rows)).toEqual(["old", "recent", "fallback"]);
    expect(rows[0]?.activeOrderKey).toBe("a");
  });

  it("keeps logical project worktrees together, sorts groups alphabetically and messages newest first", () => {
    const rows = [
      thread("beta", { projectId: "b", latestUserMessageAt: "2026-09-29T00:00:00Z" }),
      thread("alpha-old"),
      thread("alpha-worktree", {
        projectId: "a-worktree",
        latestUserMessageAt: "2026-09-20T00:00:00Z",
      }),
      thread("other-machine", {
        environmentId: "remote",
        latestUserMessageAt: "2026-09-25T00:00:00Z",
      }),
    ];
    expect(ids(sortActiveSidebarThreads(rows, "project", groups))).toEqual([
      "alpha-worktree",
      "alpha-old",
      "other-machine",
      "beta",
    ]);
  });

  it("restores the manual order after visiting an automatic view", () => {
    const rows = [
      thread("second", { activeOrderKey: "z" }),
      thread("first", { activeOrderKey: "a" }),
    ];
    sortActiveSidebarThreads(rows, "project", groups);
    expect(ids(sortActiveSidebarThreads(rows, "manual", groups))).toEqual(["first", "second"]);
  });

  it("sorts by creation independently of recent messages", () => {
    const rows = [
      thread("old", { latestUserMessageAt: "2026-09-29T00:00:00Z" }),
      thread("new", { createdAt: "2026-09-20T00:00:00Z" }),
    ];
    expect(ids(sortActiveSidebarThreads(rows, "created_at", groups))).toEqual(["new", "old"]);
  });

  it("keeps unknown projects separate and gives equal timestamps a deterministic order", () => {
    const rows = [
      thread("b", { projectId: "missing" }),
      thread("a", { projectId: "missing" }),
      thread("c", { projectId: "another" }),
    ];
    expect(activeThreadProjectGroup(rows[0]!, groups)).toEqual({
      key: "local:missing",
      label: "Unavailable project",
    });
    expect(ids(sortActiveSidebarThreads(rows, "project", groups))).toEqual(["c", "a", "b"]);
    expect(ids(sortActiveSidebarThreads(rows.toReversed(), "project", groups))).toEqual([
      "c",
      "a",
      "b",
    ]);
  });
});

describe("active project grouping", () => {
  const rows = [
    thread("alpha-old", { activeOrderKey: "a" }),
    thread("beta", { projectId: "b", activeOrderKey: "b", createdAt: "2026-09-15T00:00:00Z" }),
    thread("alpha-new", {
      projectId: "a-worktree",
      activeOrderKey: "c",
      createdAt: "2026-09-20T00:00:00Z",
    }),
  ];
  const options = { groupByProject: true, projectOrder: ["beta", "alpha"] };

  it("uses custom project order with either manual or automatic thread sorting", () => {
    expect(ids(sortActiveSidebarThreads(rows, "manual", groups, options))).toEqual([
      "beta",
      "alpha-old",
      "alpha-new",
    ]);
    expect(ids(sortActiveSidebarThreads(rows, "created_at", groups, options))).toEqual([
      "beta",
      "alpha-new",
      "alpha-old",
    ]);
    expect(ids(sortActiveSidebarThreads(rows, "manual", groups))).toEqual([
      "alpha-old",
      "beta",
      "alpha-new",
    ]);
  });

  it("puts newly appearing groups after the saved order without losing their threads", () => {
    expect(
      ids(
        sortActiveSidebarThreads(rows, "manual", groups, {
          groupByProject: true,
          projectOrder: ["missing", "beta"],
        }),
      ),
    ).toEqual(["beta", "alpha-old", "alpha-new"]);
  });

  it("reorders visible projects while preserving the positions of hidden projects", () => {
    expect(
      reorderActiveProjectGroups(
        ["alpha", "hidden", "beta"],
        ["alpha", "beta", "new"],
        "new",
        "alpha",
      ),
    ).toEqual(["new", "hidden", "alpha", "beta"]);
    expect(reorderActiveProjectGroups([], ["alpha", "beta"], "beta", "alpha")).toEqual([
      "beta",
      "alpha",
    ]);
    expect(
      reorderActiveProjectGroups(["alpha", "beta"], ["alpha", "beta"], "missing", "alpha"),
    ).toEqual(["alpha", "beta"]);
  });
});
