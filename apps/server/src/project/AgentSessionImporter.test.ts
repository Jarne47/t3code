import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";

const projectId = ProjectId.make("agent-session-import-project");
const providerInstanceId = ProviderInstanceId.make("codex");
const providerSessionId = "native-codex-thread";
const threadId = ThreadId.make(`import:${providerInstanceId}:${providerSessionId}`);

it.effect("imports messages once and preserves the provider native resume binding", () => {
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const upserts: Array<unknown> = [];
  const recorded: Array<unknown> = [];
  let imported = false;
  let busy = false;
  let switched = false;
  const messages: AgentSessionScanner.AgentSessionThreadMessage[] = [
    { role: "user", text: "Fix it", createdAt: "2026-09-01T10:00:00.000Z" },
    { role: "assistant", text: "Fixed", createdAt: "2026-09-01T10:01:00.000Z" },
  ];
  const scanner = AgentSessionScanner.AgentSessionScanner.of({
    scan: Effect.die("unused"),
    readCodexThread: () => Effect.die("unused"),
    recentThreads: () =>
      Stream.succeed({
        _tag: "Importable",
        source: {
          provider: "codex",
          providerInstanceId,
          providerSessionId,
          filePath: "/tmp/native-codex-thread.jsonl",
          size: 100,
          mtimeMs: 2,
          device: 3,
          inode: 4,
          birthtimeMs: 1,
        },
        thread: {
          source: "codex",
          providerInstanceId,
          providerSessionId,
          title: "Imported thread",
          model: "gpt-5.4",
          createdAt: "2026-09-01T10:00:00.000Z",
          updatedAt: "2026-09-01T10:01:00.000Z",
          messages,
        },
      }),
  });
  const testLayer = AgentSessionImporter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AgentSessionScanner.AgentSessionScanner, scanner),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () =>
            Effect.succeed(
              Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never),
            ),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            imported
              ? Effect.succeed({
                  thread: writes.flat().find((event) => event.type === "thread.created")!.payload,
                  messages: writes
                    .flat()
                    .filter((event) => event.type === "message.updated")
                    .map((event) => event.payload),
                  turnItems: writes
                    .flat()
                    .filter((event) => event.type === "turn-item.updated")
                    .map((event) => event.payload),
                  providerTurns: [],
                  contextHandoffs: [],
                  runs: busy ? [{ status: "running" }] : [],
                  providerThreads: switched
                    ? []
                    : writes
                        .flat()
                        .filter((event) => event.type === "provider-thread.updated")
                        .map((event) => event.payload),
                } as never)
              : Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId })),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: (input) =>
            Effect.sync(() => {
              writes.push(input.events);
              imported = true;
              return [];
            }),
        }),
        Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
          list: () => Effect.succeed([]),
          upsert: (input) => Effect.sync(() => void upserts.push(input)),
          recordImportedTranscript: (input) => Effect.sync(() => void recorded.push(input)),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ detach: () => Effect.void }),
        IdAllocator.layer,
        ThreadCommandExecutor.layer,
      ),
    ),
  );

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.map((event) => event.type)).toEqual([
      "thread.created",
      "message.updated",
      "turn-item.updated",
      "message.updated",
      "turn-item.updated",
      "provider-thread.updated",
    ]);
    const created = writes[0]?.find((event) => event.type === "thread.created");
    const providerThread = writes[0]?.find((event) => event.type === "provider-thread.updated");
    expect(created?.payload).toMatchObject({
      id: threadId,
      activeProviderThreadId: providerThread?.payload.id,
      historyOrigin: "v1_import",
    });
    expect(providerThread?.payload).toMatchObject({
      appThreadId: threadId,
      nativeThreadRef: {
        driver: "codex",
        nativeId: providerSessionId,
        strength: "strong",
      },
    });
    expect(
      writes[0]
        ?.filter((event) => event.type === "message.updated")
        .map((event) => event.payload.text),
    ).toEqual(["Fix it", "Fixed"]);
    expect(upserts).toEqual([
      expect.objectContaining({
        threadId,
        providerInstanceId,
        resumeCursor: { threadId: providerSessionId },
      }),
    ]);
    expect(recorded).toHaveLength(2);
    messages.push({
      role: "assistant",
      text: "External follow-up",
      createdAt: "2026-09-01T10:02:00.000Z",
    });
    busy = true;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 0,
      skippedCount: 1,
    });
    busy = false;
    switched = true;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 0,
      skippedCount: 1,
    });
    expect(recorded).toHaveLength(2);
    switched = false;
    expect(yield* importer.importRecentAgentThreads({ projectId }, { importedOnly: true })).toEqual(
      { importedCount: 1, skippedCount: 0 },
    );
    expect(writes).toHaveLength(2);
    expect(writes[1]?.map((event) => event.type)).toEqual(["message.updated", "turn-item.updated"]);
    expect(writes[1]?.find((event) => event.type === "message.updated")?.payload.text).toBe(
      "External follow-up",
    );
    expect(writes[1]?.find((event) => event.type === "turn-item.updated")?.payload.ordinal).toBe(3);
    yield* importer.importRecentAgentThreads({ projectId });
    expect(writes).toHaveLength(2);
    expect(upserts).toHaveLength(1);
  }).pipe(Effect.provide(testLayer));
});

