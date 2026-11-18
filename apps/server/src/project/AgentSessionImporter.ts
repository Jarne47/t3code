import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  isRuntimeModeAbove,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionScanError,
  AgentSessionSource,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  type AgentSessionImportSource as ImportSource,
  ThreadId,
  TurnItemId,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { historyResponseItems, selectHistory } from "@t3tools/provider-core/server/handoffBudget";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";

const isProjectionStoreThreadNotFoundError = Schema.is(
  ProjectionStore.ProjectionStoreThreadNotFoundError,
);

const IMPORT_EVENT_PREFIX = "agent-session-import:v2";
const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decodeImportedResumeCursor = Schema.decodeUnknownOption(
  Schema.Struct({
    threadId: Schema.optional(Schema.String),
    resume: Schema.optional(Schema.String),
  }),
);

class AgentSessionUnresumableSessionError extends Schema.TaggedError<AgentSessionUnresumableSessionError>()(
  "AgentSessionUnresumableSessionError",
  {
    source: AgentSessionSource,
    providerSessionId: Schema.String,
  },
) {
  override get message(): string {
    return `Session '${this.providerSessionId}' from '${this.source}' cannot be resumed.`;
  }
}

class AgentSessionThreadProjectConflictError extends Schema.TaggedError<AgentSessionThreadProjectConflictError>()(
  "AgentSessionThreadProjectConflictError",
  {
    threadId: ThreadId,
    expectedProjectId: ProjectId,
    actualProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' belongs to project '${this.actualProjectId}', not '${this.expectedProjectId}'.`;
  }
}

class AgentSessionThreadModifiedError extends Schema.TaggedError<AgentSessionThreadModifiedError>()(
  "AgentSessionThreadModifiedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' already contains non-imported activity.`;
  }
}

