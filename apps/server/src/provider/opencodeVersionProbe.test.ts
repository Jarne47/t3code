import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/unstable/http";

import { OpenCodeRuntimeError, type OpenCodeRuntimeShape } from "./opencodeRuntime.ts";
import {
  classifyOpenCodeCliVersion,
  makeOpenCodeRuntimeProbe,
  probeOpenCodeRuntime,
} from "./opencodeVersionProbe.ts";
import {
  OPENCODE_1_RESPONSES,
  OPENCODE_2_RESPONSES,
  replayOpenCodeServer,
} from "./testFixtures/opencodeProbeResponses.ts";

const external = (serverPassword: string) => ({
  binaryPath: "opencode",
  serverUrl: "http://127.0.0.1:4096/",
  serverPassword,
});

describe("OpenCode version probe", () => {
  it("classifies the recorded `opencode --version` output of both versions", () => {
    assert.deepStrictEqual(classifyOpenCodeCliVersion("1.18.32\n"), {
      generation: "v1",
      version: "1.18.32",
    });
    assert.deepStrictEqual(classifyOpenCodeCliVersion("opencode v2.0.18\n"), {
      generation: "v2",
      version: "2.0.18",
    });
    assert.isUndefined(classifyOpenCodeCliVersion("opencode dev build\n"));
  });

  it.effect("finds 2.x at /api/info without falling through to its HTML /global/health", () =>
    Effect.gen(function* () {
      const paths: Array<string> = [];
      const probed = yield* probeOpenCodeRuntime({} as OpenCodeRuntimeShape, external("pw")).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          replayOpenCodeServer(OPENCODE_2_RESPONSES, "pw", paths),
        ),
      );
      assert.deepStrictEqual(probed, { generation: "v2", version: "2.0.18" });
      assert.deepStrictEqual(paths, ["/api/info"]);
    }),
  );

  it.effect("skips the HTML 1.x serves at /api/info and finds it at /global/health", () =>
    Effect.gen(function* () {
      const paths: Array<string> = [];
      const probed = yield* probeOpenCodeRuntime({} as OpenCodeRuntimeShape, external("pw")).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          replayOpenCodeServer(OPENCODE_1_RESPONSES, "pw", paths),
        ),
      );
      assert.deepStrictEqual(probed, { generation: "v1", version: "1.18.32" });
      assert.deepStrictEqual(paths, ["/api/info", "/global/health"]);
    }),
  );

  it.effect("reports a rejected password instead of guessing a version", () =>
    Effect.gen(function* () {
      for (const responses of [OPENCODE_1_RESPONSES, OPENCODE_2_RESPONSES]) {
        const paths: Array<string> = [];
        const error = yield* probeOpenCodeRuntime(
          {} as OpenCodeRuntimeShape,
          external("wrong"),
        ).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            replayOpenCodeServer(responses, "pw", paths),
          ),
          Effect.flip,
        );
        assert.match(error.detail, /401 Unauthorized/);
        assert.deepStrictEqual(paths, ["/api/info"]);
      }
    }),
  );

  it.effect("remembers a probed runtime but never a failure", () =>
    Effect.gen(function* () {
      const outputs = ["", "opencode v2.0.18\n", "1.18.32\n"];
      let calls = 0;
      const runtime: Pick<OpenCodeRuntimeShape, "runOpenCodeCommand"> = {
        runOpenCodeCommand: () => {
          const stdout = outputs[calls++];
          return stdout
            ? Effect.succeed({ stdout, stderr: "", code: 0 })
            : Effect.fail(new OpenCodeRuntimeError({ operation: "spawn", detail: "ENOENT" }));
        },
      };
      const probe = yield* makeOpenCodeRuntimeProbe(
        probeOpenCodeRuntime(runtime, {
          binaryPath: "opencode",
          serverUrl: "",
          serverPassword: "",
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            replayOpenCodeServer(OPENCODE_2_RESPONSES, ""),
          ),
        ),
      );

      yield* Effect.flip(probe.get);
      assert.strictEqual((yield* probe.get).generation, "v2");
      assert.strictEqual((yield* probe.get).generation, "v2");
      assert.strictEqual(calls, 2);
      // A status refresh re-probes, so an in-place downgrade or upgrade re-routes.
      assert.strictEqual((yield* probe.refresh).generation, "v1");
      assert.strictEqual((yield* probe.get).generation, "v1");
      assert.strictEqual(calls, 3);
    }),
  );
});
