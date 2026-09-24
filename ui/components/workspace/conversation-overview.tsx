import type { ReactNode } from "react";
import { categoryColor } from "@/lib/category-palette";
import { formatCompact, formatDate, formatDuration, formatNumber } from "@/lib/format";
import type { SessionSummary, TokenSelection, TurnModel } from "@/lib/types";
import { Badge, Swatch } from "../ui/badge";
import { Button, Chip } from "../ui/button";
import { EmptyState } from "../ui/feedback";
import { Stat, StatList } from "../ui/stat";
import { InputUnits, type CategoryFocus, type CategoryTotal } from "./input-units";

const TOP_CATEGORIES = 6;
const TURNS_TO_OPEN = 3;

function share(part: number, whole: number): string {
  return whole ? `${Math.round((part / whole) * 100)}%` : "Unknown";
}

function Heading({ children }: { children: ReactNode }) {
  return <h3 className="tf-eyebrow pb-2">{children}</h3>;
}

/* A ranked row: swatch and name, a share bar, then exact tokens and share. */
const RANK_ROW = "grid min-h-11 w-full grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto] items-center gap-3 px-2 text-left text-sm";

/* The conversation level of the workspace: what the whole conversation spent, where
   it went, and which turns deserve a closer look. Every value sums captured usage. */
