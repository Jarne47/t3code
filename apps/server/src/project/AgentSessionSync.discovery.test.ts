import { expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as AgentSessionSync from "./AgentSessionSync.ts";
import * as ProjectService from "./ProjectService.ts";

it.effect(
  "discovers new external sessions periodically while keeping routine refreshes stat-only",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const refreshes = yield* Queue.unbounded<boolean>();
        let scans = 0;
        const projectId = ProjectId.make("linked-project");
        const dependencies = Layer.mergeAll(
          Layer.mock(ProjectService.ProjectService)({
            listShells: () =>
              Effect.succeed([{ id: projectId, workspaceRoot: "/workspace/project" } as never]),
          }),
          Layer.mock(AgentSessionScanner.AgentSessionScanner)({
            scan: Effect.sync(() => {
              scans += 1;
              return { candidates: [], scannedAt: "2026-10-12T08:00:00.000Z" };
            }),
          }),
          Layer.mock(AgentSessionImporter.AgentSessionImporter)({
            importRecentAgentThreads: (input, options) => {
              expect(input).toEqual({ projectId, expectedWorkspaceRoot: "/workspace/project" });
              expect(options?.importedOnly).toBe(!options?.discoverNew);
              return Queue.offer(refreshes, options?.discoverNew === true).pipe(
                Effect.as({ importedCount: 0, skippedCount: 0 }),
              );
            },
          }),
        );
        yield* Layer.build(AgentSessionSync.layer.pipe(Layer.provide(dependencies)));
        expect(yield* Queue.take(refreshes)).toBe(true);
        expect(scans).toBe(1);
        for (let index = 1; index < 10; index++) {
          yield* TestClock.adjust("30 seconds");
          expect(yield* Queue.take(refreshes)).toBe(false);
          expect(scans).toBe(1);
        }
        yield* TestClock.adjust("30 seconds");
        expect(yield* Queue.take(refreshes)).toBe(true);
        expect(scans).toBe(2);
      }),
    ),
);