it.effect.each(["codex", "claudeAgent"] as const)(
  "refreshes migrated %s history without restoring a retired native binding",
  (source) => {
    const instanceId = ProviderInstanceId.make(source);
    const nativeId = "01a0aa9c-d1e2-7c92-b569-fe56e5e8f83f";
    const importedId = ThreadId.make(`import:${instanceId}:${nativeId}`);
    const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
    const recorded: Array<unknown> = [];
    let hasRun = false;
    let runtimeStatus: "running" | "stopped" = "stopped";
    let resumeId = nativeId;
    let runtimeInstanceId = instanceId;
    const original = {
      id: `${importedId}:000000`,
      role: "user",
      text: "Original request",
      createdAt: DateTime.makeUnsafe("2026-09-01T10:00:00.000Z"),
      updatedAt: DateTime.makeUnsafe("2026-09-01T10:00:00.000Z"),
    };
    const originalItem = { ordinal: 1 };
    const runtime = () => ({
      threadId: importedId,
      providerName: source,
      providerInstanceId: runtimeInstanceId,
      adapterKey: source,
      runtimeMode: "full-access" as const,
      status: runtimeStatus,
      lastSeenAt: "2026-09-01T10:00:00.000Z",
      resumeCursor: source === "codex" ? { threadId: resumeId } : { resume: resumeId },
      runtimePayload: { cwd: "/workspace/project" },
    });
    const testLayer = AgentSessionImporter.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(AgentSessionScanner.AgentSessionScanner)({
            recentThreads: () =>
              Stream.succeed({
                _tag: "Importable",
                source: {
                  provider: source,
                  providerInstanceId: instanceId,
                  providerSessionId: nativeId,
                  filePath: "/tmp/migrated-history.jsonl",
                  size: 100,
                  mtimeMs: 2,
                  device: 3,
                  inode: 4,
                  birthtimeMs: 1,
                },
                thread: {
                  source,
                  providerInstanceId: instanceId,
                  providerSessionId: nativeId,
                  title: "Migrated thread",
                  model: null,
                  createdAt: "2026-09-01T10:00:00.000Z",
                  updatedAt: "2026-09-02T10:00:00.000Z",
                  messages: [
                    { role: "user", text: original.text, createdAt: "2026-09-01T10:00:00.000Z" },
                    {
                      role: "assistant",
                      text: "Recovered reply",
                      createdAt: "2026-09-02T10:00:00.000Z",
                    },
                  ],
                },
              }),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: () =>
              Effect.succeed(
                Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never),
              ),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadShell: () =>
              Effect.succeed({
                projectId,
                activeRunId: null,
                activeProviderThreadId: null,
              } as never),
            getThreadRecords: () =>
              Effect.succeed({
                thread: {
                  id: importedId,
                  projectId,
                  historyOrigin: "v1_import",
                  activeProviderThreadId: null,
                  deletedAt: null,
                  createdAt: original.createdAt,
                },
                messages: [
                  original,
                  ...writes
                    .flat()
                    .filter((event) => event.type === "message.updated")
                    .map((event) => event.payload),
                ],
                turnItems: [
                  originalItem,
                  ...writes
                    .flat()
                    .filter((event) => event.type === "turn-item.updated")
                    .map((event) => event.payload),
                ],
                providerTurns: [],
                contextHandoffs: [],
                runs: hasRun ? [{ status: "completed" }] : [],
                providerThreads: [],
              } as never),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            write: (input) =>
              Effect.sync(() => {
                writes.push(input.events);
                return [];
              }),
          }),
          Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
            list: () => Effect.succeed([runtime()]),
            getByThreadId: () => Effect.succeed(Option.some(runtime())),
            recordImportedTranscript: (input) => Effect.sync(() => void recorded.push(input)),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            detach: () => Effect.void,
          }),
          IdAllocator.layer,
          ThreadCommandExecutor.layer,
        ),
      ),
    );

    return Effect.gen(function* () {
      const importer = yield* AgentSessionImporter.AgentSessionImporter;
      const refresh = () =>
        importer.importRecentAgentThreads({ projectId }, { importedOnly: true });
      resumeId = "different-native-session";
      expect(yield* refresh()).toEqual({ importedCount: 0, skippedCount: 1 });
      resumeId = nativeId;
      runtimeInstanceId = ProviderInstanceId.make("another-instance");
      expect(yield* refresh()).toEqual({ importedCount: 0, skippedCount: 1 });
      runtimeInstanceId = instanceId;
      runtimeStatus = "running";
      expect(yield* refresh()).toEqual({ importedCount: 0, skippedCount: 1 });
      runtimeStatus = "stopped";
      hasRun = true;
      expect(yield* refresh()).toEqual({ importedCount: 0, skippedCount: 1 });
      hasRun = false;
      expect(writes).toHaveLength(0);
      expect(recorded).toHaveLength(0);

      expect(yield* refresh()).toEqual({ importedCount: 1, skippedCount: 0 });
      expect(writes).toHaveLength(1);
      expect(writes[0]?.map((event) => event.type)).toEqual([
        "message.updated",
        "turn-item.updated",
      ]);
      expect(writes[0]?.find((event) => event.type === "message.updated")?.payload).toMatchObject({
        text: "Recovered reply",
        threadId: importedId,
      });
      expect(writes[0]?.find((event) => event.type === "turn-item.updated")?.payload.ordinal).toBe(
        2,
      );
      expect(yield* refresh()).toEqual({ importedCount: 1, skippedCount: 0 });
      expect(writes).toHaveLength(1);
      expect(recorded).toHaveLength(2);
      if (source === "codex") {
        yield* importer.refreshThread(importedId, { forReply: true });
        const binding = writes.flat().find((event) => event.type === "provider-thread.updated");
        expect(binding?.payload).toMatchObject({
          nativeThreadRef: { driver: "codex", nativeId },
          nativeMetadata: { sharedHistory: true },
        });
      }
    }).pipe(Effect.provide(testLayer));
  },
);
