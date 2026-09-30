import type { OrchestrationThread } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** Include completed streaming writes when separating provider history from live T3 turns. */
export function latestThreadMessageAt(
  thread: Pick<OrchestrationThread, "createdAt" | "messages">,
): string {
  return DateTime.formatIso(
    DateTime.makeUnsafe(
      thread.messages.reduce(
        (latest, message) =>
          Math.max(latest, Date.parse(message.createdAt), Date.parse(message.updatedAt)),
        Date.parse(thread.createdAt),
      ),
    ),
  );
}
