// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";
import { useUiStateStore } from "../../uiStateStore";
import { ActiveProjectGroups } from "./ActiveProjectGroups";

vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: { sidebarActiveProjectOrder: string[] }) => unknown) =>
    select({ sidebarActiveProjectOrder: [] }),
  useUpdateClientSettings: () => vi.fn(),
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useUiStateStore.setState({ projectExpandedById: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
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
async function render(
  renderedGroups: Parameters<typeof ActiveProjectGroups>[0]["groups"] = groups,
) {
  await act(async () =>
    root.render(
      <ul>
        <ActiveProjectGroups groups={renderedGroups} />
      </ul>,
    ),
  );
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.getAttribute("aria-label") === label || item.textContent === label,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
it("limits each project to five threads, reveals the rest, and retains thread actions", async () => {
  await render();
  expect(container.querySelectorAll("[data-thread]")).toHaveLength(5);
  await click("See more (3)");
  expect(container.querySelectorAll("[data-thread]")).toHaveLength(8);
  expect(
    [...container.querySelectorAll("button")].filter((item) => item.textContent === "Settle"),
  ).toHaveLength(8);
  await click("See less");
  expect(container.querySelectorAll("[data-thread]")).toHaveLength(5);
});
it("persists folding independently of dragging and restores it when remounted", async () => {
  await render();
  expect(container.querySelector('[aria-label="Move project Example"]')).not.toBeNull();
  await click("Collapse project Example");
  expect(container.querySelectorAll("[data-thread]")).toHaveLength(0);
  expect(useUiStateStore.getState().projectExpandedById["repository:example"]).toBe(false);
  await act(async () => root.render(null));
  await render();
  expect(
    container.querySelector('[aria-label="Expand project Example"]')?.getAttribute("aria-expanded"),
  ).toBe("false");
  await click("Expand project Example");
  expect(container.querySelectorAll("[data-thread]")).toHaveLength(5);
});
it("keeps the most urgent thread status on the folder header while collapsed", async () => {
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
  await render([{ ...groups[0]!, statusThreads }]);
  expect(
    container.querySelector('[aria-label="Collapse project Example, Working"]'),
  ).not.toBeNull();
  await click("Collapse project Example, Working");
  expect(container.querySelectorAll("[data-thread]")).toHaveLength(0);
  expect(container.querySelector('[aria-label="Expand project Example, Working"]')).not.toBeNull();
});
