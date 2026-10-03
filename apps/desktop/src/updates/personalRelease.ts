import { isPersonalDesktopFork, PERSONAL_DESKTOP_FORK } from "@t3tools/shared/personalDesktopFork";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Schema from "effect/Schema";

const Releases = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    draft: Schema.Boolean,
    body: Schema.NullOr(Schema.String),
    assets: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        browser_download_url: Schema.String,
        size: Schema.Number,
        digest: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  }),
);

export interface PersonalRelease {
  version: string;
  releaseNotes: string;
  url: string;
  sha256: string;
  size: number;
}

const decodeReleases = Schema.decodeUnknownSync(Releases);

/** Only our published packages can enter the updater, even if upstream releases exist in the fork. */
export function selectPersonalRelease(
  raw: unknown,
  currentVersion: string,
  platform: string,
  arch: string,
): PersonalRelease | null {
  const releases = decodeReleases(raw)
    .filter(
      (release) =>
        !release.draft &&
        /^v?\d+\.\d+\.\d+-itamar\.\d{8}\.\d+$/.test(release.tag_name) &&
        isPersonalDesktopFork(release.tag_name.replace(/^v/, "")),
    )
    .toSorted((a, b) =>
      compareSemverVersions(b.tag_name.replace(/^v/, ""), a.tag_name.replace(/^v/, "")),
    );
  const release = releases[0];
  if (!release) return null;
  const version = release.tag_name.replace(/^v/, "");
  if (compareSemverVersions(version, currentVersion) <= 0) return null;
  if (!["win32", "darwin"].includes(platform) || !["x64", "arm64"].includes(arch)) {
    throw new Error("This platform does not have a personal desktop updater.");
  }
  const name = `T3-Code-${version}-${arch}.${platform === "darwin" ? "zip" : "exe"}`;
  const asset = release.assets.find((item) => item.name === name);
  if (!asset)
    throw new Error(`Release ${version} does not contain a ${platform} ${arch} installer yet.`);
  const url = `${PERSONAL_DESKTOP_FORK.releasesUrl}/download/v${version}/${name}`;
  if (
    asset.browser_download_url !== url ||
    !/^sha256:[a-f0-9]{64}$/i.test(asset.digest ?? "") ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size > 2_000_000_000
  ) {
    throw new Error("The personal release is missing valid installer integrity metadata.");
  }
  return {
    version,
    releaseNotes: release.body ?? "",
    url,
    sha256: asset.digest!.slice(7).toLowerCase(),
    size: asset.size,
  };
}
