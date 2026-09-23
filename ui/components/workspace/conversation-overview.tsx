import { categoryColor } from "@/lib/category-palette";
import { formatCompact, formatDate, formatDuration, formatNumber } from "@/lib/format";
import type { SessionSummary, TokenSelection, TurnModel } from "@/lib/types";
import { InputUnits, type CategoryFocus, type CategoryTotal } from "./input-units";

function share(part: number, whole: number): string {
  return whole ? `${Math.round((part / whole) * 100)}%` : "Unknown";
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-control border border-line px-3 py-2.5"><div className="font-mono text-xl font-semibold tracking-[-0.04em]">{value}</div><div className="mt-0.5 text-xs text-muted">{label}</div></div>;
}

function Section({ children, note, title }: { children: React.ReactNode; note?: string; title: string }) {
  return <section className="overflow-hidden rounded-control border border-line">
    <header className="flex items-baseline gap-2 bg-canvas/60 px-4 py-2.5"><h3 className="text-sm font-semibold">{title}</h3>{note ? <span className="text-xs text-muted">{note}</span> : null}</header>
    <div className="divide-y divide-line border-t border-line">{children}</div>
  </section>;
}

/* The conversation level of the workspace: what the whole conversation spent, where
   it went, and which turns deserve a closer look. Every value sums captured usage. */
