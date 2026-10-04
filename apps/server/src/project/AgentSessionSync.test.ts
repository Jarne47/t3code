import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  TurnItemId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { historyResponseItems, selectHistory } from "../orchestration-v2/ContextHandoffBudget.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";

const encodeTranscriptRecord = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const nativeId = "01a0aa9c-d1e2-7c92-b569-fe56e5e8f83f";
const instanceId = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("shared-conversation-project");
const at = (minute: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(Date.parse("2026-09-01T10:00:00Z") + minute * 60_000));
const turn = (id: string, minute: number, text: string, complete = true) => [
  { type: "event_msg", timestamp: at(minute), payload: { type: "task_started", turn_id: id } },
  { type: "event_msg", timestamp: at(minute), payload: { type: "user_message", message: text } },
  {
    type: "response_item",
    timestamp: at(minute + 1),
    payload: {
      type: "message",
      role: "assistant",
      id: `answer-${id}`,
      content: [{ type: "output_text", text: "Done" }],
    },
  },
  ...(complete
    ? [
        {
          type: "event_msg",
          timestamp: at(minute + 1),
          payload: { type: "task_complete", turn_id: id },
        },
      ]
    : []),
];

it.effect.each(["native-t3-chat", "import:codex:retired-original-session"])(
  "refreshes the active native session in %s through a T3 → Codex → T3 round trip",
  (appId) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const base = yield* fs.makeTempDirectoryScoped();
      const home = `${base}/codex`;
      const directory = `${home}/sessions/2026/09/01`;
      const file = `${directory}/rollout-2026-09-01T10-00-00-${nativeId}.jsonl`;
      yield* fs.makeDirectory(directory, { recursive: true });
      const handoffMessage = {
        role: "user" as const,
        text: "Earlier request",
        kind: "user_message",
        status: "completed",
        threadId: ThreadId.make(appId),
        runId: null,
        itemId: TurnItemId.make("earlier-item"),
        providerThreadId: null,
      };
      const historical = selectHistory({
        messages: [handoffMessage],
        coverage: "Prior T3 history",
        budget: 100_000,
      });
      const contextHandoffs = [
        {
          delivery: {
            status: "injected",
            nativeThreadId: nativeId,
            itemIds: [handoffMessage.itemId],
          },
          history: { messages: [handoffMessage], coverage: "Prior T3 history", omittedItems: 0 },
        },
      ];
      const records: unknown[] = [
        {
          type: "session_meta",
          payload: { id: nativeId, cwd: "/a/worktree/outside/the/project-root" },
        },
        {
          type: "response_item",
          timestamp: at(0),
          payload: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "# AGENTS.md instructions and environment setup" },
            ],
            internal_chat_message_metadata_passthrough: { turn_id: "injected-history" },
          },
        },
        ...historyResponseItems(historical.messages, historical.context).map((item) => ({
          type: "response_item",
          timestamp: at(0),
          payload: {
            ...item,
            internal_chat_message_metadata_passthrough: { turn_id: "injected-history" },
          },
        })),
        ...turn("t3-turn-1", 0, "From T3"),
      ];
      const persist = () =>
        fs.writeFileString(
          file,
          records.map((record) => encodeTranscriptRecord(record)).join("\n") + "\n",
        );
      yield* persist();
      const threadId = ThreadId.make(appId);
      let activeRunId: string | null = null;
      const thread = {
        id: threadId,
        projectId,
        activeProviderThreadId: "provider-thread",
        deletedAt: null,
        historyOrigin: appId.startsWith("import:") ? "v1_import" : "native",
        createdAt: DateTime.makeUnsafe(at(0)),
        updatedAt: DateTime.makeUnsafe(at(9)),
      };
      const provider = {
        id: "provider-thread",
        providerInstanceId: instanceId,
        providerSessionId: "session",
        nativeThreadRef: { driver: "codex", nativeId, strength: "strong" },
        pendingBackgroundTasks: [],
        updatedAt: DateTime.makeUnsafe(at(0)),
        nativeMetadata: { sharedHistory: false },
      };
      const ownMessages = [
        {
          role: "user",
          text: "From T3",
          createdAt: DateTime.makeUnsafe(at(0)),
          updatedAt: DateTime.makeUnsafe(at(0)),
        },
        // A late local status update must not hide earlier external messages.
        {
          role: "assistant",
          text: "Done",
          createdAt: DateTime.makeUnsafe(at(1)),
          updatedAt: DateTime.makeUnsafe(at(9)),
        },
      ];
      const ownTurns = [{ nativeTurnRef: { driver: "codex", nativeId: "t3-turn-1" } }];
      const events: OrchestrationV2DomainEvent[] = [];
      const detached: string[] = [];
      const store = Layer.mock(ProjectStore.ProjectStoreV2)({
        get: () =>
          Effect.succeed(Option.some({ id: projectId, workspaceRoot: "/project" } as never)),
      });
      const scanner = AgentSessionScanner.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            store,
            ServerSettings.layerTest({ providers: { codex: { homePath: home } } }),
            ServerConfig.layerTest(base, { prefix: "t3-shared-sync-config-" }),
          ),
        ),
      );
      const dependencies = Layer.mergeAll(
        scanner,
        store,
        IdAllocator.layer,
        ThreadCommandExecutor.layer,
        Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
          getByThreadId: () => Effect.succeed(Option.none()),
          recordImportedTranscript: () => Effect.void,
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          detach: (input) =>
            Effect.sync(() => {
              detached.push(input.threadId);
            }),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadShell: () => Effect.succeed({ ...thread, activeRunId } as never),
          getThreadRecords: () =>
            Effect.succeed({
              thread,
              providerThreads: [provider],
              providerTurns: ownTurns,
              contextHandoffs,
              runs: activeRunId === null ? [] : [{ status: "running" }],
              messages: [
                ...ownMessages,
                ...events.flatMap((event) =>
                  event.type === "message.updated" ? [event.payload] : [],
                ),
              ],
              turnItems: events.flatMap((event) =>
                event.type === "turn-item.updated" ? [event.payload] : [],
              ),
            } as never),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: (input) =>
            Effect.sync(() => {
              events.push(...input.events);
              for (const event of input.events) {
                if (event.type === "provider-thread.updated") {
                  expect(event.payload.nativeThreadRef?.nativeId).toBe(nativeId);
                  provider.nativeMetadata.sharedHistory =
                    event.payload.nativeMetadata?.sharedHistory === true;
                }
              }
              return [];
            }),
        }),
      );
      const run = Effect.gen(function* () {
        const importer = yield* AgentSessionImporter.AgentSessionImporter;
        const messages = () =>
          events.flatMap((event) => (event.type === "message.updated" ? [event.payload.text] : []));
        yield* importer.refreshThread(threadId);
        expect(messages()).toEqual([]);
        expect(detached).toEqual([]);
        records.push(...turn("codex-turn-2", 2, "From Codex"));
        yield* persist();
        yield* importer.refreshThread(threadId);
        expect(messages()).toEqual(["From Codex", "Done"]);
        expect(detached).toEqual([threadId]);
        yield* importer.refreshThread(threadId, { forReply: true });
        expect(messages()).toEqual(["From Codex", "Done"]);
        expect(detached).toHaveLength(1);

        records.push(...turn("t3-turn-3", 4, "Back in T3"));
        ownTurns.push({ nativeTurnRef: { driver: "codex", nativeId: "t3-turn-3" } });
        yield* persist();
        yield* importer.refreshThread(threadId);
        expect(messages()).toEqual(["From Codex", "Done"]);
        expect(provider.nativeThreadRef.nativeId).toBe(nativeId);
        expect(provider.nativeMetadata.sharedHistory).toBe(true);

        records.push(
          ...turn("codex-turn-before-busy", 6, "Completed before busy"),
          ...turn("codex-turn-4", 8, "Still running", false),
        );
        yield* persist();
        yield* importer.refreshThread(threadId);
        expect(messages()).toEqual(["From Codex", "Done", "Completed before busy", "Done"]);
        const busy = yield* importer.refreshThread(threadId, { forReply: true }).pipe(Effect.flip);
        expect(busy.reason).toBe("busy");
        expect(messages()).toHaveLength(4);
        activeRunId = "a-t3-run";
        yield* importer.refreshThread(threadId, { forReply: true });
        expect(detached).toHaveLength(1);
        activeRunId = null;
        records.push({
          type: "event_msg",
          timestamp: at(10),
          payload: { type: "task_complete", turn_id: "codex-turn-4" },
        });
        yield* persist();
        yield* importer.refreshThread(threadId, { forReply: true });
        expect(messages()).toEqual([
          "From Codex",
          "Done",
          "Completed before busy",
          "Done",
          "Still running",
          "Done",
        ]);
        expect(detached).toHaveLength(2);
        yield* fs.remove(file);
        const missing = yield* importer
          .refreshThread(threadId, { forReply: true })
          .pipe(Effect.flip);
        expect(missing.reason).toBe("unavailable");
        yield* persist();
      }).pipe(Effect.provide(AgentSessionImporter.layer.pipe(Layer.provide(dependencies))));
      yield* run;
      // A fresh service has no fingerprint cache: native IDs still prevent duplicates.
      const count = events.length;
      yield* Effect.gen(function* () {
        const importer = yield* AgentSessionImporter.AgentSessionImporter;
        yield* importer.refreshThread(threadId);
      }).pipe(Effect.provide(AgentSessionImporter.layer.pipe(Layer.provide(dependencies))));
      expect(events).toHaveLength(count);
    }).pipe(Effect.provide(NodeServices.layer)),
);
