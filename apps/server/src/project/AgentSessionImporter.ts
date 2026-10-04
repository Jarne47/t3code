import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionImportSource,
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
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { historyResponseItems, selectHistory } from "../orchestration-v2/ContextHandoffBudget.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";

const IMPORT_EVENT_PREFIX = "agent-session-import:v2";
const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decodeImportedTranscriptPayload = Schema.decodeUnknownOption(
  Schema.Struct({
    cwd: Schema.optional(Schema.String),
    importedTranscripts: Schema.optional(Schema.Array(AgentSessionImportSource)),
  }),
);
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

function dateTime(value: string): DateTime.Utc {
  return DateTime.makeUnsafe(value);
}

function messageEvents(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly message: AgentSessionScanner.AgentSessionThreadMessage;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const ordinal = input.index + 1;
  const suffix = String(input.index).padStart(6, "0");
  const messageId = MessageId.make(`${input.threadId}:${suffix}`);
  const turnItemId = TurnItemId.make(
    `${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`,
  );
  const at = dateTime(input.message.createdAt);
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
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`),
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: turnItem,
    },
  ];
}

const make = Effect.gen(function* () {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const refreshedSources = new Map<ThreadId, ImportSource>();
  const pendingNativeReload = new Set<ThreadId>();
  const syncRecentAgentThreads = Effect.fn("importRecentAgentThreadsV2")(function* (
    input: AgentSessionImportInput,
    options?: {
      readonly importedOnly?: boolean;
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
    const runtimeRows = yield* (
      options?.targetThreadId === undefined
        ? runtimes.list()
        : runtimes
            .getByThreadId({ threadId: options.targetThreadId })
            .pipe(Effect.map(Option.toArray))
    ).pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    );
    const completedSources = runtimeRows.flatMap((runtime) => {
      const payload = decodeImportedTranscriptPayload(runtime.runtimePayload);
      if (
        Option.isNone(payload) ||
        payload.value.cwd === undefined ||
        normalizeProjectPathForComparison(payload.value.cwd) !==
          normalizeProjectPathForComparison(project.workspaceRoot)
      ) {
        return [];
      }
      return (payload.value.importedTranscripts ?? []).filter(
        (source) =>
          options?.targetThreadId === undefined ||
          options.targetThreadId ===
            `import:${source.providerInstanceId}:${source.providerSessionId}`,
      );
    });
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
          importedCount += 1;
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
          const sourceBusy = thread.activeTurnId !== undefined;
          if (sourceBusy && options?.allowActiveHistory !== true) {
            reason = "busy";
            return false;
          }
          if (
            thread.source === "claudeAgent" &&
            !CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId)
          ) {
            return yield* new AgentSessionUnresumableSessionError({
              source: thread.source,
              providerSessionId: thread.providerSessionId,
            });
          }
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
            if (
              options?.resumeNativeSession &&
              unresumedLegacyImport &&
              thread.source === "codex"
            ) {
              const driver = ProviderDriverKind.make("codex");
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
              yield* runtimes.recordImportedTranscript({ threadId, source });
              refreshedSources.set(threadId, source);
              pendingNativeReload.delete(threadId);
            }
            return true;
          }

          if (options?.targetThreadId !== undefined) return false;
          const driver = ProviderDriverKind.make(thread.source);
          const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL;
          const providerThreadId = idAllocator.derive.providerThread({
            driver,
            nativeThreadId: thread.providerSessionId,
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
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
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
            settledOverride: "settled",
            settledAt: updatedAt,
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
              nativeId: thread.providerSessionId,
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

          yield* runtimes.upsert(
            {
              threadId,
              providerName: driver,
              providerInstanceId: thread.providerInstanceId,
              adapterKey: driver,
              runtimeMode: DEFAULT_RUNTIME_MODE,
              status: "stopped",
              lastSeenAt: thread.updatedAt,
              resumeCursor:
                thread.source === "codex"
                  ? { threadId: thread.providerSessionId }
                  : { threadId, resume: thread.providerSessionId },
              runtimePayload: { cwd: project.workspaceRoot },
            },
            { onConflict: "ignore" },
          );
          yield* eventSink.write({
            events: [
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
                type: "thread.created",
                threadId,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: createdAt,
                payload: appThread,
              },
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
        if (imported) {
          importedThreadIds.add(threadId);
          importedCount += 1;
        } else {
          skippedCount += 1;
        }
      }),
    );

    return { importedCount, skippedCount, reason };
  });

  const importRecentAgentThreads = (
    input: AgentSessionImportInput,
    options?: { readonly importedOnly?: boolean },
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
      if (result.skippedCount > 0 || result.importedCount === 0) {
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

  return { importRecentAgentThreads, refreshThread };
});

type AgentSessionImporterShape = Effect.Success<typeof make>;

export class AgentSessionImporter extends Context.Service<
  AgentSessionImporter,
  AgentSessionImporterShape
>()("t3/project/AgentSessionImporter") {}

export const layer = Layer.effect(AgentSessionImporter, make);
