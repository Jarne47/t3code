// @effect-diagnostics nodeBuiltinImport:off - OS installer boundary; called by the Electron updater adapter.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { PERSONAL_DESKTOP_FORK } from "@t3tools/shared/personalDesktopFork";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);

export function windowsInstallArguments(executable: string, restart: boolean): string[] {
  if (!NodePath.win32.isAbsolute(executable) || !executable.toLowerCase().endsWith(".exe")) {
    throw new Error("Cannot determine the running application's installation directory.");
  }
  // Same switches used by electron-updater's NSIS driver. /D must remain last.
  return [
    "--updated",
    "/S",
    ...(restart ? ["--force-run"] : []),
    `/D=${NodePath.win32.dirname(executable)}`,
  ];
}

export function macApplicationPath(executable: string): string {
  const target = NodePath.posix.dirname(NodePath.posix.dirname(NodePath.posix.dirname(executable)));
  if (
    !NodePath.posix.isAbsolute(executable) ||
    !target.endsWith(".app") ||
    NodePath.posix.dirname(executable) !== `${target}/Contents/MacOS` ||
    target.includes("/AppTranslocation/") ||
    target.startsWith("/Volumes/")
  ) {
    throw new Error("Move T3 Code (Itamar) into Applications and reopen it before updating.");
  }
  return target;
}

export interface PreparedMacUpdate {
  target: string;
  stage: string;
}

/** Stage and validate before quitting; all renames then stay on the application's filesystem. */
export async function prepareMacUpdate(
  archive: string,
  executable: string,
  version: string,
): Promise<PreparedMacUpdate> {
  const target = macApplicationPath(executable);
  if ((await NodeFSP.lstat(target)).isSymbolicLink())
    throw new Error("Open the installed app directly before updating.");
  await NodeFSP.access(NodePath.dirname(target), NodeFS.constants.W_OK);
  const stage = await NodeFSP.mkdtemp(NodePath.join(NodePath.dirname(target), ".t3code-update-"));
  try {
    const unpacked = NodePath.join(stage, "unpacked");
    await execute("/usr/bin/ditto", ["-x", "-k", archive, unpacked]);
    const bundle = NodePath.join(unpacked, `${PERSONAL_DESKTOP_FORK.productName}.app`);
    const plist = NodePath.join(bundle, "Contents", "Info.plist");
    const id = await execute("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist]);
    const installedVersion = await execute("/usr/libexec/PlistBuddy", [
      "-c",
      "Print :CFBundleShortVersionString",
      plist,
    ]);
    if (
      id.stdout.trim() !== PERSONAL_DESKTOP_FORK.appId ||
      installedVersion.stdout.trim() !== version
    ) {
      throw new Error("The downloaded application identity or version does not match this update.");
    }
    await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
    await NodeFSP.rename(bundle, NodePath.join(stage, "candidate.app"));
    return { target, stage };
  } catch (error) {
    await NodeFSP.rm(stage, { recursive: true, force: true });
    throw error;
  }
}

// Ad-hoc builds cannot use Squirrel.Mac's cross-version signing identity check.
// A detached helper waits for this exact process, swaps the validated bundle in
// its original location, and restores the previous bundle if replacement fails.
export const MAC_INSTALL_SCRIPT = `#!/bin/sh
set -eu
target="$1"
stage="$2"
parent_pid="$3"
restart="$4"
case "$target" in /*.app) ;; *) exit 1 ;; esac
case "$stage" in "$(dirname "$target")"/.t3code-update-*) ;; *) exit 1 ;; esac
backup="$stage/previous.app"
candidate="$stage/candidate.app"
restore() {
  if [ ! -d "$target" ] && [ -d "$backup" ]; then /bin/mv "$backup" "$target"; fi
}
trap restore EXIT
attempt=0
while kill -0 "$parent_pid" 2>/dev/null; do
  attempt=$((attempt + 1))
  [ "$attempt" -le 90 ] || exit 1
  sleep 1
done
[ -d "$candidate" ] && [ -d "$target" ]
/bin/mv "$target" "$backup"
/bin/mv "$candidate" "$target"
if [ "$restart" = 1 ]; then
  if ! /usr/bin/open "$target"; then
    /bin/mv "$target" "$candidate"
    /bin/mv "$backup" "$target"
    /usr/bin/open "$target"
    exit 1
  fi
fi
/bin/rm -rf "$stage"
`;

export async function spawnDetached(
  command: string,
  args: readonly string[],
  logPath?: string,
): Promise<void> {
  const log = logPath ? await NodeFSP.open(logPath, "a") : undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = NodeChildProcess.spawn(command, [...args], {
        detached: true,
        windowsHide: true,
        stdio: log ? ["ignore", log.fd, log.fd] : "ignore",
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  } finally {
    await log?.close();
  }
}

export async function startMacInstall(
  prepared: PreparedMacUpdate,
  cacheDirectory: string,
  restart: boolean,
): Promise<void> {
  const script = NodePath.join(cacheDirectory, "install-mac.sh");
  await NodeFSP.writeFile(script, MAC_INSTALL_SCRIPT, { mode: 0o700 });
  await spawnDetached(
    "/bin/sh",
    [script, prepared.target, prepared.stage, String(process.pid), restart ? "1" : "0"],
    NodePath.join(cacheDirectory, "install.log"),
  );
}
