import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { autoUpdater } from "electron-updater";
import { app, net } from "electron";
import { isPersonalDesktopFork } from "@t3tools/shared/personalDesktopFork";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { PersonalUpdater } from "../updates/PersonalUpdater.ts";

type AutoUpdater = typeof autoUpdater;

export type ElectronUpdaterFeedUrl = Parameters<AutoUpdater["setFeedURL"]>[0];

export class ElectronUpdaterCheckForUpdatesError extends Schema.TaggedError<ElectronUpdaterCheckForUpdatesError>()(
  "ElectronUpdaterCheckForUpdatesError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to check for updates on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterDownloadUpdateError extends Schema.TaggedError<ElectronUpdaterDownloadUpdateError>()(
  "ElectronUpdaterDownloadUpdateError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to download the update on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterQuitAndInstallError extends Schema.TaggedError<ElectronUpdaterQuitAndInstallError>()(
  "ElectronUpdaterQuitAndInstallError",
  {
    channel: Schema.NullOr(Schema.String),
    isSilent: Schema.Boolean,
    isForceRunAfter: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to quit and install the update on channel ${this.channel ?? "default"} (silent: ${this.isSilent}, force run after: ${this.isForceRunAfter}).`;
  }
}

export const ElectronUpdaterError = Schema.Union([
  ElectronUpdaterCheckForUpdatesError,
  ElectronUpdaterDownloadUpdateError,
  ElectronUpdaterQuitAndInstallError,
]);
export type ElectronUpdaterError = typeof ElectronUpdaterError.Type;

export class ElectronUpdater extends Context.Service<
  ElectronUpdater,
  {
    readonly setFeedURL: (options: ElectronUpdaterFeedUrl) => Effect.Effect<void>;
    readonly setAutoDownload: (value: boolean) => Effect.Effect<void>;
    readonly setAutoInstallOnAppQuit: (value: boolean) => Effect.Effect<void>;
    readonly setChannel: (channel: string) => Effect.Effect<void>;
    readonly setAllowPrerelease: (value: boolean) => Effect.Effect<void>;
    readonly allowDowngrade: Effect.Effect<boolean>;
    readonly setAllowDowngrade: (value: boolean) => Effect.Effect<void>;
    readonly setFullChangelog: (value: boolean) => Effect.Effect<void>;
    readonly setDisableDifferentialDownload: (value: boolean) => Effect.Effect<void>;
    readonly checkForUpdates: Effect.Effect<void, ElectronUpdaterCheckForUpdatesError>;
    readonly downloadUpdate: Effect.Effect<void, ElectronUpdaterDownloadUpdateError>;
    readonly quitAndInstall: (options: {
      readonly isSilent: boolean;
      readonly isForceRunAfter: boolean;
    }) => Effect.Effect<void, ElectronUpdaterQuitAndInstallError>;
    readonly on: <Args extends ReadonlyArray<unknown>>(
      eventName: string,
      listener: (...args: Args) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronUpdater") {}

type UpdaterDriver = Pick<
  AutoUpdater,
  | "setFeedURL"
  | "autoDownload"
  | "autoInstallOnAppQuit"
  | "channel"
  | "allowPrerelease"
  | "allowDowngrade"
  | "fullChangelog"
  | "disableDifferentialDownload"
> & {
  checkForUpdates: () => Promise<unknown>;
  downloadUpdate: () => Promise<unknown>;
  quitAndInstall: (silent: boolean, restart: boolean) => void | Promise<void>;
};

const makeUpdaterService = (getUpdater: () => UpdaterDriver) =>
  ElectronUpdater.of({
    setFeedURL: (options) =>
      Effect.suspend(() => {
        getUpdater().setFeedURL(options);
        return Effect.void;
      }),
    setAutoDownload: (value) =>
      Effect.suspend(() => {
        getUpdater().autoDownload = value;
        return Effect.void;
      }),
    setAutoInstallOnAppQuit: (value) =>
      Effect.suspend(() => {
        getUpdater().autoInstallOnAppQuit = value;
        return Effect.void;
      }),
    setChannel: (channel) =>
      Effect.suspend(() => {
        getUpdater().channel = channel;
        return Effect.void;
      }),
    setAllowPrerelease: (value) =>
      Effect.suspend(() => {
        getUpdater().allowPrerelease = value;
        return Effect.void;
      }),
    allowDowngrade: Effect.sync(() => getUpdater().allowDowngrade),
    setAllowDowngrade: (value) =>
      Effect.suspend(() => {
        getUpdater().allowDowngrade = value;
        return Effect.void;
      }),
    setFullChangelog: (value) =>
      Effect.suspend(() => {
        getUpdater().fullChangelog = value;
        return Effect.void;
      }),
    setDisableDifferentialDownload: (value) =>
      Effect.suspend(() => {
        getUpdater().disableDifferentialDownload = value;
        return Effect.void;
      }),
    checkForUpdates: Effect.suspend(() => {
      const channel = getUpdater().channel;
      return Effect.tryPromise({
        try: () => getUpdater().checkForUpdates(),
        catch: (cause) => new ElectronUpdaterCheckForUpdatesError({ channel, cause }),
      }).pipe(Effect.asVoid);
    }),
    downloadUpdate: Effect.suspend(() => {
      const channel = getUpdater().channel;
      return Effect.tryPromise({
        try: () => getUpdater().downloadUpdate(),
        catch: (cause) => new ElectronUpdaterDownloadUpdateError({ channel, cause }),
      }).pipe(Effect.asVoid);
    }),
    quitAndInstall: ({ isSilent, isForceRunAfter }) =>
      Effect.suspend(() => {
        const channel = getUpdater().channel;
        return Effect.tryPromise({
          try: async () => {
            await getUpdater().quitAndInstall(isSilent, isForceRunAfter);
          },
          catch: (cause) =>
            new ElectronUpdaterQuitAndInstallError({
              channel,
              isSilent,
              isForceRunAfter,
              cause,
            }),
        });
      }),
    on: (eventName, listener) => {
      const eventTarget = getUpdater() as unknown as {
        on: (eventName: string, listener: (...args: Array<unknown>) => void) => void;
        removeListener: (eventName: string, listener: (...args: Array<unknown>) => void) => void;
      };
      const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
      return Effect.acquireRelease(
        Effect.sync(() => {
          eventTarget.on(eventName, untypedListener);
        }),
        () =>
          Effect.sync(() => {
            eventTarget.removeListener(eventName, untypedListener);
          }),
      ).pipe(Effect.asVoid);
    },
  });

/** @public Service construction is part of the canonical Effect module API. */
export const make = makeUpdaterService(() => autoUpdater);

export const layer = Layer.effect(
  ElectronUpdater,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (!isPersonalDesktopFork(environment.appVersion)) return make;
    const driver = new PersonalUpdater({
      version: environment.appVersion,
      platform: environment.platform,
      arch:
        environment.platform === "darwin"
          ? environment.runtimeInfo.hostArch
          : environment.runtimeInfo.appArch,
      executable: process.execPath,
      cacheDirectory: environment.path.join(environment.baseDir, "updates"),
      fetch: (input, init) => net.fetch(input instanceof URL ? input.toString() : input, init),
      quit: () => app.quit(),
    });
    return makeUpdaterService(() => driver);
  }),
);
