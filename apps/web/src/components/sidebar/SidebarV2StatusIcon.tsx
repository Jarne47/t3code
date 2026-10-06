import {
  AlarmClockIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import type { SidebarV2TopStatusKind } from "../Sidebar.logic";

/** Leading glyph for a thread row's or project header's status label; inherits its color. */
export function SidebarV2StatusIcon({
  kind,
  className = "size-4 shrink-0",
}: {
  kind: SidebarV2TopStatusKind;
  className?: string;
}) {
  switch (kind) {
    case "working":
      return <CircleDashedIcon aria-hidden className={className} />;
    case "input":
      return <MessageCircleQuestionIcon aria-hidden className={className} />;
    case "approval":
      return <ShieldQuestionIcon aria-hidden className={className} />;
    case "failed":
    case "limited":
      return <CircleAlertIcon aria-hidden className={className} />;
    case "woke":
      return <AlarmClockIcon aria-hidden className={className} />;
    case "done":
      return <CircleCheckIcon aria-hidden className={className} />;
    case "waiting":
      return null;
  }
}
