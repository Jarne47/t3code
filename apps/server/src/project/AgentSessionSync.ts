import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import * as ProjectService from "./ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";

/** Refresh only already-linked transcripts; unchanged files cost a stat, not a transcript read. */
export const refreshImportedAgentThreads = Effect.fn("refreshImportedAgentThreads")(function* () {
  const projectService = yield* ProjectService.ProjectService;
  const importer = yield* AgentSessionImporter.AgentSessionImporter;
  const projects = yield* projectService.listShells();
  yield* Effect.forEach(
    projects,
    (project) =>
      importer
        .importRecentAgentThreads(
          { projectId: project.id, expectedWorkspaceRoot: project.workspaceRoot },
          { importedOnly: true },
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
  forkParked(
    refreshImportedAgentThreads().pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Imported agent history refresh failed", { cause }),
      ),
      Effect.repeat(Schedule.spaced("30 seconds")),
    ),
  ),
);
