/** Personal packages have their own identity and never use the official update feed. */
export const PERSONAL_DESKTOP_FORK = {
  appId: "com.jarne47.t3code",
  productName: "T3 Code (Itamar)",
  homeDirectoryName: ".t3-itamar",
  userDataDirectoryName: "t3code-itamar",
} as const;

export function isPersonalDesktopFork(version: string): boolean {
  return /-itamar\.\d{8}\.\d+$/.test(version);
}
