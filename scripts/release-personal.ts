// @effect-diagnostics nodeBuiltinImport:off - a plain release runner around existing build scripts.
/**
 * Builds and publishes personal desktop releases without GitHub Actions. Each
 * machine builds the app for its own platform; both add their file to the same
 * GitHub release, which is all the in-app personal updater reads.
 *
 *   node scripts/release-personal.ts build [--version <v>] [--ref <commit>]
 *   node scripts/release-personal.ts publish --version <v>
 *
 * `build` checks out the commit in a temporary worktree and leaves the
 * installer in release/personal/<version>. When the release already exists
 * (for example, Windows published it and the Mac adds its zip), it rebuilds
 * that release's commit. `publish` creates the release or adds this machine's
 * files to it. Mirrors .github/workflows/build-personal.yml.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const RELEASE_REPO = "Jarne47/t3code";
const VERSION_PATTERN = /^\d+\.\d+\.\d+-itamar\.\d{8}\.\d+$/;
const ASSET_PATTERN = /^(T3-Code-.+\.(exe|zip)|t3-.+\.tar\.gz)$/;
const repoRoot = NodePath.dirname(import.meta.dirname);

const PLATFORMS = {
  win32: { platform: "win", target: "nsis", arch: "x64" },
  darwin: { platform: "mac", target: "zip", arch: "arm64" },
} as const;

// The same focused updater and config tests the personal workflow runs.
const RELEASE_TESTS = [
  [
    "apps/desktop/src/updates/PersonalUpdater.test.ts",
    "apps/desktop/src/updates/personalInstall.test.ts",
    "apps/desktop/src/updates/DesktopUpdates.test.ts",
    "apps/desktop/src/electron/ElectronUpdater.test.ts",
    "apps/web/src/components/desktopUpdate.logic.test.ts",
  ],
  [
    "scripts/lib/public-config.test.ts",
    "apps/web/src/cloud/publicConfig.test.ts",
    "apps/web/src/cloud/linkEnvironment.test.ts",
  ],
  [
    "apps/web/src/components/sidebar/ActiveProjectGroups.test.tsx",
    "apps/web/src/components/ProviderUpdateEnvironmentRows.test.tsx",
    "apps/server/src/provider/providerMaintenance.test.ts",
    "apps/server/src/provider/providerMaintenanceRunner.test.ts",
    "apps/desktop/src/app/DesktopUserData.test.ts",
  ],
];

function run(command: string, args: ReadonlyArray<string>, cwd = repoRoot): void {
  process.stdout.write(`\n> ${command} ${args.join(" ")}\n`);
  const result = NodeChildProcess.spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.error?.message ?? `exit ${result.status}`}).`);
  }
}

/** Returns trimmed stdout, or undefined when the command fails. */
function capture(command: string, args: ReadonlyArray<string>, cwd = repoRoot) {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function findRelease(version: string) {
  const json = capture("gh", [
    "release",
    "view",
    `v${version}`,
    "--repo",
    RELEASE_REPO,
    "--json",
    "targetCommitish,assets",
  ]);
  if (json === undefined) return undefined;
  const release = JSON.parse(json) as {
    targetCommitish: string;
    assets: ReadonlyArray<{ name: string }>;
  };
  return { commit: release.targetCommitish, assets: release.assets.map((asset) => asset.name) };
}

/** Next free `<base>-itamar.<today>.<n>`, keeping the base of the latest personal release. */
function nextVersion(): string {
  const tags = (
    capture("gh", [
      "release",
      "list",
      "--repo",
      RELEASE_REPO,
      "--limit",
      "100",
      "--json",
      "tagName",
      "--jq",
      ".[].tagName",
    ]) ?? ""
  )
    .split("\n")
    .map((tag) => tag.replace(/^v/, ""))
    .filter((tag) => VERSION_PATTERN.test(tag));
  const base = tags[0]?.split("-")[0];
  if (base === undefined) throw new Error("No personal release found; pass --version.");
  const now = new Date();
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const prefix = `${base}-itamar.${date}.`;
  const used = tags
    .filter((tag) => tag.startsWith(prefix))
    .map((tag) => Number(tag.slice(prefix.length)));
  return `${prefix}${Math.max(0, ...used) + 1}`;
}

function outputDir(version: string): string {
  return NodePath.join(repoRoot, "release", "personal", version);
}

function build(options: { version?: string; ref?: string }): void {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone release script has no Effect runtime.
  const host = PLATFORMS[NodeOS.platform() as keyof typeof PLATFORMS];
  if (host === undefined) throw new Error(`Personal desktop builds need Windows or macOS.`);
  const version = options.version ?? nextVersion();
  if (!VERSION_PATTERN.test(version)) throw new Error(`Invalid personal version '${version}'.`);

  const existing = findRelease(version);
  const ref = existing?.commit ?? options.ref ?? "HEAD";
  const commit = capture("git", ["rev-parse", "--verify", `${ref}^{commit}`]);
  if (commit === undefined) throw new Error(`Unknown commit '${ref}'.`);
  if (existing === undefined) {
    // The release tag is created on GitHub, so the commit must already be pushed.
    run("git", ["fetch", "--quiet", "origin"]);
    if (!capture("git", ["branch", "--remotes", "--contains", commit])) {
      throw new Error(`Commit ${commit} is not on origin. Push it first.`);
    }
  }
  process.stdout.write(`Building ${host.platform} ${host.arch} ${version} from ${commit}\n`);

  const output = outputDir(version);
  NodeFS.mkdirSync(output, { recursive: true });
  // `publish` tags the release on the commit that was actually built.
  NodeFS.writeFileSync(NodePath.join(output, "source-commit"), `${commit}\n`);
  // The packaged-server probe refuses to run below any node_modules directory,
  // and Windows temp lives under the user profile, which often has one. Build
  // and probe from the drive root there; keep short paths for node_modules too.
  const scratch =
    host.platform === "win"
      ? NodePath.join(NodePath.parse(repoRoot).root, "t3-release")
      : NodeOS.tmpdir();
  const temp = NodePath.join(scratch, "tmp");
  NodeFS.mkdirSync(temp, { recursive: true });
  for (const name of ["TEMP", "TMP", "TMPDIR"]) process.env[name] = temp;
  const worktree = NodePath.join(scratch, `t3-release-${version}`);
  if (NodeFS.existsSync(worktree)) run("git", ["worktree", "remove", "--force", worktree]);
  run("git", ["worktree", "add", "--detach", worktree, commit]);
  try {
    NodeFS.copyFileSync(NodePath.join(worktree, ".env.example"), NodePath.join(worktree, ".env"));
    run("vp", ["install", "--frozen-lockfile"], worktree);
    for (const files of RELEASE_TESTS) run("vp", ["test", "run", ...files], worktree);
    run("node", ["scripts/update-release-package-versions.ts", version], worktree);
    run(
      "node",
      [
        "scripts/build-desktop-artifact.ts",
        "--platform",
        host.platform,
        "--target",
        host.target,
        "--arch",
        host.arch,
        "--build-version",
        version,
        "--output-dir",
        output,
        "--verbose",
      ],
      worktree,
    );
    const serverVersion = capture("node", ["apps/server/dist/bin.mjs", "--version"], worktree);
    if (serverVersion !== `t3 v${version}`) {
      throw new Error(`Bundled server reports '${serverVersion}', expected 't3 v${version}'.`);
    }
    if (host.platform === "mac") signMacPackage(output, version);
  } finally {
    run("git", ["worktree", "remove", "--force", worktree]);
  }
  process.stdout.write(
    `\nBuilt ${listAssets(version).join(", ")} in ${output}\n` +
      `Publish with: node scripts/release-personal.ts publish --version ${version}\n`,
  );
}

/** Ad hoc signs the Mac app so Gatekeeper accepts the unsigned personal build. */
function signMacPackage(output: string, version: string): void {
  const zip = NodePath.join(output, `T3-Code-${version}-arm64.zip`);
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-personal-app-"));
  try {
    run("ditto", ["-x", "-k", zip, scratch]);
    const app = NodePath.join(scratch, "T3 Code (Itamar).app");
    run("codesign", ["--force", "--deep", "--sign", "-", app]);
    run("codesign", ["--verify", "--deep", "--strict", app]);
    NodeFS.rmSync(zip);
    run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
}

function listAssets(version: string): ReadonlyArray<string> {
  const output = outputDir(version);
  if (!NodeFS.existsSync(output)) return [];
  return NodeFS.readdirSync(output).filter(
    (name) => ASSET_PATTERN.test(name) && name.includes(version),
  );
}

function sha256(file: string): string {
  return NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");
}

function publish(version: string): void {
  if (!VERSION_PATTERN.test(version)) throw new Error(`Invalid personal version '${version}'.`);
  const output = outputDir(version);
  const assets = listAssets(version);
  if (assets.length === 0) throw new Error(`Nothing built in ${output}. Run build first.`);
  const existing = findRelease(version);
  const fresh = assets.filter((name) => !existing?.assets.includes(name));
  if (fresh.length === 0) {
    process.stdout.write(`v${version} already has ${assets.join(", ")}.\n`);
    return;
  }

  // SHA256SUMS covers every installer in the release, including other machines' files.
  const sumsFile = NodePath.join(output, "SHA256SUMS");
  const sums = new Map<string, string>();
  if (existing?.assets.includes("SHA256SUMS")) {
    run("gh", [
      "release",
      "download",
      `v${version}`,
      "--repo",
      RELEASE_REPO,
      "--pattern",
      "SHA256SUMS",
      "--dir",
      output,
      "--clobber",
    ]);
    for (const line of NodeFS.readFileSync(sumsFile, "utf8").split("\n")) {
      const [hash, name] = line.trim().split(/\s+\*?/);
      if (hash && name) sums.set(name.replace(/^\.\//, ""), hash);
    }
  }
  for (const name of fresh) sums.set(name, sha256(NodePath.join(output, name)));
  NodeFS.writeFileSync(
    sumsFile,
    [...sums].map(([name, hash]) => `${hash}  ${name}`).join("\n") + "\n",
  );
  const files = [...fresh.map((name) => NodePath.join(output, name)), sumsFile];

  if (existing === undefined) {
    const commit = NodeFS.readFileSync(NodePath.join(output, "source-commit"), "utf8").trim();
    const notes = NodePath.join(output, "release-notes.md");
    NodeFS.writeFileSync(
      notes,
      `Personal build of T3 Code (Itamar).

Version: ${version}

Windows and Apple Silicon Mac installers are added as each machine builds them. Personal app updates are available in Settings → About once this release has your platform's installer.

These personal builds use a separate ~/.t3-itamar data directory. Windows installers lack a commercial signing certificate; the Mac package is signed ad hoc.
`,
    );
    run("gh", [
      "release",
      "create",
      `v${version}`,
      "--repo",
      RELEASE_REPO,
      "--target",
      commit,
      "--title",
      `T3 Code (Itamar) ${version}`,
      "--notes-file",
      notes,
      ...files,
    ]);
  } else {
    run("gh", [
      "release",
      "upload",
      `v${version}`,
      "--repo",
      RELEASE_REPO,
      ...fresh.map((name) => NodePath.join(output, name)),
    ]);
    run("gh", ["release", "upload", `v${version}`, "--repo", RELEASE_REPO, "--clobber", sumsFile]);
  }
  process.stdout.write(`\nPublished ${fresh.join(", ")} to v${version}.\n`);
}

const { positionals, values } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: { version: { type: "string" }, ref: { type: "string" } },
});
const [command] = positionals;
if (command === "build") {
  build({ ...values });
} else if (command === "publish" && values.version) {
  publish(values.version);
} else {
  process.stderr.write(
    "Usage: node scripts/release-personal.ts build [--version <v>] [--ref <commit>]\n" +
      "       node scripts/release-personal.ts publish --version <v>\n",
  );
  process.exit(1);
}
