import { formatNumber } from "@/lib/format";
import type { TurnModel } from "@/lib/types";

function Metric({ label, value, tone = "" }: { label: string; value: string; tone?: string }) {
  return <div className="rounded-xl border border-line bg-panel px-3 py-2.5"><div className={`font-mono text-xl font-semibold tracking-[-0.05em] sm:text-2xl ${tone}`}>{value}</div><div className="mt-0.5 text-[10px] text-muted sm:text-[11px]">{label}</div></div>;
}

export function MetricStrip({ turn, previous }: { turn: TurnModel; previous?: TurnModel }) {
  const hit = turn.input ? Math.round((turn.cached / turn.input) * 100) : 0;
  const delta = previous ? turn.fresh - previous.fresh : null;
  return <dl className="grid grid-cols-2 gap-2 lg:grid-cols-4">
    <Metric label="Input tokens" value={formatNumber(turn.input)} />
    <Metric label={`Cache read · ${formatNumber(turn.cached)}`} value={`${hit}%`} />
    <Metric label="Fresh token use" value={formatNumber(turn.fresh)} />
    <Metric label="vs previous turn" value={delta === null ? "N/A" : `${delta > 0 ? "+" : ""}${formatNumber(delta)}`} tone={delta === null || delta === 0 ? "text-muted" : delta < 0 ? "text-success" : "text-danger"} />
  </dl>;
}
