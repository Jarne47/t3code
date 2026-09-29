/**
 * OpenCodeDriver — `ProviderDriver` for the OpenCode runtime.
 *
 * Mirrors the Codex / Claude drivers: a plain value whose `create()`
 * bundles `snapshot` / `adapter` / `textGeneration` closures over the
 * per-instance `OpenCodeSettings`.
 *
 * Two instances with different `serverUrl`s therefore talk to independent
 * OpenCode servers; when no `serverUrl` is set, the adapter + text-generation
 * shares spin up their own scoped child processes, and those child
 * processes are released when the registry scope closes.
 *
 * @module provider/Drivers/OpenCodeDriver
 */
import { OpenCodeSettings, ProviderDriverKind, TextGenerationError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeOpenCodeTextGeneration } from "../../textGeneration/OpenCodeTextGeneration.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import {
  OpenCodeAdapterV2Driver,
  type OpenCodeAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/OpenCodeAdapterV2.ts";
import {
  ProviderAdapterCapabilitiesError,
  ProviderAdapterOpenSessionError,
  type ProviderAdapterV2Shape,
} from "../../orchestration-v2/ProviderAdapter.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { readOpenCodeGoUsageLimits } from "../Layers/openCodeUsageLimits.ts";
import {
  checkOpenCodeProviderStatus,
  makePendingOpenCodeProvider,
  openCodeSkillsToServerProviderSkills,
  openCodeCommandsToServerProviderSlashCommands,
} from "../Layers/OpenCodeProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { OpenCodeRuntime, OpenCodeRuntimeError, loadOpenCodeCommands } from "../opencodeRuntime.ts";
import {
  makeOpenCodeRuntimeProbe,
  OPENCODE_2_UNSUPPORTED_MESSAGE,
  probeOpenCodeRuntime,
  type ProbedOpenCode,
} from "../opencodeVersionProbe.ts";
import * as OpenCodeServerOwner from "../OpenCodeServerOwner.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
const decodeOpenCodeSettings = Schema.decodeSync(OpenCodeSettings);

const DRIVER_KIND = ProviderDriverKind.make("opencode");

function isOpenCodeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.opencode/bin/opencode") ||
    normalized.endsWith("/.opencode/bin/opencode.exe")
  );
}

const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "opencode-ai",
  nativeUpdate: {
    args: ["upgrade"],
    isCommandPath: isOpenCodeNativeCommandPath,
  },
});

const openCode2Unsupported = () =>
  new OpenCodeRuntimeError({
    operation: "selectOpenCodeRuntime",
    detail: OPENCODE_2_UNSUPPORTED_MESSAGE,
  });

type OpenCodeRuntimeProbe = Effect.Success<
  ReturnType<typeof makeOpenCodeRuntimeProbe<OpenCodeRuntimeError>>
>;

/**
 * Runs `use` only when the instance is not 2.x, since only the 1.x runtime exists so far. A failed
 * probe keeps the 1.x path, whose own server checks report the failure.
 */
function onOpenCodeV1<A, E, R, PE>(
  probed: Effect.Effect<ProbedOpenCode | undefined, PE>,
  use: Effect.Effect<A, E, R>,
  refuse: (cause: OpenCodeRuntimeError) => E,
): Effect.Effect<A, E, R> {
  return probed.pipe(
    Effect.orElseSucceed(() => undefined),
    Effect.flatMap((result) =>
      result?.generation === "v2" ? Effect.fail(refuse(openCode2Unsupported())) : use,
    ),
  );
}

/**
 * Routes each adapter call to the runtime the instance's probe detected. Capability and selection
 * reads are hot, so they use the last successful probe (1.x before one lands) and never wait on a
 * slow server. Opening a session waits for a probe, so a 2.x is refused before it is spoken to.
 */
