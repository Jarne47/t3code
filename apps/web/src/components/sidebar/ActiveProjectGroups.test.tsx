// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
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
  },
];
async function render() {
  await act(async () =>
    root.render(
      <ul>
        <ActiveProjectGroups groups={groups} />
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
