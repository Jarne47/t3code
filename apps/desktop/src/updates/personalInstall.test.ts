// @effect-diagnostics nodeBuiltinImport:off - Tests exercise the native installer boundary with disposable filesystem fixtures.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { describe, expect, it } from "vite-plus/test";
import {
  MAC_INSTALL_SCRIPT,
  macApplicationPath,
  prepareMacUpdate,
  windowsInstallArguments,
} from "./personalInstall.ts";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
describe("personal installation paths", () => {
  it("preserves custom locations, spaces and apostrophes", () => {
    expect(windowsInstallArguments("D:\\Itamar's Apps\\T3 Code.exe", true)).toEqual([
      "--updated",
      "/S",
      "--force-run",
      "/D=D:\\Itamar's Apps",
    ]);
    expect(windowsInstallArguments("C:\\Apps\\T3.exe", false)).toEqual([
      "--updated",
      "/S",
      "/D=C:\\Apps",
    ]);
    expect(
      macApplicationPath("/Users/test/My Apps/Itamar's T3.app/Contents/MacOS/T3 Code (Itamar)"),
    ).toBe("/Users/test/My Apps/Itamar's T3.app");
  });
  it("rejects temporary Mac copies and ambiguous executable paths", () => {
    for (const executable of [
      "/Volumes/T3/T3.app/Contents/MacOS/T3",
      "/private/var/AppTranslocation/id/d/T3.app/Contents/MacOS/T3",
      "/usr/bin/T3",
      "relative.app/Contents/MacOS/T3",
    ]) {
      expect(() => macApplicationPath(executable)).toThrow();
    }
    expect(() => windowsInstallArguments("T3.exe", true)).toThrow();
  });
});

// Run on the Mac release builder against disposable, ad-hoc-signed fixtures only.
// oxlint-disable-next-line t3code/no-global-process-runtime -- Test collection must check the real host before executing macOS binaries.
it.skipIf(NodeOS.platform() !== "darwin")(
  "stages a signed Mac update and replaces an app at its actual location",
  async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mac-update-test-"));
    try {
      const version = "0.0.46-itamar.20261003.10";
      const bundle = NodePath.join(root, "T3 Code (Itamar).app");
      const contents = NodePath.join(bundle, "Contents");
      await NodeFSP.mkdir(NodePath.join(contents, "MacOS"), { recursive: true });
      await NodeFSP.copyFile("/usr/bin/true", NodePath.join(contents, "MacOS", "test"));
      await NodeFSP.chmod(NodePath.join(contents, "MacOS", "test"), 0o755);
      await NodeFSP.writeFile(
        NodePath.join(contents, "Info.plist"),
        `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.jarne47.t3code</string><key>CFBundleExecutable</key><string>test</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>${version}</string></dict></plist>`,
      );
      await execute("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", bundle]);
      const archive = NodePath.join(root, "update.zip");
      await execute("/usr/bin/ditto", ["-c", "-k", "--keepParent", bundle, archive]);
      const target = NodePath.join(root, "My app's custom name.app");
      await NodeFSP.mkdir(target);
      await NodeFSP.writeFile(NodePath.join(target, "old-marker"), "old");
      const executable = `${target}/Contents/MacOS/test`;
      await expect(prepareMacUpdate(archive, executable, "wrong-version")).rejects.toThrow(
        "identity or version",
      );
      expect(
        (await NodeFSP.readdir(root)).filter((name) => name.startsWith(".t3code-update-")),
      ).toEqual([]);
      const prepared = await prepareMacUpdate(archive, executable, version);
      const script = NodePath.join(root, "install.sh");
      await NodeFSP.writeFile(script, MAC_INSTALL_SCRIPT);
      // Use an exited process, never the test runner or a user's application.
      const deadPid = await new Promise<number>((resolve, reject) => {
        const child = NodeChildProcess.spawn("/usr/bin/true");
        child.once("error", reject);
        child.once("exit", () => resolve(child.pid!));
      });
      await execute("/bin/sh", [script, target, prepared.stage, String(deadPid), "0"]);
      expect(
        await NodeFSP.readFile(NodePath.join(target, "Contents", "Info.plist"), "utf8"),
      ).toContain(version);
      await expect(NodeFSP.stat(prepared.stage)).rejects.toThrow();
      await expect(NodeFSP.stat(NodePath.join(target, "old-marker"))).rejects.toThrow();
      await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", target]);
      // Missing candidate must leave the installed application in place.
      const invalidStage = await NodeFSP.mkdtemp(NodePath.join(root, ".t3code-update-"));
      await expect(
        execute("/bin/sh", [script, target, invalidStage, String(deadPid), "0"]),
      ).rejects.toThrow();
      expect(
        await NodeFSP.readFile(NodePath.join(target, "Contents", "Info.plist"), "utf8"),
      ).toContain(version);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);
