// @effect-diagnostics nodeBuiltinImport:off - Tests exercise the native installer boundary with disposable filesystem fixtures.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PERSONAL_DESKTOP_FORK } from "@t3tools/shared/personalDesktopFork";
import { PersonalUpdater } from "./PersonalUpdater.ts";
import { selectPersonalRelease } from "./personalRelease.ts";
import { spawnDetached } from "./personalInstall.ts";

vi.mock("./personalInstall.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./personalInstall.ts")>()),
  spawnDetached: vi.fn(async () => {}),
}));

const current = "0.0.46-itamar.20261003.2";
const next = "0.0.46-itamar.20261003.10";
const bytes = Buffer.from("personal installer fixture");
function release(version = next, extension = "exe", arch = "x64") {
  const name = `T3-Code-${version}-${arch}.${extension}`;
  return {
    tag_name: `v${version}`,
    draft: false,
    body: "Release notes",
    assets: [
      {
        name,
        browser_download_url: `${PERSONAL_DESKTOP_FORK.releasesUrl}/download/v${version}/${name}`,
        size: bytes.length,
        digest: `sha256:${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}`,
      },
    ],
  };
}

describe("personal releases", () => {
  it("selects the newest personal version numerically, excluding drafts and official builds", () => {
    const selected = selectPersonalRelease(
      [
        release(current),
        release(),
        release("9.0.0"),
        { ...release("1.0.0-itamar.20261004.1"), draft: true },
      ],
      current,
      "win32",
      "x64",
    );
    expect(selected?.version).toBe(next);
    expect(selectPersonalRelease([release(current)], current, "win32", "x64")).toBeNull();
    expect(selectPersonalRelease([release(current)], next, "win32", "x64")).toBeNull();
    expect(
      selectPersonalRelease([release(next, "zip", "arm64")], current, "darwin", "arm64")?.url,
    ).toContain("arm64.zip");
  });
  it("rejects missing platform packages and invalid integrity metadata", () => {
    expect(() => selectPersonalRelease([release()], current, "darwin", "arm64")).toThrow(
      "installer yet",
    );
    for (const replacement of [
      { digest: null },
      { size: 0 },
      { browser_download_url: "https://example.com/installer.exe" },
    ]) {
      const item = release();
      expect(() =>
        selectPersonalRelease(
          [{ ...item, assets: [{ ...item.assets[0], ...replacement }] }],
          current,
          "win32",
          "x64",
        ),
      ).toThrow("integrity metadata");
    }
  });
});

describe("PersonalUpdater", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-update-test-"));
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  });
  function setup(body = bytes) {
    const quit = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      url === PERSONAL_DESKTOP_FORK.releasesApiUrl
        ? Response.json([release()])
        : new Response(body),
    );
    const updater = new PersonalUpdater({
      version: current,
      platform: "win32",
      arch: "x64",
      executable: "D:\\My Apps\\T3 Code (Itamar)\\T3 Code (Itamar).exe",
      cacheDirectory: directory,
      fetch,
      quit,
    });
    return { updater, quit, fetch };
  }
  it("downloads verified bytes and installs into the running app's custom directory before quitting", async () => {
    const { updater, quit, fetch } = setup();
    const progress = vi.fn();
    updater.on("download-progress", progress);
    await updater.checkForUpdates();
    await updater.downloadUpdate();
    await updater.checkForUpdates(); // A background check keeps the downloaded version actionable.
    expect(fetch).toHaveBeenCalledTimes(2);
    await updater.quitAndInstall(true, true);
    const [installer, args] = vi.mocked(spawnDetached).mock.calls[0]!;
    expect(await NodeFSP.readFile(installer)).toEqual(bytes);
    expect(args).toEqual(["--updated", "/S", "--force-run", "/D=D:\\My Apps\\T3 Code (Itamar)"]);
    expect(progress).toHaveBeenLastCalledWith({ percent: 100 });
    expect(quit).toHaveBeenCalledOnce();
  });
  it.each([Buffer.from("truncated"), Buffer.alloc(bytes.length), Buffer.alloc(bytes.length + 1)])(
    "rejects corrupt downloads without exposing an install action",
    async (body) => {
      const { updater, quit } = setup(body);
      const downloaded = vi.fn();
      updater.on("update-downloaded", downloaded);
      await updater.checkForUpdates();
      await expect(updater.downloadUpdate()).rejects.toThrow();
      expect(await NodeFSP.readdir(directory)).toEqual([]);
      expect(downloaded).not.toHaveBeenCalled();
      expect(quit).not.toHaveBeenCalled();
    },
  );
  it("rechecks cached bytes before launching an installer", async () => {
    const { updater, quit } = setup();
    await updater.checkForUpdates();
    await updater.downloadUpdate();
    const [download] = await NodeFSP.readdir(directory);
    await NodeFSP.writeFile(NodePath.join(directory, download!, "update.exe"), "modified");
    await expect(updater.quitAndInstall(true, true)).rejects.toThrow("changed");
    expect(spawnDetached).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });
  it("keeps the current app running when the installer cannot launch", async () => {
    const { updater, quit } = setup();
    await updater.checkForUpdates();
    await updater.downloadUpdate();
    vi.mocked(spawnDetached).mockRejectedValueOnce(new Error("spawn failed"));
    await expect(updater.quitAndInstall(true, true)).rejects.toThrow("spawn failed");
    expect(quit).not.toHaveBeenCalled();
  });
});
