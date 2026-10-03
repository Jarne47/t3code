// @effect-diagnostics nodeBuiltinImport:off - Promise/event boundary adapted to the existing Electron updater service.
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { PERSONAL_DESKTOP_FORK } from "@t3tools/shared/personalDesktopFork";
import { selectPersonalRelease, type PersonalRelease } from "./personalRelease.ts";
import {
  prepareMacUpdate,
  startMacInstall,
  spawnDetached,
  windowsInstallArguments,
} from "./personalInstall.ts";

interface PersonalUpdaterOptions {
  version: string;
  platform: string;
  arch: string;
  executable: string;
  cacheDirectory: string;
  fetch: typeof globalThis.fetch;
  quit: () => void;
}

/** Reuses DesktopUpdates' action locking, progress, backend shutdown and UI. */
export class PersonalUpdater extends NodeEvents.EventEmitter {
  channel = "latest";
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowPrerelease = false;
  allowDowngrade = false;
  fullChangelog = false;
  disableDifferentialDownload = true;
  private candidate: PersonalRelease | null = null;
  private downloaded: {
    release: PersonalRelease;
    file: string;
    directory: string;
  } | null = null;

  private readonly options: PersonalUpdaterOptions;
  constructor(options: PersonalUpdaterOptions) {
    super();
    this.options = options;
  }
  // This driver has one fixed repository; official channel/feed settings cannot redirect it.
  setFeedURL(_options: unknown): void {}

  async checkForUpdates(): Promise<void> {
    this.emit("checking-for-update");
    if (this.downloaded) {
      this.emit("update-available", this.downloaded.release);
      return;
    }
    const response = await this.options.fetch(PERSONAL_DESKTOP_FORK.releasesApiUrl, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Personal release check failed (HTTP ${response.status}).`);
    this.candidate = selectPersonalRelease(
      await response.json(),
      this.options.version,
      this.options.platform,
      this.options.arch,
    );
    this.emit(this.candidate ? "update-available" : "update-not-available", this.candidate);
  }

  async downloadUpdate(): Promise<void> {
    const release = this.candidate;
    if (!release) throw new Error("Check for an update before downloading.");
    // Keep one download per installation instead of accumulating old installers.
    const directory = NodePath.join(this.options.cacheDirectory, "download");
    await NodeFSP.rm(directory, { recursive: true, force: true });
    await NodeFSP.mkdir(directory, { recursive: true });
    const file = NodePath.join(
      directory,
      this.options.platform === "darwin" ? "update.zip" : "update.exe",
    );
    try {
      const response = await this.options.fetch(release.url, {
        signal: AbortSignal.timeout(15 * 60_000),
      });
      if (!response.ok || !response.body)
        throw new Error(`Installer download failed (HTTP ${response.status}).`);
      const hash = NodeCrypto.createHash("sha256");
      let received = 0;
      const handle = await NodeFSP.open(file, "wx");
      try {
        for await (const chunk of response.body) {
          received += chunk.byteLength;
          if (received > release.size) throw new Error("The installer exceeds its declared size.");
          hash.update(chunk);
          await handle.writeFile(chunk);
          this.emit("download-progress", { percent: (received / release.size) * 100 });
        }
      } finally {
        await handle.close();
      }
      if (received !== release.size || hash.digest("hex") !== release.sha256)
        throw new Error("Installer checksum verification failed. Please download again.");
      this.downloaded = { release, file, directory };
      this.emit("update-downloaded", release);
    } catch (error) {
      await NodeFSP.rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async quitAndInstall(_silent: boolean, restart: boolean): Promise<void> {
    const downloaded = this.downloaded;
    if (!downloaded) throw new Error("Download the update before installing.");
    // A cached file is not trusted merely because an earlier download passed.
    const hash = NodeCrypto.createHash("sha256");
    const handle = await NodeFSP.open(downloaded.file, "r");
    try {
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    } finally {
      await handle.close();
    }
    if (hash.digest("hex") !== downloaded.release.sha256)
      throw new Error("The downloaded installer changed. Download it again before installing.");
    if (this.options.platform === "darwin") {
      const prepared = await prepareMacUpdate(
        downloaded.file,
        this.options.executable,
        downloaded.release.version,
      );
      try {
        await startMacInstall(prepared, downloaded.directory, restart);
      } catch (error) {
        await NodeFSP.rm(prepared.stage, { recursive: true, force: true });
        throw error;
      }
    } else if (this.options.platform === "win32")
      await spawnDetached(
        downloaded.file,
        windowsInstallArguments(this.options.executable, restart),
      );
    else throw new Error("This platform does not support personal app installation.");
    this.options.quit();
  }
}
