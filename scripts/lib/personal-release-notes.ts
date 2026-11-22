/**
 * Release notes for personal fork builds. The shape follows upstream's nightly notes (stats line,
 * highlight bullets, "Plus N more", full changelog in <details>) so the desktop update popup
 * renders them through the same summary path.
 */

const NIGHTLY_MERGE = /merge upstream nightly (v\S+-nightly\.\d{8}\.(\d+))/;
const USER_FACING_COMMIT = /^(feat|fix|perf)(\([^)]*\))?!?:\s*(.+)$/;
const MAX_HIGHLIGHTS = 10;

/** The upstream nightly tag a fork merge commit subject names, with its build counter. */
export function parseNightlyMerge(subject: string) {
  const match = NIGHTLY_MERGE.exec(subject);
  return match ? { tag: match[1]!, counter: Number(match[2]) } : undefined;
}

/** A fork commit subject as a sentence, or undefined for chores, docs, tests and merges. */
export function forkChangeText(subject: string): string | undefined {
  const text = USER_FACING_COMMIT.exec(subject)?.[3]?.trim();
  if (!text) return undefined;
  const sentence = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

/** Highlight bullets from an upstream nightly body, without its stats line or changelog. */
export function parseUpstreamHighlights(body: string): ReadonlyArray<string> {
  const summaryEnd = body.search(/<details>/i);
  return (summaryEnd >= 0 ? body.slice(0, summaryEnd) : body)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, ""));
}

export interface PersonalReleaseNotesInput {
  readonly version: string;
  readonly repository: string;
  readonly previousVersion?: string;
  /** Fork commit subjects since the previous release, newest first. */
  readonly forkSubjects: ReadonlyArray<string>;
  /** Upstream nightlies merged since the previous release, newest first. */
  readonly upstreamNightlies: ReadonlyArray<{ readonly tag: string; readonly body: string }>;
  readonly upstreamChangeCount: number;
}

export function composePersonalReleaseNotes(input: PersonalReleaseNotesInput): string {
  const forkChanges = input.forkSubjects.flatMap((subject) => forkChangeText(subject) ?? []);
  const highlights = input.upstreamNightlies
    .flatMap((nightly) => parseUpstreamHighlights(nightly.body))
    .slice(0, MAX_HIGHLIGHTS);
  const newestTag = input.upstreamNightlies[0]?.tag;

  const stats = [
    `**v${input.version}**`,
    ...(newestTag ? [`Upstream ${newestTag}`] : []),
    `${input.upstreamChangeCount} upstream changes, ${forkChanges.length} fork changes`,
  ].join(" · ");
  const remaining = Math.max(0, input.upstreamChangeCount - highlights.length);
  const lines = [
    stats,
    "",
    ...forkChanges.map((change) => `- **Fork:** ${change}`),
    ...highlights.map((highlight) => `- ${highlight}`),
  ];
  if (forkChanges.length === 0 && highlights.length === 0) {
    lines.push("- Rebuilt with no user-facing changes.");
  }
  if (remaining > 0) {
    lines.push("", `### Plus ${remaining} more upstream changes.`);
  }

  const compare = input.previousVersion
    ? `https://github.com/${input.repository}/compare/v${input.previousVersion}...v${input.version}`
    : undefined;
  lines.push(
    "",
    "<details>",
    "<summary>Full changelog</summary>",
    "",
    "## Fork changes",
    ...(input.forkSubjects.length > 0
      ? input.forkSubjects.map((subject) => `* ${subject}`)
      : ["* None"]),
    "",
    "## Upstream nightlies merged",
    ...(input.upstreamNightlies.length > 0
      ? input.upstreamNightlies.map(
          (nightly) => `* https://github.com/pingdotgg/t3code/releases/tag/${nightly.tag}`,
        )
      : ["* None"]),
    "",
    "Personal builds use a separate ~/.t3-itamar data directory. The Windows installer has no commercial signing certificate; the Mac app is signed ad hoc.",
    ...(compare ? ["", `**Full Changelog**: ${compare}`] : []),
    "</details>",
    "",
  );
  return lines.join("\n");
}