export class AgentSessionThreadRefreshError extends Schema.TaggedError<AgentSessionThreadRefreshError>()(
  "AgentSessionThreadRefreshError",
  {
    threadId: ThreadId,
    reason: Schema.Literals(["busy", "diverged", "unavailable"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "busy":
        return "This Codex conversation is still running. Wait for it to finish before replying here.";
      case "diverged":
        return "This conversation has a different native session. Its separate histories must be reconciled before sharing it with Codex.";
      case "unavailable":
        return "Could not refresh the linked conversation. Check that its source transcript is available and try again.";
    }
  }
}

const isThreadRefreshError = Schema.is(AgentSessionThreadRefreshError);
// ACP imports read the history while holding the session-mutation lock, and an agent can
// leave session/resume or initialize unanswered. Longer than session/load's own deadline.
const NATIVE_HISTORY_READ_TIMEOUT = "2 minutes";

/**
 * Whether a thread bound to a native session still lacks its native history.
 * Once a turn has run, the native session also holds that turn's messages, so
 * its history can no longer be imported as run-less items.
 */
export function isNativeHistoryPending(input: {
  readonly historyOrigin: OrchestrationV2AppThread["historyOrigin"];
  readonly hasRun: boolean;
}): boolean {
  return input.historyOrigin !== "v1_import" && !input.hasRun;
}

function dateTime(value: string): DateTime.Utc {
  return DateTime.makeUnsafe(value);
}

type HistoryMessage = Omit<AgentSessionScanner.AgentSessionThreadMessage, "role"> & {
  readonly role: AgentSessionScanner.AgentSessionThreadMessage["role"] | "reasoning";
};

function messageEvents(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly message: HistoryMessage;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const ordinal = input.index + 1;
  const suffix = String(input.index).padStart(6, "0");
  const messageId = MessageId.make(`${input.threadId}:${suffix}`);
  const turnItemId = TurnItemId.make(
    `${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`,
  );
  const at = dateTime(input.message.createdAt);
  const common = {
    id: turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef:
      input.message.nativeItemId === undefined
        ? null
        : {
            driver: ProviderDriverKind.make("codex"),
            nativeId: input.message.nativeItemId,
            strength: "strong" as const,
          },
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const turnItemEvent = (payload: OrchestrationV2TurnItem): OrchestrationV2DomainEvent => ({
    id: EventId.make(turnItemId),
    type: "turn-item.updated",
    threadId: input.threadId,
    occurredAt: at,
    payload,
  });
  if (input.message.role === "reasoning") {
    return [
      turnItemEvent({ ...common, type: "reasoning", text: input.message.text, streaming: false }),
    ];
  }
  const message: OrchestrationV2ConversationMessage = {
    createdBy: input.message.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    role: input.message.role,
    text: input.message.text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
  const turnItem: OrchestrationV2TurnItem =
    input.message.role === "user"
      ? {
          ...common,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: input.message.text,
          attachments: [],
        }
      : {
          ...common,
          type: "assistant_message",
          messageId,
          text: input.message.text,
          streaming: false,
        };
  return [
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${input.threadId}:${suffix}`),
      type: "message.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: message,
    },
    turnItemEvent(turnItem),
  ];
}

const make = Effect.gen(function* () {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const ceiling = settingsService.managedPolicy?.limits?.maxRuntimeMode;
  const refreshedSources = new Map<ThreadId, ImportSource>();
  const pendingNativeReload = new Set<ThreadId>();
  const syncRecentAgentThreads = Effect.fn("importRecentAgentThreadsV2")(function* (
    input: AgentSessionImportInput,
    options?: {
      readonly importedOnly?: boolean;
      readonly discoverNew?: boolean;
      readonly targetThreadId?: ThreadId;
      readonly resumeNativeSession?: boolean;
      readonly forceRead?: boolean;
      readonly allowActiveHistory?: boolean;
      readonly outcome?: AgentSessionScanner.AgentSessionRecentThread;
    },
  ) {
    const project = yield* projects.get(input.projectId).pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId: input.projectId })),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (
      input.expectedWorkspaceRoot !== undefined &&
      normalizeProjectPathForComparison(project.workspaceRoot) !==
        normalizeProjectPathForComparison(input.expectedWorkspaceRoot)
    ) {
      return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
    }
    // Imports run in full access, except under a policy ceiling: then in the project's default,
    // which the policy keeps under it, so imported threads never sit above the ceiling.
    const runtimeMode =
      ceiling === undefined
        ? DEFAULT_RUNTIME_MODE
        : yield* settingsService.getSettings.pipe(
            Effect.mapError(
              (cause) => new AgentSessionScanError({ operation: "read-settings", cause }),
            ),
            Effect.map((settings) => {
              const mode = resolveProjectSettings(settings, input.projectId, project).settings
                .defaultRuntimeMode;
              return isRuntimeModeAbove(mode, ceiling) ? ceiling : mode;
            }),
          );
    const runtimeRows = yield* (
      options?.targetThreadId === undefined
        ? runtimes.list()
        : runtimes
            .getByThreadId({ threadId: options.targetThreadId })
            .pipe(Effect.map(Option.toArray))
    ).pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    );
    // The thread's project owns its transcripts: a linked worktree import records the worktree as cwd.
    const completedSources = (yield* Effect.forEach(runtimeRows, (runtime) => {
      const imported = AgentSessionScanner.decodeImportedTranscriptPayload(
        runtime.runtimePayload,
      ).pipe(
        Option.flatMapNullishOr((payload) => payload.importedTranscripts),
        Option.map((sources) =>
          sources.filter(
            (source) =>
              options?.targetThreadId === undefined ||
              options.targetThreadId ===
                `import:${source.providerInstanceId}:${source.providerSessionId}`,
          ),
        ),
      );
      if (Option.isNone(imported) || imported.value.length === 0) return Effect.succeed([]);
      return orchestrator.getThreadRecords(runtime.threadId, []).pipe(
        Effect.map(({ thread }) => (thread.projectId === input.projectId ? imported.value : [])),
        Effect.catch((cause) =>
          isProjectionStoreThreadNotFoundError(cause.cause)
            ? Effect.succeed([])
            : Effect.fail(new AgentSessionScanError({ operation: "read-projects", cause })),
        ),
      );
    })).flat();
    // Background discovery follows projects already linked to external history.
    if (options?.discoverNew && completedSources.length === 0) {
      return { importedCount: 0, skippedCount: 0, reason: "unavailable" as const };
    }
    const locallyOwnedSessions = new Set(
      runtimeRows.flatMap((runtime) => {
        const cursor = decodeImportedResumeCursor(runtime.resumeCursor);
        if (Option.isNone(cursor)) return [];
        const nativeId =
          runtime.providerName === "codex" ? cursor.value.threadId : cursor.value.resume;
        const instanceId = runtime.providerInstanceId ?? runtime.providerName;
        if (nativeId === undefined || runtime.threadId === `import:${instanceId}:${nativeId}`)
          return [];
        return [`${instanceId}\0${nativeId}`];
      }),
    );
    if (options?.targetThreadId === undefined) {
      // V2 sessions persist their native identity in projections, not the
      // legacy runtime table. Check all bindings, including unloaded sessions.
      const bindings = yield* projections
        .getNativeThreadBindings()
        .pipe(
          Effect.mapError(
            (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
          ),
        );
      for (const binding of bindings) {
        if (binding.threadId !== `import:${binding.providerInstanceId}:${binding.nativeId}`) {
          locallyOwnedSessions.add(`${binding.providerInstanceId}\0${binding.nativeId}`);
        }
      }
    }
    const outcomes =
      options?.outcome === undefined
        ? scanner.recentThreads(project.workspaceRoot, completedSources, options)
        : Stream.succeed(options.outcome);
    const importedThreadIds = new Set<ThreadId>();
    let importedCount = 0;
    let skippedCount = 0;
    let reason: "busy" | "diverged" | "unavailable" = "unavailable";

    yield* Stream.runForEach(outcomes, (outcome) =>
      Effect.gen(function* () {
        if (outcome._tag === "Skipped") {
          skippedCount += 1;
          return;
        }
        const source = outcome.source;
        // A T3-owned native rollout must not become a second imported conversation.
        if (
          options?.targetThreadId === undefined &&
          locallyOwnedSessions.has(`${source.providerInstanceId}\0${source.providerSessionId}`)
        )
          return;
        const threadId =
          options?.outcome === undefined
            ? ThreadId.make(`import:${source.providerInstanceId}:${source.providerSessionId}`)
            : options.targetThreadId!;
        if (options?.targetThreadId !== undefined && threadId !== options.targetThreadId) {
          skippedCount += 1;
          return;
        }
        if (outcome._tag === "AlreadyImported") {
          importedThreadIds.add(threadId);
          return;
        }
        if (outcome._tag === "Duplicate") {
          if (importedThreadIds.has(threadId)) {
            yield* runtimes.recordImportedTranscript({ threadId, source }).pipe(Effect.ignore);
          }
          return;
        }

        const imported = yield* Effect.gen(function* () {
          const thread = outcome.thread;
          if (
            thread.source === "claudeAgent" &&
            !CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId)
          ) {
            return yield* new AgentSessionUnresumableSessionError({
              source: thread.source,
              providerSessionId: thread.providerSessionId,
            });
          }
          const driver = ProviderDriverKind.make(thread.source);
          // Pi resumes by session file path; its session UUID only names the thread.
          const nativeThreadId =
            thread.source === "pi" ? source.filePath : thread.providerSessionId;
          const persistRuntime = runtimes.upsert(
            {
              threadId,
              providerName: driver,
              providerInstanceId: thread.providerInstanceId,
              adapterKey: driver,
              runtimeMode,
              status: "stopped",
              lastSeenAt: thread.updatedAt,
              resumeCursor:
                thread.source === "claudeAgent"
                  ? { threadId, resume: thread.providerSessionId }
                  : { threadId: nativeThreadId },
              runtimePayload: { cwd: outcome.worktree?.path ?? project.workspaceRoot },
            },
            { onConflict: "ignore" },
          );
          const existing = yield* Effect.option(
            orchestrator.getThreadRecords(threadId, [
              "messages",
              "turnItems",
              "runs",
              "providerThreads",
              "providerTurns",
              "contextHandoffs",
            ]),
          );
          // When T3 stops a turn whose app-server exits before writing
          // turn_aborted, the rollout keeps that turn open forever. T3's own run
          // state, checked below, decides whether a turn it started is busy.
          const ownsActiveTurn =
            Option.isSome(existing) &&
            existing.value.providerTurns.some(
              (turn) =>
                turn.nativeTurnRef?.driver === "codex" &&
                turn.nativeTurnRef.nativeId === thread.activeTurnId,
            );
          const sourceBusy = thread.activeTurnId !== undefined && !ownsActiveTurn;
          if (sourceBusy && options?.allowActiveHistory !== true) {
            reason = "busy";
            return false;
          }
          if (Option.isSome(existing)) {
            if (existing.value.thread.projectId !== input.projectId) {
              return yield* new AgentSessionThreadProjectConflictError({
                threadId,
                expectedProjectId: input.projectId,
                actualProjectId: existing.value.thread.projectId,
              });
            }
            if (
              options?.outcome === undefined &&
              existing.value.thread.historyOrigin !== "v1_import"
            ) {
              return yield* new AgentSessionThreadModifiedError({ threadId });
            }
            const snapshot = existing.value;
            const activeProvider = snapshot.providerThreads.find(
              (provider) => provider.id === snapshot.thread.activeProviderThreadId,
            );
            let unresumedLegacyImport = false;
            // An untouched migration can recover the original binding when opened.
            // Once either native identity changed, never combine the two conversations.
            if (
              snapshot.thread.activeProviderThreadId === null &&
              snapshot.providerThreads.length === 0 &&
              snapshot.runs.length === 0
            ) {
              const runtime = yield* runtimes.getByThreadId({ threadId });
              if (
                Option.isSome(runtime) &&
                runtime.value.status === "stopped" &&
                runtime.value.providerName === thread.source &&
                (runtime.value.providerInstanceId ?? runtime.value.providerName) ===
                  thread.providerInstanceId
              ) {
                const cursor = decodeImportedResumeCursor(runtime.value.resumeCursor);
                unresumedLegacyImport =
                  Option.isSome(cursor) &&
                  (thread.source === "codex" ? cursor.value.threadId : cursor.value.resume) ===
                    thread.providerSessionId;
              }
            }
            const nativeSessionMatches =
              activeProvider?.nativeThreadRef?.nativeId === thread.providerSessionId &&
              activeProvider?.providerInstanceId === thread.providerInstanceId;
            // Do not import over an active turn or a thread that has switched its native session.
            const busy =
              snapshot.runs.some(
                (run) =>
                  !["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(
                    run.status,
                  ),
              ) || (activeProvider?.pendingBackgroundTasks?.length ?? 0) > 0;
            if (
              snapshot.thread.deletedAt !== null ||
              busy ||
              (!nativeSessionMatches && !unresumedLegacyImport)
            ) {
              reason = busy ? "busy" : "diverged";
              return false;
            }
            const latest = snapshot.messages.reduce(
              (at, message) => Math.max(at, DateTime.toEpochMillis(message.updatedAt)),
              DateTime.toEpochMillis(snapshot.thread.createdAt),
            );
            const counts = new Map<string, number>();
            const key = (message: { role: string; text: string; createdAt: string }) =>
              JSON.stringify([message.role, message.text, Date.parse(message.createdAt)]);
            for (const message of snapshot.messages) {
              const messageKey = key({
                ...message,
                createdAt: DateTime.formatIso(message.createdAt),
              });
              counts.set(messageKey, (counts.get(messageKey) ?? 0) + 1);
            }
            const nativeItems = new Set(
              snapshot.turnItems.flatMap((item) =>
                item.nativeItemRef?.driver === "codex" ? [item.nativeItemRef.nativeId] : [],
              ),
            );
            const localNativeTurns = new Set(
              snapshot.providerTurns.flatMap((turn) =>
                turn.nativeTurnRef?.driver === "codex" ? [turn.nativeTurnRef.nativeId] : [],
              ),
            );
            // Native rollouts also contain the history T3 injected during a
            // migration/provider switch. Those attributed copies are context,
            // not new replies from another client.
            const hasInjectedHistory = snapshot.contextHandoffs.some(
              (handoff) =>
                handoff.delivery?.status === "injected" &&
                handoff.delivery.nativeThreadId === thread.providerSessionId,
            );
            const injectedMessages = new Set(
              snapshot.contextHandoffs.flatMap((handoff) => {
                if (
                  handoff.delivery?.status !== "injected" ||
                  handoff.delivery.nativeThreadId !== thread.providerSessionId ||
                  handoff.history === undefined
                )
                  return [];
                const selectedIds = new Set(handoff.delivery.itemIds);
                const selected = handoff.history.messages.filter((message) =>
                  selectedIds.has(message.itemId),
                );
                const replay = selectHistory({
                  messages: selected,
                  coverage: handoff.history.coverage,
                  omittedItems:
                    handoff.history.omittedItems +
                    handoff.history.messages.length -
                    selected.length,
                  budget: Number.POSITIVE_INFINITY,
                });
                return historyResponseItems(replay.messages, replay.context).map((item) =>
                  JSON.stringify([
                    item.role,
                    item.content
                      .map((block) => block.text)
                      .join("\n")
                      .trim(),
                  ]),
                );
              }),
            );
            const additions = thread.messages.filter((message) => {
              if (sourceBusy && message.nativeTurnId === thread.activeTurnId) return false;
              // Before a native turn, Codex may record AGENTS/environment setup
              // around T3's injected history. It is not a submitted user turn.
              if (hasInjectedHistory && message.nativeContext === true) return false;
              if (injectedMessages.has(JSON.stringify([message.role, message.text.trim()])))
                return false;
              if (message.nativeItemId !== undefined && nativeItems.has(message.nativeItemId))
                return false;
              // T3 already owns all events from these turns, including steering
              // and generated instruction messages written to the native rollout.
              if (message.nativeTurnId !== undefined && localNativeTurns.has(message.nativeTurnId))
                return false;
              const messageKey = key(message);
              const count = counts.get(messageKey) ?? 0;
              if (count > 0) {
                counts.set(messageKey, count - 1);
                return false;
              }
              return (
                (options?.outcome !== undefined && message.nativeTurnId !== undefined) ||
                Date.parse(message.createdAt) >= latest
              );
            });
            const nextIndex = snapshot.turnItems.reduce(
              (ordinal, item) => Math.max(ordinal, item.ordinal),
              0,
            );
            const events = additions.flatMap((message, index) =>
              messageEvents({ threadId, index: nextIndex + index, message }),
            );
            // Repair old setup-derived imports without overwriting a title chosen in T3.
            if (
              thread.title !== snapshot.thread.title &&
              (/^<(recommended_plugins|environment_context|user_instructions)>$/.test(
                snapshot.thread.title.trim(),
              ) ||
                snapshot.thread.title.startsWith("# AGENTS.md instructions for "))
            ) {
              const updatedAt = dateTime(thread.updatedAt);
              events.push({
                id: EventId.make(
                  `${IMPORT_EVENT_PREFIX}:title:${threadId}:${source.mtimeMs}:${source.size}`,
                ),
                type: "thread.metadata-updated",
                threadId,
                occurredAt: updatedAt,
                payload: { ...snapshot.thread, title: thread.title, updatedAt },
              });
            }
            if (
              options?.resumeNativeSession &&
              unresumedLegacyImport &&
              thread.source === "codex"
            ) {
              const providerThreadId = idAllocator.derive.providerThread({
                driver,
                providerInstanceId: thread.providerInstanceId,
                nativeThreadId: thread.providerSessionId,
              });
              const updatedAt = dateTime(thread.updatedAt);
              events.push({
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:native-binding:${threadId}`),
                type: "provider-thread.updated",
                threadId,
                driver,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: updatedAt,
                payload: {
                  id: providerThreadId,
                  driver,
                  providerInstanceId: thread.providerInstanceId,
                  providerSessionId: null,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: {
                    driver,
                    nativeId: thread.providerSessionId,
                    strength: "strong",
                  },
                  nativeConversationHeadRef: null,
                  nativeMetadata: { sharedHistory: true },
                  status: "not_loaded",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  pendingBackgroundTasks: [],
                  createdAt: snapshot.thread.createdAt,
                  updatedAt,
                },
              });
            }
            if (
              options?.outcome !== undefined &&
              activeProvider !== undefined &&
              activeProvider.nativeMetadata?.sharedHistory !== true
            ) {
              events.push({
                id: EventId.make(
                  `${IMPORT_EVENT_PREFIX}:shared-history:${threadId}:${activeProvider.id}`,
                ),
                type: "provider-thread.updated",
                threadId,
                occurredAt: snapshot.thread.updatedAt,
                payload: {
                  ...activeProvider,
                  updatedAt: snapshot.thread.updatedAt,
                  nativeMetadata: {
                    ...activeProvider.nativeMetadata,
                    sharedHistory: true,
                  },
                },
              });
            }
            // An idle app-server may still hold the context from its last turn. Its
            // next resume must reload the shared transcript after an external write.
            if (sourceBusy && additions.length > 0) pendingNativeReload.add(threadId);
            if (
              !sourceBusy &&
              (additions.length > 0 || pendingNativeReload.has(threadId)) &&
              activeProvider?.providerSessionId !== null &&
              activeProvider?.providerSessionId !== undefined &&
              thread.source === "codex"
            ) {
              yield* providerSessions.detach({
                providerSessionId: activeProvider.providerSessionId,
                threadId,
                detail: "External conversation history refreshed",
                requireUnload: true,
              });
            }
            if (events.length > 0) {
              yield* eventSink.write({
                events,
              });
            }
            // A busy rollout must be read again: caching its fingerprint would
            // let a subsequent reply bypass the active-turn check.
            if (!sourceBusy) {
              yield* persistRuntime;
              yield* runtimes.recordImportedTranscript({ threadId, source });
              refreshedSources.set(threadId, source);
              pendingNativeReload.delete(threadId);
            }
            // A targeted refresh reports success; a rescan counts only appended history.
            if (options?.targetThreadId !== undefined || additions.length > 0) return true;
            importedThreadIds.add(threadId);
            return null;
          }

          if (options?.targetThreadId !== undefined) return false;
          const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL;
          const providerThreadId = idAllocator.derive.providerThread({
            driver,
            providerInstanceId: thread.providerInstanceId,
            nativeThreadId,
          });
          const createdAt = dateTime(thread.createdAt);
          const updatedAt = dateTime(thread.updatedAt);
          const appThread: OrchestrationV2AppThread = {
            createdBy: "system",
            creationSource: "server",
            id: threadId,
            projectId: input.projectId,
            title: thread.title.trim() === "" ? "Untitled thread" : thread.title,
            providerInstanceId: thread.providerInstanceId,
            modelSelection: { instanceId: thread.providerInstanceId, model },
            runtimeMode,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: outcome.worktree?.branch ?? null,
            worktreePath: outcome.worktree?.path ?? null,
            linkedPullRequest: null,
            branchPullRequest: null,
            activeProviderThreadId: providerThreadId,
            historyOrigin: "v1_import",
            lineage: {
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: threadId,
            },
            forkedFrom: null,
            createdAt,
            updatedAt,
            archivedAt: null,
            settledOverride: options?.discoverNew ? null : "settled",
            settledAt: options?.discoverNew ? null : updatedAt,
            unsettledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            pinnedAt: null,
            pinOrderKey: null,
            activeOrderKey: null,
            lastVisitedAt: null,
            deletedAt: null,
          };
          const providerThread: OrchestrationV2ProviderThread = {
            id: providerThreadId,
            driver,
            providerInstanceId: thread.providerInstanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: {
              driver,
              nativeId: nativeThreadId,
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [],
            createdAt,
            updatedAt,
          };

          const committed = yield* eventSink.write({
            unlessNativeThreadOwned: providerThread,
            events: [
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
                type: "thread.created",
                threadId,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: createdAt,
                payload: appThread,
              },
              ...(thread.omittedMessageCount > 0
                ? [
                    {
                      id: EventId.make(`${IMPORT_EVENT_PREFIX}:history-truncated:${threadId}`),
                      type: "turn-item.updated" as const,
                      threadId,
                      occurredAt: createdAt,
                      payload: {
                        id: TurnItemId.make(`${IMPORT_EVENT_PREFIX}:history-truncated:${threadId}`),
                        threadId,
                        runId: null,
                        nodeId: null,
                        providerThreadId: null,
                        providerTurnId: null,
                        nativeItemRef: null,
                        parentItemId: null,
                        ordinal: 0,
                        status: "completed" as const,
                        title: null,
                        startedAt: createdAt,
                        completedAt: createdAt,
                        updatedAt: createdAt,
                        type: "system_notice" as const,
                        message: `${thread.omittedMessageCount} earlier ${thread.omittedMessageCount === 1 ? "message was" : "messages were"} not imported. This thread keeps the first user message and the most recent history. The original session transcript is unchanged.`,
                      },
                    },
                  ]
                : []),
              ...thread.messages.flatMap((message, index) =>
                messageEvents({ threadId, index, message }),
              ),
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:provider-thread:${providerThreadId}`),
                type: "provider-thread.updated",
                threadId,
                driver,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: updatedAt,
                payload: providerThread,
              },
            ],
          });
          if (committed.length === 0) return null;
          yield* persistRuntime;
          yield* runtimes.recordImportedTranscript({ threadId, source });
          return true;
        }).pipe(
          (effect) => threadCommands.withLock(threadId, effect),
          Effect.catch((cause) =>
            Effect.logWarning("Could not import an agent session", {
              provider: outcome.thread.source,
              sessionId: outcome.thread.providerSessionId,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
        if (imported === true) {
          importedThreadIds.add(threadId);
          importedCount += 1;
        } else if (imported === false) {
          skippedCount += 1;
        }
      }),
    );

    const targetCurrent =
      options?.targetThreadId !== undefined && importedThreadIds.has(options.targetThreadId);
    return { importedCount, skippedCount, reason, targetCurrent };
  });

  const importRecentAgentThreads = (
    input: AgentSessionImportInput,
    options?: { readonly importedOnly?: boolean; readonly discoverNew?: boolean },
  ) =>
    syncRecentAgentThreads(input, options).pipe(
      Effect.map(({ importedCount, skippedCount }): AgentSessionImportResult => ({
        importedCount,
        skippedCount,
      })),
    );

  const refreshThread = Effect.fn("refreshImportedAgentThread")(
    function* (threadId: ThreadId, options?: { readonly forReply?: boolean }) {
      const shell = yield* orchestrator.getThreadShell(threadId);
      if (shell === null || shell.activeRunId !== null) return;
      const records = yield* orchestrator.getThreadRecords(threadId, ["providerThreads"]);
      const provider = records.providerThreads.find(
        (candidate) => candidate.id === shell.activeProviderThreadId,
      );
      const nativeId =
        provider?.nativeThreadRef?.driver === "codex"
          ? (provider.nativeThreadRef.nativeId ?? undefined)
          : undefined;
      if (nativeId === undefined) {
        if (provider !== undefined || !threadId.startsWith("import:")) return;
        const runtime = yield* runtimes.getByThreadId({ threadId });
        if (Option.isNone(runtime) || runtime.value.providerName !== "codex") return;
      }
      const outcome =
        nativeId === undefined
          ? undefined
          : yield* scanner.readCodexThread(
              provider!.providerInstanceId,
              nativeId,
              refreshedSources.get(threadId),
            );
      const result = yield* syncRecentAgentThreads(
        { projectId: shell.projectId },
        {
          importedOnly: true,
          targetThreadId: threadId,
          resumeNativeSession: true,
          allowActiveHistory: options?.forReply !== true,
          forceRead: shell.activeProviderThreadId === null,
          ...(outcome === undefined ? {} : { outcome }),
        },
      );
      if (result.skippedCount > 0 || !result.targetCurrent) {
        const error = new AgentSessionThreadRefreshError({ threadId, reason: result.reason });
        if (options?.forReply) return yield* error;
        yield* Effect.logWarning(error.message, { threadId });
      }
    },
    (effect, threadId, _options?: { readonly forReply?: boolean }) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isThreadRefreshError(cause)
            ? cause
            : new AgentSessionThreadRefreshError({ threadId, reason: "unavailable", cause }),
        ),
      ),
  );

  /**
   * Loading a native session replays its history only into the adapter's own
   * snapshot, so copy that snapshot into the thread as run-less history. The
   * `v1_import` origin keeps it in forks and marks the import done, so a call
   * after a failed read repairs the thread and any later call does nothing.
   */
  const importNativeHistory = Effect.fn("importNativeHistoryV2")(function* (input: {
    readonly threadId: ThreadId;
    readonly workspaceRoot: string;
  }) {
    const pendingThread = Effect.map(
      orchestrator.getThreadRecords(input.threadId, ["providerThreads", "runs"]),
      (records) =>
        isNativeHistoryPending({
          historyOrigin: records.thread.historyOrigin,
          hasRun: records.runs.length > 0,
        })
          ? records
          : null,
    );
    // Thread commands write whole thread rows, so hold their lock from the
    // re-read through the write to keep both this marker and their changes.
    const commit = (messages: ReadonlyArray<HistoryMessage>) =>
      threadCommands.withLock(
        input.threadId,
        Effect.gen(function* () {
          const current = yield* pendingThread;
          if (current === null) return 0;
          yield* eventSink.write({
            events: [
              ...messages.flatMap((message, index) =>
                messageEvents({ threadId: input.threadId, index, message }),
              ),
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${input.threadId}:native-history`),
                type: "thread.metadata-updated",
                threadId: input.threadId,
                providerInstanceId: current.thread.providerInstanceId,
                occurredAt: yield* DateTime.now,
                payload: { ...current.thread, historyOrigin: "v1_import" },
              },
            ],
          });
          return messages.length;
        }),
      );
    const records = yield* pendingThread;
    if (records === null) return 0;
    const { thread, providerThreads } = records;
    const providerThread = providerThreads.find(
      (candidate) => candidate.appThreadId === input.threadId && candidate.nativeThreadRef !== null,
    );
    const nativeThreadId = providerThread?.nativeThreadRef?.nativeId;
    if (providerThread === undefined || nativeThreadId == null) return 0;
    const providerSessionId = yield* idAllocator.allocate.providerSession({
      providerInstanceId: providerThread.providerInstanceId,
      threadId: input.threadId,
    });
    // The registry admits this open against sign-in changes, like any other open.
    const adapter = yield* registry.get(thread.modelSelection.instanceId);
    const snapshot = yield* adapter
      .openSession({
        threadId: input.threadId,
        providerSessionId,
        modelSelection: thread.modelSelection,
        runtimePolicy: {
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          cwd: thread.worktreePath ?? input.workspaceRoot,
        },
        initialNativeThreadId: nativeThreadId,
        ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
          ? {}
          : {
              initialProviderItemIdentityVersion: providerThread.nativeMetadata.itemIdentityVersion,
            }),
      })
      .pipe(
        Effect.flatMap((session) => session.readThreadSnapshot({ providerThread })),
        Effect.timeout(NATIVE_HISTORY_READ_TIMEOUT),
        Effect.scoped,
      );
    const reasoningIds = new Set(snapshot.reasoningMessageIds);
    const messages = snapshot.messages.flatMap((message) =>
      (message.role === "user" || message.role === "assistant") && message.text.trim() !== ""
        ? [
            {
              role: reasoningIds.has(message.id) ? ("reasoning" as const) : message.role,
              text: message.text,
              createdAt: DateTime.formatIso(message.createdAt),
            },
          ]
        : [],
    );
    // Loading the session can take a while, and the thread is usable meanwhile.
    return yield* commit(messages);
  });

  return { importRecentAgentThreads, refreshThread, importNativeHistory };
});

type AgentSessionImporterShape = Effect.Success<typeof make>;

export class AgentSessionImporter extends Context.Service<
  AgentSessionImporter,
  AgentSessionImporterShape
>()("t3/project/AgentSessionImporter") {}

export const layer = Layer.effect(AgentSessionImporter, make);
