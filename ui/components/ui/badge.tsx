import type { CSSProperties, ReactNode } from "react";

export type Tone = "neutral" | "success" | "warning" | "danger";

const BADGE_TONES: Record<Tone, string> = {
  neutral: "border-line bg-canvas text-muted",
  success: "border-success-line bg-success-soft text-success-ink",
  warning: "border-warning-line bg-warning-soft text-warning-ink",
  danger: "border-danger-line bg-danger-soft text-danger-ink",
};

/* A static label: a state (new, changed, failed), an exception (Error, Empty),
   or a short fact. Its text carries the meaning; the tone reinforces it.
   `mono` is for identifiers and counts that must keep their literal form. */
export function Badge({ children, mono = false, title, tone = "neutral" }: { children: ReactNode; mono?: boolean; title?: string; tone?: Tone }) {
  return <span className={`inline-flex max-w-full shrink-0 items-center whitespace-nowrap rounded-tag border px-1.5 py-px text-xs font-medium ${mono ? "font-mono" : ""} ${BADGE_TONES[tone]}`} title={title}>{children}</span>;
}

const DOT_TONES: Record<Tone | "none", string> = {
  neutral: "bg-muted",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  none: "bg-transparent",
};

/* A live or health state beside its text label (Watching, Active). `none` keeps
   the space so rows with and without a dot stay aligned. */
export function StatusDot({ tone }: { tone: Tone | "none" }) {
  return <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${DOT_TONES[tone]}`}/>;
}

/* A color key for a layer or category in legends, rows, and results. */
export function Swatch({ className = "", color, style }: { className?: string; color?: string; style?: CSSProperties }) {
  return <span aria-hidden="true" className={`inline-block size-2.5 shrink-0 rounded-mark ${className}`} style={color ? { background: color, ...style } : style}/>;
}