export function ConversationOverview({ focus, onFocus, onSelectNode, onSelectTurn, session, turns }: { focus: CategoryFocus | null; onFocus: (focus: CategoryFocus | null) => void; onSelectNode: (index: number, selection: TokenSelection) => void; onSelectTurn: (index: number) => void; session: SessionSummary; turns: TurnModel[] }) {
  const input = turns.reduce((sum, turn) => sum + turn.input, 0);
  const cached = turns.reduce((sum, turn) => sum + turn.cached, 0);
  const output = turns.reduce((sum, turn) => sum + turn.output, 0);
  const duration = turns.reduce((sum, turn) => sum + turn.durationMs, 0);
  const models = [...new Set(turns.map((turn) => turn.model).filter((model) => model && model !== "Unknown"))];

  const byCategory = new Map<string, CategoryTotal>();
  for (const turn of turns) {
    for (const category of turn.categories) {
      const current = byCategory.get(category.label) || { cached: 0, label: category.label, layer: category.layer || "unknown", tokens: 0 };
      byCategory.set(category.label, { ...current, cached: current.cached + category.cached, estimated: current.estimated || category.estimated, tokens: current.tokens + category.tokens });
    }
  }
  const ranked = [...byCategory.values()].sort((left, right) => right.tokens - left.tokens);
  const top = ranked.slice(0, TOP_CATEGORIES);
  const rest = ranked.slice(TOP_CATEGORIES);
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
  const failed = turns.map((turn, index) => ({ index, turn })).filter(({ turn }) => turn.status >= 400);
  const heaviest = turns.map((turn, index) => ({ index, turn })).filter(({ turn }) => turn.fresh > 0 && turn.status < 400).sort((left, right) => right.turn.fresh - left.turn.fresh).slice(0, TURNS_TO_OPEN);
  const started = turns[0]?.timestamp || session.started_at;

  return <div className="tf-pad space-y-7">
    <header>
      <h2 className="tf-title">{session.first_user || "Conversation"}</h2>
      <p className="mt-1 text-xs text-muted">{[session.agent || "Unknown agent", models.join(", "), started ? formatDate(started) : "", duration ? `${formatDuration(duration)} model time` : ""].filter(Boolean).join(" · ")}</p>
      <div className="mt-5"><StatList>
        <Stat label={turns.length === 1 ? "turn" : "turns"} value={formatNumber(turns.length)}/>
        <Stat label="input" value={formatCompact(input)}/>
        <Stat label={`cached · ${formatCompact(cached)}`} value={share(cached, input)}/>
        <Stat label="output" value={formatCompact(output)}/>
        {failed.length ? <Stat label={failed.length === 1 ? "failed turn" : "failed turns"} value={formatNumber(failed.length)}/> : null}
      </StatList></div>
    </header>

    <section>
      <Heading>Where the input went</Heading>
      {ranked.length ? <div className="mb-3"><InputUnits categories={ranked} focus={focus} onFocus={onFocus} total={input}/></div> : null}
      {ranked.length ? <div className="-mx-2 divide-y divide-line border-y border-line">
        {top.map((category) => {
          const active = focus?.label === category.label;
          const color = categoryColor(category.label, category.layer);
          return <button aria-pressed={active} className={`t-fade tf-focus-inset ${RANK_ROW} ${active ? "bg-fill-selected" : "hover:bg-fill-hover"} ${focus && !active ? "tf-dimmed" : ""}`} key={category.label} onClick={() => onFocus(active ? null : { label: category.label, layer: category.layer })} title="Follow this category through the token flow" type="button">
            <span className="flex min-w-0 items-center gap-2"><Swatch color={color}/><span className="truncate">{category.label}</span></span>
            <span aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-canvas"><span className="block h-full rounded-full" style={{ background: color, width: `${input ? (category.tokens / input) * 100 : 0}%` }}/></span>
            <span className="whitespace-nowrap text-right font-mono text-xs"><span className="text-ink" title={category.estimated ? "Estimated with a local tokenizer, scaled to measured totals" : undefined}>{category.estimated ? "≈" : ""}{formatCompact(category.tokens)}</span> <span className="inline-block w-10 text-muted">{share(category.tokens, input)}</span></span>
          </button>;
        })}
        {rest.length ? <div className={`${RANK_ROW} text-muted`}>
          <span className="truncate pl-[18px]">{rest.length} more {rest.length === 1 ? "category" : "categories"}</span>
          <span aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-canvas"><span className="block h-full rounded-full bg-muted/40" style={{ width: `${input ? (restTokens / input) * 100 : 0}%` }}/></span>
          <span className="whitespace-nowrap text-right font-mono text-xs">{rest.some((category) => category.estimated) ? "≈" : ""}{formatCompact(restTokens)} <span className="inline-block w-10">{share(restTokens, input)}</span></span>
        </div> : null}
      </div> : <EmptyState framed title="Input breakdown unavailable">No turn in this conversation reported token usage, so its input cannot be broken down.</EmptyState>}
      {focus && focusTotal ? <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted">{formatNumber(focusTotal.tokens)} in {focusTurns.length} {focusTurns.length === 1 ? "turn" : "turns"} · {share(focusTotal.cached, focusTotal.tokens)} cached · {constant ? `${formatCompact(focusTurns[0].tokens)} each, from` : "largest in"}</span>
        {focusPeaks.map(({ blockIds, index, tokens, turn }) => <Chip key={turn.id} onClick={() => onSelectNode(index, { blockId: blockIds[0], blockIds, label: focus.label, turnId: turn.id })}>Turn {turn.label} · <span className="font-mono">{formatCompact(tokens)}</span></Chip>)}
        <Button aria-label="Clear category focus" className="-mr-2 ml-auto" compact onClick={() => onFocus(null)} variant="ghost">Clear</Button>
      </div> : null}
    </section>

    {failed.length || heaviest.length ? <section>
      <Heading>Turns to look at</Heading>
      <div className="-mx-2 divide-y divide-line border-y border-line">
        {[...failed, ...heaviest].map(({ index, turn }) => <button className="tf-focus-inset flex min-h-11 w-full items-center gap-3 px-2 text-left text-sm hover:bg-fill-hover" key={turn.id} onClick={() => onSelectTurn(index)} type="button">
          <span className="w-16 shrink-0 font-medium">Turn {turn.label}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted">{turn.step}</span>
          {turn.status >= 400 ? <Badge mono tone="danger">HTTP {turn.status}</Badge> : <span className="font-mono text-xs text-ink">{formatCompact(turn.fresh)} new</span>}
        </button>)}
      </div>
    </section> : null}
  </div>;
}
