import { expect, it } from "vite-plus/test";

import {
  composePersonalReleaseNotes,
  forkChangeText,
  parseNightlyMerge,
} from "./personal-release-notes.ts";

const UPSTREAM_BODY = `**v0.1.12-nightly.20261122.5085** · 20 changes from 10 contributors

- **Reliable image sends.** Messages now wait for images to finish uploading before sending.
- **Rich text pasting.** Paste text from Microsoft Word into the composer.

### Plus 18 more bug fixes and performance improvements.

<details>
<summary>Full changelog</summary>

## What's Changed
* fix(web): wait for image uploads before sending by @someone in https://github.com/pingdotgg/t3code/pull/40672
</details>`;

it.each([
  ["chore: merge upstream nightly v0.1.12-nightly.20261122.5085 into personal fork", 5085],
  ["feat(web): merge hidden projects into main", undefined],
])("reads the nightly a merge subject names: %s", (subject, counter) => {
  expect(parseNightlyMerge(subject)?.counter).toBe(counter);
});

it.each([
  [
    "fix(desktop): personal Windows builds fit the payload limit",
    "Personal Windows builds fit the payload limit.",
  ],
  ["feat!: drop the old updater", "Drop the old updater."],
  ["docs: scheduled fork sync also builds Windows", undefined],
  ["chore: merge upstream nightly v0.1.12-nightly.20261122.5085 into personal fork", undefined],
])("keeps only user-facing fork commits: %s", (subject, text) => {
  expect(forkChangeText(subject)).toBe(text);
});

it("lists fork changes and upstream highlights in the popup's summary shape", () => {
  const notes = composePersonalReleaseNotes({
    version: "0.1.12-itamar.20261122.2",
    previousVersion: "0.1.11-itamar.20261118.1",
    repository: "Jarne47/t3code",
    forkSubjects: [
      "fix(desktop): personal Windows builds fit the payload limit",
      "docs: scheduled fork sync also builds Windows",
    ],
    upstreamNightlies: [{ tag: "v0.1.12-nightly.20261122.5085", body: UPSTREAM_BODY }],
    upstreamChangeCount: 20,
  });
  const summary = notes.slice(0, notes.indexOf("<details>"));
  expect(summary)
    .toBe(`**v0.1.12-itamar.20261122.2** · Upstream v0.1.12-nightly.20261122.5085 · 20 upstream changes, 1 fork changes

- **Fork:** Personal Windows builds fit the payload limit.
- **Reliable image sends.** Messages now wait for images to finish uploading before sending.
- **Rich text pasting.** Paste text from Microsoft Word into the composer.

### Plus 18 more upstream changes.

`);
  expect(notes).toContain("* docs: scheduled fork sync also builds Windows");
  expect(notes).toContain(
    "https://github.com/Jarne47/t3code/compare/v0.1.11-itamar.20261118.1...v0.1.12-itamar.20261122.2",
  );
});