export function ConversationOverview({ focus, onFocus, onSelectNode, onSelectTurn, session, turns }: { focus: CategoryFocus | null; onFocus: (focus: CategoryFocus | null) => void; onSelectNode: (index: number, selection: TokenSelection) => void; onSelectTurn: (index: number) => void; session: SessionSummary; turns: TurnModel[] }) {
  const input = turns.reduce((sum, turn) => sum + turn.input, 0);
  const cached = turns.reduce((sum, turn) => sum + turn.cached, 0);
  const output = turns.reduce((sum, turn) => sum + turn.output, 0);
  const duration = turns.reduce((sum, turn) => sum + turn.durationMs, 0);
  const models = [...new Set(turns.map((turn) => turn.model).filter((model) => model && model !== "Unknown"))];
  const metaTurns = turns.filter((turn) => turn.kind === "metadata").length;

  const byCategory = new Map<string, CategoryTotal>();
  for (const turn of turns) {
    for (const category of turn.categories) {
      const current = byCategory.get(category.label) || { cached: 0, label: category.label, layer: category.layer || "unknown", tokens: 0 };
      byCategory.set(category.label, { ...current, cached: current.cached + category.cached, tokens: current.tokens + category.tokens });
    }
  }
  const categories = [...byCategory.values()];
  const ranked = [...categories].sort((left, right) => right.tokens - left.tokens);
  const top = ranked.slice(0, 5);
  const rest = ranked.slice(5);
  const restTokens = rest.reduce((sum, category) => sum + category.tokens, 0);
  // The focused category, turn by turn: where it is largest, so it can be opened in place.
  const focusTotal = focus ? byCategory.get(focus.label) : undefined;
  const focusTurns = focus ? turns.map((turn, index) => {
    const blocks = turn.categories.filter((category) => category.label === focus.label);
    return { blockIds: blocks.map((category) => category.id), index, tokens: blocks.reduce((sum, category) => sum + category.tokens, 0), turn };
  }).filter((item) => item.tokens > 0) : [];
  const constant = focusTurns.length > 1 && focusTurns.every((item) => item.tokens === focusTurns[0].tokens);
  // A category that never changes size has no peak; offer where it first appears instead.
  const focusPeaks = constant ? focusTurns.slice(0, 1) : [...focusTurns].sort((left, right) => right.tokens - left.tokens).slice(0, 4);
  const heaviest = turns.map((turn, index) => ({ index, turn })).filter(({ turn }) => turn.fresh > 0).sort((left, right) => right.turn.fresh - left.turn.fresh).slice(0, 4);
  const failed = turns.map((turn, index) => ({ index, turn })).filter(({ turn }) => turn.status >= 400);
  const started = turns[0]?.timestamp || session.started_at;

  return <div className="space-y-4 p-3 sm:p-4">
    <div className="px-1">
      <h2 className="text-lg font-semibold tracking-[-0.01em]">{session.first_user || "Conversation"}</h2>
      <p className="mt-1 text-xs text-muted">{[session.agent || "Unknown agent", models.join(", "), started ? formatDate(started) : "", duration ? `${formatDuration(duration)} model time` : ""].filter(Boolean).join(" · ")}</p>
    </div>

    <dl className="grid grid-cols-2 gap-2 xl:grid-cols-4">
      <Metric label={metaTurns ? `Turns · ${metaTurns} auxiliary` : "Turns"} value={String(turns.length)}/>
      <Metric label="Input tokens, all turns" value={formatCompact(input)}/>
      <Metric label={`Cache read · ${formatCompact(cached)}`} value={share(cached, input)}/>
      <Metric label="Output tokens" value={formatCompact(output)}/>
    </dl>

    <Section note="Input tokens summed over every turn" title="Where the input went">
      {categories.length ? <div className="p-3"><InputUnits categories={categories} focus={focus} onFocus={onFocus} total={input}/></div> : <p className="px-4 py-4 text-xs text-muted">No turn in this conversation has token usage, so its input cannot be broken down.</p>}
      {/* The five largest categories, and one quiet row so the list still sums to the whole. */}
      {top.map((category) => {
        const active = focus?.label === category.label;
        const color = categoryColor(category.label, category.layer);
        return <button aria-pressed={active} className={`t-fade grid w-full grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-canvas/70 ${active ? "bg-canvas" : ""} ${focus && !active ? "opacity-45" : ""}`} key={category.label} onClick={() => onFocus(active ? null : { label: category.label, layer: category.layer })} type="button">
          <span className="flex min-w-0 items-center gap-2"><i className="size-2.5 shrink-0 rounded-[3px]" style={{ background: color }}/><span className="truncate">{category.label}</span></span>
          <span aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-canvas"><span className="block h-full rounded-full" style={{ background: color, width: `${input ? (category.tokens / input) * 100 : 0}%` }}/></span>
          <span className="whitespace-nowrap text-right font-mono text-xs"><span className="text-ink">{formatNumber(category.tokens)}</span> <span className="text-muted">· {share(category.tokens, input)} · {share(category.cached, category.tokens)} cached</span></span>
        </button>;
      })}
      {rest.length ? <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 text-sm text-muted">
        <span className="truncate">Other {rest.length} {rest.length === 1 ? "category" : "categories"}</span>
        <span aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-canvas"><span className="block h-full rounded-full bg-muted/40" style={{ width: `${input ? (restTokens / input) * 100 : 0}%` }}/></span>
        <span className="whitespace-nowrap text-right font-mono text-xs">{formatNumber(restTokens)} · {share(restTokens, input)}</span>
      </div> : null}
      {focus && focusTotal ? <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-xs">
        <span className="flex items-center gap-2"><i className="size-2.5 rounded-[3px]" style={{ background: categoryColor(focus.label, focus.layer) }}/><strong className="font-semibold">{focus.label}</strong></span>
        <span className="font-mono text-muted">{formatNumber(focusTotal.tokens)} · {focusTurns.length} {focusTurns.length === 1 ? "turn" : "turns"} · {share(focusTotal.cached, focusTotal.tokens)} cached</span>
        <span className="flex flex-wrap items-center gap-1.5"><span className="text-muted">{constant ? `${formatCompact(focusTurns[0].tokens)} in each turn, from` : "Largest in"}</span>{focusPeaks.map(({ blockIds, index, tokens, turn }) => <button className="rounded-full border border-line px-2 py-0.5 font-mono text-xs hover:border-muted hover:bg-canvas" key={turn.id} onClick={() => onSelectNode(index, { blockId: blockIds[0], blockIds, label: focus.label, turnId: turn.id })} type="button">Turn {turn.label} · {formatCompact(tokens)}</button>)}</span>
        <button aria-label="Clear category focus" className="ml-auto rounded-full px-2 py-0.5 text-muted hover:bg-canvas hover:text-ink" onClick={() => onFocus(null)} type="button">Clear ×</button>
      </div> : <p className="px-4 py-2.5 text-xs text-muted">Click a square or a category to follow it through the token flow.</p>}
    </Section>

    {heaviest.length || failed.length ? <Section note="Most new, uncached input" title="Turns to look at">
      {[...failed, ...heaviest.filter(({ index }) => !failed.some((item) => item.index === index))].map(({ index, turn }) => <button className="flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm hover:bg-canvas/70" key={turn.id} onClick={() => onSelectTurn(index)} type="button">
        <span className="shrink-0 font-medium">Turn {turn.label}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted">{turn.step}</span>
        {turn.status >= 400 ? <span className="font-mono text-xs text-danger">HTTP {turn.status}</span> : <span className="font-mono text-xs text-ink">{formatNumber(turn.fresh)} new</span>}
      </button>)}
    </Section> : null}

    <p className="px-1 text-xs text-muted">Select a turn in the flow to inspect its request, or click a Sankey node to jump to that layer or category.</p>
  </div>;
}