function selectOpenCodeRuntimeAdapter(input: {
  readonly probe: OpenCodeRuntimeProbe;
  readonly v1: ProviderAdapterV2Shape;
}): ProviderAdapterV2Shape {
  const lastSuccess = Effect.map(input.probe.lastSuccess, Option.getOrUndefined);
  const capabilitiesError = (cause: OpenCodeRuntimeError) =>
    new ProviderAdapterCapabilitiesError({ driver: DRIVER_KIND, cause });
  return {
    instanceId: input.v1.instanceId,
    driver: DRIVER_KIND,
    getCapabilities: () => onOpenCodeV1(lastSuccess, input.v1.getCapabilities(), capabilitiesError),
    planSelectionTransition: (transition) =>
      onOpenCodeV1(lastSuccess, input.v1.planSelectionTransition(transition), capabilitiesError),
    openSession: (session) =>
      onOpenCodeV1(
        input.probe.get,
        input.v1.openSession(session),
        (cause) =>
          new ProviderAdapterOpenSessionError({
            driver: DRIVER_KIND,
            providerSessionId: session.providerSessionId,
            cause,
          }),
      ),
  };
}

/** Text generation starts or connects to a server per call, so a 2.x is refused first. */
function selectOpenCodeRuntimeTextGeneration(
  probe: OpenCodeRuntimeProbe,
  v1: TextGeneration["Service"],
): TextGeneration["Service"] {
  const refuse = (operation: string) => (cause: OpenCodeRuntimeError) =>
    new TextGenerationError({ operation, detail: cause.detail, cause });
  return {
    generateCommitMessage: (input) =>
      onOpenCodeV1(probe.get, v1.generateCommitMessage(input), refuse("generateCommitMessage")),
    generatePrContent: (input) =>
      onOpenCodeV1(probe.get, v1.generatePrContent(input), refuse("generatePrContent")),
    generateBranchName: (input) =>
      onOpenCodeV1(probe.get, v1.generateBranchName(input), refuse("generateBranchName")),
    generateThreadTitle: (input) =>
      onOpenCodeV1(probe.get, v1.generateThreadTitle(input), refuse("generateThreadTitle")),
  };
}

export type OpenCodeDriverEnv =
  | OpenCodeAdapterV2DriverEnv
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | OpenCodeRuntime
  | Path.Path
  | ServerConfig
  | ServerSettingsService;

