import type { ReactNode } from "react";

/* A quiet line of counts for the current scope. Values are compact overview
   numbers; exact values live in tooltips, details, and exports. */
export function StatList({ children }: { children: ReactNode }) {
  return <dl className="flex flex-wrap items-end gap-x-8 gap-y-3">{children}</dl>;
}

export function Stat({ label, value }: { label: string; value: string }) {
  return <div className="flex min-w-0 flex-col-reverse">
    <dt className="text-xs text-muted">{label}</dt>
    <dd className="font-mono text-lg font-semibold tracking-[-0.03em] text-ink">{value}</dd>
  </div>;
}
