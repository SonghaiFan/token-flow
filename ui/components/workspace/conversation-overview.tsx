import { useMemo, type ReactNode } from "react";
import { categoryColor } from "@/lib/category-palette";
import { formatCompact, formatDate, formatDuration, formatNumber } from "@/lib/format";
import { scopeTotals, turnScopes } from "@/lib/conversation-scope";
import { CATEGORY_META } from "@/lib/input-categories";
import { threadIndices, threadTree } from "@/lib/threads";
import type { InputCategory, SessionSummary, TokenSelection, TurnModel } from "@/lib/types";
import { Badge, Swatch } from "../ui/badge";
import { Button, Chip } from "../ui/button";
import { EmptyState } from "../ui/feedback";
import { Stat, StatList } from "../ui/stat";
import { InputUnits, type CategoryFocus, type CategoryTotal } from "./input-units";

const TURNS_TO_OPEN = 3;

function share(part: number, whole: number): string {
  return whole ? `${Math.round((part / whole) * 100)}%` : "Unknown";
}

function Heading({ children }: { children: ReactNode }) {
  return <h3 className="tf-eyebrow pb-2">{children}</h3>;
}

/* A ranked row: swatch and name, a share bar, then exact tokens and share. */
const RANK_ROW = "grid min-h-11 w-full grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto] items-center gap-3 px-2 text-left text-sm";

/* The conversation level of the workspace: what the conversation spent, where it
   went, and which turns deserve a closer look. Every value sums captured usage of
   the conversation's own requests; background work and auxiliary requests are
   listed after it, each with its own total. */
export function ConversationOverview({ focus, onFocus, onSelectNode, onSelectTurn, session, turns: allTurns }: { focus: CategoryFocus | null; onFocus: (focus: CategoryFocus | null) => void; onSelectNode: (index: number, selection: TokenSelection) => void; onSelectTurn: (index: number) => void; session: SessionSummary; turns: TurnModel[] }) {
  const scopes = useMemo(() => turnScopes(allTurns), [allTurns]);
  const own = allTurns.map((turn, index) => ({ index, turn })).filter(({ index }) => scopes[index] === "conversation");
  const turns = own.map(({ turn }) => turn);
  const { input, cached, output, durationMs: duration } = scopeTotals(turns);
  const models = [...new Set(turns.map((turn) => turn.model).filter((model) => model && model !== "Unknown"))];
  const outside = useMemo(() => {
    const tree = threadTree(allTurns);
    const rows = tree.background.map((node) => ({ indices: threadIndices(node).sort((left, right) => left - right), key: node.id, label: node.name || node.label || "Background task" }));
    if (tree.auxiliary.length) rows.push({ indices: tree.auxiliary, key: "auxiliary", label: "Auxiliary requests" });
    return rows.map((row) => ({ ...row, ...scopeTotals(row.indices.map((index) => allTurns[index])) }));
  }, [allTurns]);

  const byCategory = new Map<InputCategory, CategoryTotal>();
  for (const turn of turns) {
    for (const category of turn.categories) {
      const meta = CATEGORY_META[category.category];
      const current = byCategory.get(category.category) || { cached: 0, category: category.category, label: meta.title, layer: meta.layer, tokens: 0 };
      byCategory.set(category.category, { ...current, cached: current.cached + category.cached, estimated: current.estimated || category.estimated, tokens: current.tokens + category.tokens });
    }
  }
  const ranked = [...byCategory.values()].sort((left, right) => right.tokens - left.tokens);
  // The focused category, turn by turn: where it is largest, so it can be opened in place.
  const focusTotal = focus ? byCategory.get(focus.category) : undefined;
  const focusTurns = focus ? own.map(({ index, turn }) => {
    const blocks = turn.categories.filter((category) => category.category === focus.category);
    return { blockIds: blocks.flatMap((category) => category.memberIds || [category.id]), index, tokens: blocks.reduce((sum, category) => sum + category.tokens, 0), turn };
  }).filter((item) => item.tokens > 0) : [];
  const constant = focusTurns.length > 1 && focusTurns.every((item) => item.tokens === focusTurns[0].tokens);
  // A category that never changes size has no peak; offer where it first appears instead.
  const focusPeaks = constant ? focusTurns.slice(0, 1) : [...focusTurns].sort((left, right) => right.tokens - left.tokens).slice(0, 4);
  const failed = own.filter(({ turn }) => turn.status >= 400);
  const heaviest = own.filter(({ turn }) => turn.fresh > 0 && turn.status < 400).sort((left, right) => right.turn.fresh - left.turn.fresh).slice(0, TURNS_TO_OPEN);
  const started = turns[0]?.timestamp || session.started_at;

  return <div className="tf-pad space-y-7">
    <header>
      <h2 className="tf-title">{session.title || turns.find((turn) => turn.kind === "user" && turn.queryText)?.queryText || session.first_user || "Conversation"}</h2>
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
        {ranked.map((category) => {
          const active = focus?.category === category.category;
          const color = categoryColor(category.category);
          return <button aria-pressed={active} className={`t-fade tf-focus-inset ${RANK_ROW} ${active ? "bg-fill-selected" : "hover:bg-fill-hover"} ${focus && !active ? "tf-dimmed" : ""}`} key={category.category} onClick={() => onFocus(active ? null : { category: category.category, label: category.label, layer: category.layer })} title="Follow this category through the token flow" type="button">
            <span className="flex min-w-0 items-center gap-2"><Swatch color={color}/><span className="truncate">{category.label}</span></span>
            <span aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-canvas"><span className="block h-full rounded-full" style={{ background: color, width: `${input ? (category.tokens / input) * 100 : 0}%` }}/></span>
            <span className="whitespace-nowrap text-right font-mono text-xs"><span className="text-ink" title={category.estimated ? "Estimated with a local tokenizer, scaled to measured totals" : undefined}>{category.estimated ? "≈" : ""}{formatCompact(category.tokens)}</span> <span className="inline-block w-10 text-muted">{share(category.tokens, input)}</span></span>
          </button>;
        })}
      </div> : <EmptyState framed title="Input breakdown unavailable">No turn in this conversation reported token usage, so its input cannot be broken down.</EmptyState>}
      {focus && focusTotal ? <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted">{formatNumber(focusTotal.tokens)} in {focusTurns.length} {focusTurns.length === 1 ? "turn" : "turns"} · {share(focusTotal.cached, focusTotal.tokens)} cached · {constant ? `${formatCompact(focusTurns[0].tokens)} each, from` : "largest in"}</span>
        {focusPeaks.map(({ blockIds, index, tokens, turn }) => <Chip key={turn.id} onClick={() => onSelectNode(index, { blockId: blockIds[0], blockIds, category: focus.category, label: focus.label, turnId: turn.id })}>Turn {turn.label} · <span className="font-mono">{formatCompact(tokens)}</span></Chip>)}
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

    {outside.length ? <section>
      <Heading>Outside the conversation</Heading>
      <div className="-mx-2 divide-y divide-line border-y border-line">
        {outside.map((row) => <button className="tf-focus-inset flex min-h-11 w-full items-center gap-3 px-2 text-left text-sm hover:bg-fill-hover" key={row.key} onClick={() => onSelectTurn(row.indices[0])} title="Open its first turn" type="button">
          <span className="min-w-0 flex-1 truncate">{row.label}</span>
          <span className="shrink-0 text-xs text-muted">{row.requests} {row.requests === 1 ? "turn" : "turns"}</span>
          <span className="w-16 shrink-0 text-right font-mono text-xs text-ink">{formatCompact(row.input)}</span>
        </button>)}
      </div>
    </section> : null}
  </div>;
}