export const OpenCodeDriver: ProviderDriver<OpenCodeSettings, OpenCodeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OpenCode",
    supportsMultipleInstances: true,
  },
  configSchema: OpenCodeSettings,
  defaultConfig: (): OpenCodeSettings => decodeOpenCodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const openCodeRuntime = yield* OpenCodeRuntime;
      const serverConfig = yield* ServerConfig;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies OpenCodeSettings;
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, pathService),
        ),
      );

      const runtimeProbe = yield* makeOpenCodeRuntimeProbe(
        probeOpenCodeRuntime(effectiveConfig, processEnv).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(OpenCodeRuntime, openCodeRuntime),
        ),
      );
      const openCodeV1Adapter = yield* OpenCodeAdapterV2Driver.create({
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build OpenCode orchestration adapter.",
              cause,
            }),
        ),
      );
      const orchestrationAdapter = selectOpenCodeRuntimeAdapter({
        probe: runtimeProbe,
        v1: openCodeV1Adapter,
      });
      const serverOwner = yield* OpenCodeServerOwner.make({
        binaryPath: effectiveConfig.binaryPath,
        directory: serverConfig.cwd,
        ...(effectiveConfig.serverPassword
          ? { serverPassword: effectiveConfig.serverPassword }
          : {}),
        environment: processEnv,
      });
      const textGeneration = selectOpenCodeRuntimeTextGeneration(
        runtimeProbe,
        yield* makeOpenCodeTextGeneration(effectiveConfig).pipe(
          Effect.provideService(OpenCodeServerOwner.OpenCodeServerOwner, serverOwner),
        ),
      );

      const checkProvider = Effect.all(
        {
          provider: checkOpenCodeProviderStatus(
            effectiveConfig,
            serverConfig.cwd,
            runtimeProbe.refresh,
          ),
          usageLimits: readOpenCodeGoUsageLimits({
            enabled: effectiveConfig.enabled,
            serverUrl: effectiveConfig.serverUrl,
            environment: processEnv,
          }),
        },
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map(({ provider, usageLimits }) => ({ ...provider, usageLimits })),
        Effect.map(stampIdentity),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.provideService(OpenCodeServerOwner.OpenCodeServerOwner, serverOwner),
        Effect.provideService(OpenCodeRuntime, openCodeRuntime),
      );
      // NOTE: the local branch intentionally uses the shared SDK server
      // instead of `opencode debug skill` (loadSkillsFromCli). The CLI writes
      // its full JSON inventory to stdout, but the Bun-compiled binary does
      // not flush more than one 64KB pipe buffer to a non-TTY stdout, so the
      // piped output arrives truncated and unparseable — which degrades to an
      // empty skill list and poisons the workspace snapshot the `$` picker
      // reads. The SDK `app.skills` endpoint honors the per-request directory
      // and returns complete results regardless of size.
      const loadWorkspaceInventory = (client: Parameters<typeof loadOpenCodeCommands>[0]) =>
        Effect.all(
          {
            skills: openCodeRuntime.loadOpenCodeSkills(client),
            commands: loadOpenCodeCommands(client).pipe(
              Effect.timeout("10 seconds"),
              Effect.orElseSucceed(() => []),
            ),
          },
          { concurrency: "unbounded" },
        );
      const loadWorkspaceForCwd = (cwd: string) =>
        effectiveConfig.serverUrl.trim().length > 0
          ? Effect.scoped(
              Effect.gen(function* () {
                const server = yield* openCodeRuntime.connectToOpenCodeServer({
                  binaryPath: effectiveConfig.binaryPath,
                  directory: cwd,
                  serverUrl: effectiveConfig.serverUrl,
                  ...(effectiveConfig.serverPassword
                    ? { serverPassword: effectiveConfig.serverPassword }
                    : {}),
                  environment: processEnv,
                });
                const client = openCodeRuntime.createOpenCodeSdkClient({
                  baseUrl: server.url,
                  directory: cwd,
                  ...(effectiveConfig.serverPassword
                    ? { serverPassword: effectiveConfig.serverPassword }
                    : {}),
                });
                return yield* loadWorkspaceInventory(client);
              }),
            )
          : serverOwner.withServer((server) =>
              loadWorkspaceInventory(
                openCodeRuntime.createOpenCodeSdkClient({
                  baseUrl: server.url,
                  directory: cwd,
                  ...(server.serverPassword !== undefined
                    ? { serverPassword: server.serverPassword }
                    : {}),
                }),
              ),
            );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OpenCodeSettings>>(
        {
          resolveMaintenance,
          getSettings: snapshotSettings.getSettings,
          streamSettings: snapshotSettings.streamSettings,
          haveSettingsChanged: haveProviderSnapshotSettingsChanged,
          checkProviderOnSettingsChange: () => false,
          refreshOnInterval: false,
          initialSnapshot: (settings) =>
            makePendingOpenCodeProvider(settings.provider).pipe(Effect.map(stampIdentity)),
          checkProvider,
          enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
            resolveMaintenance().pipe(
              Effect.flatMap((maintenanceCapabilities) =>
                enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
                  enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
                }),
              ),
              Effect.provideService(HttpClient.HttpClient, httpClient),
              Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
            ),
        },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build OpenCode snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        snapshotForCwd: (cwd) =>
          !effectiveConfig.enabled
            ? snapshot.getSnapshot
            : Effect.all([
                snapshot.getSnapshot,
                onOpenCodeV1(
                  runtimeProbe.get,
                  loadWorkspaceForCwd(cwd).pipe(Effect.timeout("20 seconds")),
                  (cause) => cause,
                ),
              ]).pipe(
                Effect.map(([machineSnapshot, { skills, commands }]) => ({
                  ...machineSnapshot,
                  skills: openCodeSkillsToServerProviderSkills(skills),
                  slashCommands: openCodeCommandsToServerProviderSlashCommands(commands),
                })),
                Effect.mapError(
                  (cause) =>
                    new ProviderDriverError({
                      driver: DRIVER_KIND,
                      instanceId,
                      detail: `Failed to probe OpenCode commands and skills for '${cwd}'`,
                      cause,
                    }),
                ),
              ),
        orchestrationAdapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
