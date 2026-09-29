import { OpenCode, type OpenCodeClient } from "@opencode/client/effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

/** OpenCode 2 accepts only HTTP Basic auth, always with this user name. */
const OPENCODE_USERNAME = "opencode";

/** Builds Effect clients for OpenCode 2 servers, one per base URL and password. */
export class OpenCode2Client extends Context.Service<
  OpenCode2Client,
  {
    readonly connect: (input: {
      readonly baseUrl: string;
      readonly password: string | Redacted.Redacted;
    }) => Effect.Effect<OpenCodeClient>;
  }
>()("t3/provider/opencode2/OpenCode2Client") {}

/**
 * OpenCode decodes Basic credentials as UTF-8. `HttpClientRequest.basicAuth`
 * encodes them as Latin-1 (`btoa`), which gets non-ASCII passwords rejected.
 */
const basicAuthorization = (password: string | Redacted.Redacted) => {
  const plain = Redacted.isRedacted(password) ? Redacted.value(password) : password;
  return `Basic ${Buffer.from(`${OPENCODE_USERNAME}:${plain}`, "utf8").toString("base64")}`;
};

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  return OpenCode2Client.of({
    connect: ({ baseUrl, password }) =>
      OpenCode.make({ baseUrl }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.mapRequest(
            httpClient,
            HttpClientRequest.setHeader("Authorization", basicAuthorization(password)),
          ),
        ),
      ),
  });
});

export const layer = Layer.effect(OpenCode2Client, make);

/**
 * Streams every item of a cursor-paged OpenCode 2 list. The first request
 * carries the caller's input (including `order`); later requests send only
 * the cursor, because OpenCode rejects a cursor combined with `order`.
 */
export const paginate = <Input extends { readonly cursor?: unknown }, Item, E, R>(
  input: Input,
  list: (
    input: Input,
  ) => Effect.Effect<
    { readonly data: ReadonlyArray<Item>; readonly cursor: { readonly next?: Input["cursor"] } },
    E,
    R
  >,
): Stream.Stream<Item, E, R> =>
  Stream.paginate(input, (request) =>
    list(request).pipe(
      Effect.map(
        (page) =>
          [
            page.data,
            page.data.length === 0 || page.cursor.next === undefined
              ? Option.none()
              : Option.some({ ...request, order: undefined, cursor: page.cursor.next }),
          ] as const,
      ),
    ),
  );
