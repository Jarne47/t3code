// @vitest-environment jsdom

import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import {
  DEFAULT_RESOLVED_KEYBINDINGS,
  compileResolvedKeybindingsConfig,
  mergeWithDefaultKeybindings,
} from "@t3tools/shared/keybindings";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { useFavoriteModelShortcut } from "./useFavoriteModelShortcut";

type Input = Parameters<typeof useFavoriteModelShortcut>[0];
const codex = ProviderInstanceId.make("codex");
const work = ProviderInstanceId.make("codex_work");
const claude = ProviderInstanceId.make("claudeAgent");

function entry(instanceId: ProviderInstanceId, driver: string, groupKey = "codex") {
  const snapshot: ServerProvider = {
    instanceId,
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    status: "ready",
    version: null,
    auth: { status: "authenticated" },
    checkedAt: "2026-10-14T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  return { ...deriveProviderInstanceEntries([snapshot])[0]!, continuationGroupKey: groupKey };
}

let root: Root;
let container: HTMLDivElement;
let input: Omit<Input, "onSelect">;

function Composer() {
  const [model, setModel] = useState("original");
  useFavoriteModelShortcut({
    ...input,
    onSelect: (instanceId, model) => setModel(`${instanceId}:${model}`),
  });
  return (
    <>
      <div contentEditable suppressContentEditableWarning data-testid="editor">
        unfinished prompt
      </div>
      <output>{model}</output>
    </>
  );
}

async function render(overrides: Partial<typeof input> = {}) {
  input = { ...input, ...overrides };
  await act(() => root.render(<Composer />));
}

async function jump(number: number, overrides: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: String(number),
    code: `Digit${number}`,
    ctrlKey: true,
    altKey: true,
    bubbles: true,
    cancelable: true,
    ...overrides,
  });
  await act(() => document.activeElement!.dispatchEvent(event));
  return event;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  input = {
    enabled: true,
    favorites: [
      { provider: work, model: "same" },
      { provider: codex, model: "second" },
      { provider: claude, model: "sonnet" },
      { provider: codex, model: "same" },
    ],
    instanceEntries: [entry(codex, "codex"), entry(work, "codex"), entry(claude, "claudeAgent")],
    modelOptionsByInstance: new Map([
      [work, [{ slug: "same", name: "Work model" }]],
      [claude, [{ slug: "sonnet", name: "Sonnet" }]],
      [
        codex,
        [
          { slug: "same", name: "First model" },
          { slug: "second", name: "Second model" },
        ],
      ],
    ]),
    lockedProvider: null,
    lockedContinuationGroupKey: null,
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    terminalOpen: false,
    getModelDisabledReason: () => null,
  };
  await render();
  container.querySelector<HTMLElement>("[data-testid=editor]")!.focus();
});

afterEach(async () => {
  await act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("favorite model shortcuts", () => {
  it("selects favorites in picker order while retaining the editor's text, focus, and caret", async () => {
    const editor = document.activeElement!;
    const range = document.createRange();
    range.setStart(editor.firstChild!, 4);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    for (const [number, model] of [
      [1, "codex:same"],
      [2, "codex:second"],
      [3, "codex_work:same"],
    ] as const) {
      expect((await jump(number)).defaultPrevented).toBe(true);
      expect(container.querySelector("output")!.textContent).toBe(model);
      expect(document.activeElement).toBe(editor);
      expect(editor.textContent).toBe("unfinished prompt");
      expect(selection.anchorOffset).toBe(4);
    }
  });

  it("skips stale, unavailable, disabled, and incompatible favorites", async () => {
    await render({
      favorites: [
        ...input.favorites,
        { provider: codex, model: "missing" },
        { provider: codex, model: "blocked" },
      ],
      instanceEntries: [
        entry(codex, "codex"),
        entry(work, "codex", "other"),
        { ...entry(claude, "claudeAgent"), enabled: false },
      ],
      modelOptionsByInstance: new Map([
        ...input.modelOptionsByInstance,
        [
          codex,
          [
            { slug: "same", name: "Unavailable", isUnavailable: true },
            { slug: "blocked", name: "Blocked" },
            { slug: "second", name: "Second" },
          ],
        ],
      ]),
      lockedProvider: ProviderDriverKind.make("codex"),
      lockedContinuationGroupKey: "codex",
      getModelDisabledReason: (_, model) => (model === "blocked" ? "Locked" : null),
    });
    expect((await jump(1)).defaultPrevented).toBe(true);
    expect(container.querySelector("output")!.textContent).toBe("codex:second");
    await jump(2);
    expect(container.querySelector("output")!.textContent).toBe("codex:second");
  });

  it.each([
    "data-model-picker-content",
    "data-command-palette",
    "data-terminal-owner",
    "data-preview-panel-mode",
  ])("leaves shortcuts to the surface owning %s", async (attribute) => {
    const surface = document.createElement("textarea");
    surface.setAttribute(attribute, attribute === "data-terminal-owner" ? "drawer" : "true");
    document.body.append(surface);
    surface.focus();
    expect((await jump(1)).defaultPrevented).toBe(false);
    expect(container.querySelector("output")!.textContent).toBe("original");
  });

  it("ignores key repeats, composition, and disabled controls", async () => {
    expect((await jump(1, { repeat: true })).defaultPrevented).toBe(false);
    expect((await jump(1, { isComposing: true })).defaultPrevented).toBe(false);
    await render({ enabled: false });
    expect((await jump(1)).defaultPrevented).toBe(false);
    expect(container.querySelector("output")!.textContent).toBe("original");
  });

  it("honors custom shortcut conflicts", async () => {
    await render({
      keybindings: mergeWithDefaultKeybindings(
        compileResolvedKeybindingsConfig([{ key: "ctrl+alt+1", command: "chat.new" }]),
      ),
    });
    expect((await jump(1)).defaultPrevented).toBe(false);
    expect(container.querySelector("output")!.textContent).toBe("original");
  });

  it.each([undefined, "modelPickerOpen"])(
    "works with an existing picker shortcut scoped to %s",
    async (when) => {
      await render({
        keybindings: mergeWithDefaultKeybindings(
          compileResolvedKeybindingsConfig([
            { key: "ctrl+alt+1", command: "modelPicker.jump.1", ...(when ? { when } : {}) },
          ]),
        ),
      });
      expect((await jump(1)).defaultPrevented).toBe(true);
      expect(container.querySelector("output")!.textContent).toBe("codex:same");
    },
  );
});
