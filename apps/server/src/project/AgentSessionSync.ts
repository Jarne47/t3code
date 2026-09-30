import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";
import { importRecentAgentThreads } from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";

/** Refresh only already-linked transcripts; unchanged files cost a stat, not a transcript read. */
export const refreshImportedAgentThreads = Effect.fn("refreshImportedAgentThreads")(function* () {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const projects = yield* snapshots.getProjectShells();
  yield* Effect.forEach(
    projects,
    (project) =>
      importRecentAgentThreads(
        { projectId: project.id, expectedWorkspaceRoot: project.workspaceRoot },
        { importedOnly: true },
      ).pipe(
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
  forkParked(
    refreshImportedAgentThreads().pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Imported agent history refresh failed", { cause }),
      ),
      Effect.repeat(Schedule.spaced("30 seconds")),
    ),
  ),
).pipe(Layer.provide(AgentSessionScanner.layer));
