/** Personal packages have their own identity and never use the official update feed. */
export const PERSONAL_DESKTOP_FORK = {
  appId: "com.jarne47.t3code",
  productName: "T3 Code (Itamar)",
  homeDirectoryName: ".t3-itamar",
  userDataDirectoryName: "t3code-itamar",
  releasesUrl: "https://github.com/Jarne47/t3code/releases",
  releasesApiUrl: "https://api.github.com/repos/Jarne47/t3code/releases?per_page=100",
} as const;

export function isPersonalDesktopFork(version: string): boolean {
  return /-itamar\.\d{8}\.\d+$/.test(version);
}
