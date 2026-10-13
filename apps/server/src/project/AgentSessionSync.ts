import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import * as ProjectService from "./ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";

/** Refresh linked history, occasionally discovering new sessions in the same projects. */
const refreshImportedAgentThreads = Effect.fn("refreshImportedAgentThreads")(function* (
  discoverNew: boolean,
) {
  const projectService = yield* ProjectService.ProjectService;
  const importer = yield* AgentSessionImporter.AgentSessionImporter;
  const projects = yield* projectService.listShells();
  yield* Effect.forEach(
    projects,
    (project) =>
      importer
        .importRecentAgentThreads(
          { projectId: project.id, expectedWorkspaceRoot: project.workspaceRoot },
          { importedOnly: !discoverNew, discoverNew },
        )
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not refresh imported agent history", {
              projectId: project.id,
              cause,
            }),
          ),
        ),
    { discard: true },
  );
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const scanner = yield* AgentSessionScanner.AgentSessionScanner;
    let nextDiscoveryAt = 0;
    yield* forkParked(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const discoverNew = now >= nextDiscoveryAt;
        if (discoverNew) {
          // Share one bounded home scan across projects, outside the frequent stat-only refresh.
          yield* scanner.scan;
          nextDiscoveryAt = now + 5 * 60_000;
        }
        yield* refreshImportedAgentThreads(discoverNew);
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Imported agent history refresh failed", { cause }),
        ),
        Effect.repeat(Schedule.spaced("30 seconds")),
      ),
    );
  }),
);
