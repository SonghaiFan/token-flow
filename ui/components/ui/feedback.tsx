import type { ReactNode } from "react";
import type { Tone } from "./badge";
import { IconButton } from "./button";
import { CloseIcon } from "./icons";

const NOTICE_TONES: Record<Tone, string> = {
  neutral: "border-line bg-canvas text-ink",
  success: "border-success-line bg-success-soft text-success-ink",
  warning: "border-warning-line bg-warning-soft text-warning-ink",
  danger: "border-danger-line bg-danger-soft text-danger-ink",
};

/* A message about the current scope: a failed load, a completed action, a
   truncated capture. `compact` sits inside inspector content; the default sits
   at page or dialog level. Danger notices are announced as alerts. */
export function Notice({ children, compact = false, onDismiss, title, tone = "neutral" }: { children?: ReactNode; compact?: boolean; onDismiss?: () => void; title?: ReactNode; tone?: Tone }) {
  return <div
    aria-live={tone === "danger" ? undefined : "polite"}
    className={`flex items-start gap-3 rounded-control border ${compact ? "px-3 py-2 text-xs" : "px-4 py-3 text-sm"} ${NOTICE_TONES[tone]}`}
    role={tone === "danger" ? "alert" : undefined}
  >
    <div className="min-w-0 flex-1">
      {title ? <p className="font-medium">{title}</p> : null}
      {children ? <div className={title ? "mt-1" : ""}>{children}</div> : null}
    </div>
    {onDismiss ? <IconButton className="-my-3 -mr-3 text-current" label="Dismiss" onClick={onDismiss}><CloseIcon className="size-4"/></IconButton> : null}
  </div>;
}

/* What is absent, why that may be normal, and what to do next. `framed` marks
   an empty region inside a pane; unframed fills a list or a whole view. */
export function EmptyState({ children, framed = false, title }: { children?: ReactNode; framed?: boolean; title?: ReactNode }) {
  return <div className={`flex flex-col items-center gap-1 text-center text-sm ${framed ? "rounded-control border border-dashed border-line px-4 py-6" : "px-5 py-12"}`}>
    {title ? <p className="font-medium text-ink">{title}</p> : null}
    {children ? <div className="max-w-sm text-muted">{children}</div> : null}
  </div>;
}
