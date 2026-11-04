import { ProviderInstanceId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { useUiStateStore } from "../../uiStateStore";
import { ActiveProjectGroups } from "./ActiveProjectGroups";

vi.mock("../../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useSettings")>()),
  useClientSettings: (select: (settings: { sidebarActiveProjectOrder: string[] }) => unknown) =>
    select({ sidebarActiveProjectOrder: [] }),
}));

const groups = [
  {
    key: "repository:example",
    label: "Example",
    children: Array.from({ length: 8 }, (_, i) => (
      <li key={i} data-thread={i}>
        Thread {i + 1}
        <button>Settle</button>
      </li>
    )),
    statusThreads: [],
  },
];

const resetFolding = () => useUiStateStore.setState({ projectExpandedById: {} });

const view = (renderedGroups: Parameters<typeof ActiveProjectGroups>[0]["groups"] = groups) => (
  <ul>
    <ActiveProjectGroups groups={renderedGroups} />
  </ul>
);

async function click(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.getAttribute("aria-label") === label || item.textContent === label,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

it("limits each project to five threads, reveals the rest, and retains thread actions", async () => {
  resetFolding();
  await using screen = await render(view());
  const { container } = screen;
  expect(container.querySelectorAll("[data-thread]")).toHaveLength(5);
  await click(container, "See more (3)");
  expect(container.querySelectorAll("[data-thread]")).toHaveLength(8);
  expect(
    [...container.querySelectorAll("button")].filter((item) => item.textContent === "Settle"),
  ).toHaveLength(8);
  await click(container, "See less");
  expect(container.querySelectorAll("[data-thread]")).toHaveLength(5);
});

it("persists folding independently of dragging and restores it when remounted", async () => {
  resetFolding();
  await using screen = await render(view());
  const { container } = screen;
  expect(container.querySelector('[aria-label="Move project Example"]')).not.toBeNull();
  await click(container, "Collapse project Example");
  expect(container.querySelectorAll("[data-thread]")).toHaveLength(0);
  expect(useUiStateStore.getState().projectExpandedById["repository:example"]).toBe(false);
  await screen.rerender(null);
  await screen.rerender(view());
  expect(
    container.querySelector('[aria-label="Expand project Example"]')?.getAttribute("aria-expanded"),
  ).toBe("false");
  await click(container, "Expand project Example");
  expect(container.querySelectorAll("[data-thread]")).toHaveLength(5);
});

it("keeps the most urgent thread status on the folder header while collapsed", async () => {
  resetFolding();
  const quiet = {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    latestRun: null,
    runtime: null,
  };
  const working = {
    ...quiet,
    runtime: {
      status: "running" as const,
      activeRunId: null,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: "Codex",
      lastError: null,
      updatedAt: "2026-03-09T10:00:00.000Z",
    },
  };
  // The working thread sits beyond the five visible rows.
  const statusThreads = [quiet, quiet, quiet, quiet, quiet, working].map((thread, index) => ({
    key: `thread-${index}`,
    thread,
    wokeAt: null,
  }));
  await using screen = await render(view([{ ...groups[0]!, statusThreads }]));
  const { container } = screen;
  expect(
    container.querySelector('[aria-label="Collapse project Example, Working"]'),
  ).not.toBeNull();
  await click(container, "Collapse project Example, Working");
  expect(container.querySelectorAll("[data-thread]")).toHaveLength(0);
  expect(container.querySelector('[aria-label="Expand project Example, Working"]')).not.toBeNull();
});
