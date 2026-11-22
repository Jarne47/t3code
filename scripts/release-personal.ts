// @effect-diagnostics nodeBuiltinImport:off globalDate:off - a plain release runner around existing build scripts.
/**
 * Personal desktop releases without GitHub Actions: each machine builds its own platform
 * and adds the file to one GitHub release, which the personal updater reads. Run
 * `build [--version <v>] [--ref <commit>]`, then `publish --version <v>`. `notes --version <v>`
 * previews the generated release notes.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { composePersonalReleaseNotes, parseNightlyMerge } from "./lib/personal-release-notes.ts";

const RELEASE_REPO = "Jarne47/t3code";
const UPSTREAM_REPO = "pingdotgg/t3code";
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
    "apps/web/src/components/desktopUpdate.logic.test.ts",
  ],
  [
    "scripts/lib/public-config.test.ts",
    "apps/web/src/cloud/publicConfig.test.ts",
    "apps/web/src/cloud/linkEnvironment.test.ts",
  ],
  [
    "apps/web/src/components/sidebar/activeThreadSort.test.ts",
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

/** Numeric `major.minor.patch` parts, for ordering release bases. */
function semverParts(version: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  return [major, minor, patch];
}

/**
 * Next free `<base>-itamar.<today>.<n>`. The base matches upstream nightlies (the desktop
 * package's next patch) at `ref`, and never drops below the latest personal release, so
 * installed builds always see the new one as an update.
 */
function nextVersion(ref: string): string {
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
  const desktopPackage = capture("git", ["show", `${ref}:apps/desktop/package.json`]);
  if (desktopPackage === undefined) throw new Error(`Cannot read the desktop version at '${ref}'.`);
  const [major, minor, patch] = semverParts(
    (JSON.parse(desktopPackage) as { version: string }).version,
  );
  const base = [`${major}.${minor}.${patch + 1}`, ...tags.map((tag) => tag.split("-")[0]!)]
    .toSorted((left, right) => {
      const a = semverParts(left);
      const b = semverParts(right);
      return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
    })
    .at(0)!;
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

/**
 * Builds the commit in a temporary worktree into release/personal/<version>. An existing
 * release (say Windows published first) pins the commit, so the Mac adds a matching zip.
 */
function build(options: { version?: string; ref?: string }): void {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone release script has no Effect runtime.
  const host = PLATFORMS[NodeOS.platform() as keyof typeof PLATFORMS];
  if (host === undefined) throw new Error(`Personal desktop builds need Windows or macOS.`);
  const version = options.version ?? nextVersion(options.ref ?? "HEAD");
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
    NodeFS.writeFileSync(notes, releaseNotes(version, commit));
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

function gitLines(args: ReadonlyArray<string>): ReadonlyArray<string> {
  return (capture("git", args) ?? "").split("\n").filter((line) => line.length > 0);
}

/**
 * The newest other complete personal release (both installers) in `commit`'s history. A release
 * one machine never finished is skipped, so its notes stay accurate for the other platform.
 */
function previousRelease(version: string, commit: string) {
  const tags = (
    capture("gh", [
      "release",
      "list",
      "--repo",
      RELEASE_REPO,
      "--limit",
      "30",
      "--json",
      "tagName",
      "--jq",
      ".[].tagName",
    ]) ?? ""
  )
    .split("\n")
    .map((tag) => tag.replace(/^v/, ""))
    .filter((tag) => VERSION_PATTERN.test(tag) && tag !== version);
  for (const tag of tags) {
    const release = findRelease(tag);
    const complete = ["exe", "zip"].every((ext) =>
      release?.assets.some((name) => name.endsWith(`.${ext}`)),
    );
    if (
      release &&
      complete &&
      capture("git", ["merge-base", "--is-ancestor", release.commit, commit]) !== undefined
    ) {
      return { version: tag, commit: release.commit };
    }
  }
  return undefined;
}

/** Notes describing the fork commits and upstream nightlies since the previous personal release. */
function releaseNotes(version: string, commit: string): string {
  const previous = previousRelease(version, commit);
  const range = previous ? `${previous.commit}..${commit}` : commit;
  const forkSubjects = [
    ...gitLines(["log", "--first-parent", "--no-merges", "--format=%s", range]),
  ];
  const mergedCounters: number[] = [];
  let upstreamChangeCount = 0;
  for (const line of gitLines(["log", "--first-parent", "--merges", "--format=%H %s", range])) {
    const [merge = "", ...subject] = line.split(" ");
    const sideRange = `${merge}^1..${merge}^2`;
    const nightly = parseNightlyMerge(subject.join(" "));
    if (nightly) {
      mergedCounters.push(nightly.counter);
      upstreamChangeCount += Number(
        capture("git", ["rev-list", "--count", "--no-merges", sideRange]) ?? 0,
      );
    } else {
      forkSubjects.push(...gitLines(["log", "--no-merges", "--format=%s", sideRange]));
    }
  }
  const previousCounter = previous
    ? (gitLines(["log", "--first-parent", "--merges", "--format=%s", previous.commit])
        .map(parseNightlyMerge)
        .find((merge) => merge !== undefined)?.counter ?? 0)
    : 0;
  const newestCounter = Math.max(0, ...mergedCounters);
  // Upstream writes highlights per nightly; include every nightly this merge skipped over too.
  const upstreamNightlies = (
    capture("gh", [
      "release",
      "list",
      "--repo",
      UPSTREAM_REPO,
      "--limit",
      "200",
      "--json",
      "tagName",
      "--jq",
      ".[].tagName",
    ]) ?? ""
  )
    .split("\n")
    .flatMap((tag) => {
      const counter = parseNightlyMerge(`merge upstream nightly ${tag}`)?.counter;
      return counter !== undefined && counter > previousCounter && counter <= newestCounter
        ? [{ tag, counter }]
        : [];
    })
    .toSorted((left, right) => right.counter - left.counter)
    .map(({ tag }) => ({
      tag,
      body:
        capture("gh", [
          "release",
          "view",
          tag,
          "--repo",
          UPSTREAM_REPO,
          "--json",
          "body",
          "--jq",
          ".body",
        ]) ?? "",
    }));
  return composePersonalReleaseNotes({
    version,
    repository: RELEASE_REPO,
    ...(previous ? { previousVersion: previous.version } : {}),
    forkSubjects,
    upstreamNightlies,
    upstreamChangeCount,
  });
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
} else if (command === "notes" && values.version) {
  // Prints the notes; `gh release edit v<version> --notes-file <file>` replaces a published release's.
  const commit =
    findRelease(values.version)?.commit ?? capture("git", ["rev-parse", values.ref ?? "HEAD"]);
  if (commit === undefined) throw new Error(`Unknown commit for ${values.version}.`);
  process.stdout.write(releaseNotes(values.version, commit));
} else {
  process.stderr.write(
    "Usage: node scripts/release-personal.ts build [--version <v>] [--ref <commit>]\n" +
      "       node scripts/release-personal.ts publish --version <v>\n" +
      "       node scripts/release-personal.ts notes --version <v> [--ref <commit>]\n",
  );
  process.exit(1);
}
