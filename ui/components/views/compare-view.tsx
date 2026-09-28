"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchSessionRecords, fetchTokenEstimates } from "@/lib/api";
import { categoryColor } from "@/lib/category-palette";
import { conversationQueries, scopeTotals, turnScopes, type QuerySummary, type ScopeTotals } from "@/lib/conversation-scope";
import { formatCompact, formatDuration, formatNumber } from "@/lib/format";
import { CATEGORY_META, CATEGORY_ORDER } from "@/lib/input-categories";
import { buildTurns, estimateTexts, type TokenEstimates } from "@/lib/token-model";
import type { InputCategory, SessionRecordsPayload, TurnModel } from "@/lib/types";
import { AgentMark } from "../agent-mark";
import { AppShell } from "../app-shell";
import { Badge, Swatch } from "../ui/badge";
import { EmptyState, Notice } from "../ui/feedback";
import { Segmented } from "../ui/segmented";

type Scale = "shared" | "own";

interface Compared {
  id: string;
  agent: string;
  title: string;
  models: string[];
  /* The conversation's own turns, in capture order. */
  own: TurnModel[];
  totals: ScopeTotals;
  background: ScopeTotals;
  auxiliary: ScopeTotals;
  first?: TurnModel;
  queries: QuerySummary[];
  turns: TurnModel[];
}

function byCategory(turn: TurnModel): Array<[InputCategory, number]> {
  const totals = new Map<InputCategory, number>();
  for (const category of turn.categories) totals.set(category.category, (totals.get(category.category) || 0) + category.tokens);
  return CATEGORY_ORDER.flatMap((category) => (totals.get(category) ? [[category, totals.get(category) as number] as [InputCategory, number]] : []));
}

function compare(id: string, payload: SessionRecordsPayload, turns: TurnModel[]): Compared {
  const scopes = turnScopes(turns);
  const own = turns.filter((_, index) => scopes[index] === "conversation");
  const pick = (scope: string) => scopeTotals(turns.filter((_, index) => scopes[index] === scope));
  return {
    agent: payload.session.agent || "Unknown agent",
    auxiliary: pick("auxiliary"),
    background: pick("background"),
    first: own.find((turn) => turn.kind === "user") || own[0],
    id,
    models: [...new Set(own.map((turn) => turn.model).filter((model) => model && model !== "Unknown"))],
    own,
    queries: conversationQueries(turns),
    title: payload.session.title || own.find((turn) => turn.kind === "user" && turn.queryText)?.queryText || payload.session.first_user || "Conversation",
    totals: scopeTotals(own),
    turns,
  };
}

/* Records for every compared conversation, measured first and refined by local
   estimates for blocks the provider did not count, as in the workspace. */
function useComparedTurns(ids: string[]): { error: string; loaded: Array<{ id: string; payload: SessionRecordsPayload; turns: TurnModel[] }> | null } {
  const [payloads, setPayloads] = useState<Array<{ id: string; payload: SessionRecordsPayload }> | null>(null);
  const [error, setError] = useState("");
  const [estimates, setEstimates] = useState<TokenEstimates>(() => new Map());
  useEffect(() => {
    const controller = new AbortController();
    Promise.all(ids.map(async (id) => ({ id, payload: await fetchSessionRecords(id, controller.signal) })))
      .then(setPayloads)
      .catch((reason: Error) => {
        if (reason.name !== "AbortError") setError(reason.message || "Unable to load conversations");
      });
    return () => controller.abort();
  }, [ids]);
  const measured = useMemo(() => (payloads || []).map(({ id, payload }) => ({ id, payload, turns: buildTurns(payload.records) })), [payloads]);
  useEffect(() => {
    const texts = [...new Set(measured.flatMap(({ turns }) => estimateTexts(turns)))];
    if (!texts.length) return;
    const controller = new AbortController();
    fetchTokenEstimates(texts, controller.signal)
      .then((counts) => setEstimates(new Map(texts.map((text, index) => [text, counts[index]] as const))))
      .catch(() => undefined);
    return () => controller.abort();
  }, [measured]);
  const loaded = useMemo(() => (payloads ? (estimates.size ? measured.map((entry) => ({ ...entry, turns: buildTurns(entry.payload.records, estimates) })) : measured) : null), [estimates, measured, payloads]);
  return { error, loaded };
}

function Section({ aside, children, note, title }: { aside?: ReactNode; children: ReactNode; note?: string; title: string }) {
  return <section className="tf-panel tf-pad space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0"><h2 className="tf-heading">{title}</h2>{note ? <p className="mt-1 max-w-prose text-xs text-muted">{note}</p> : null}</div>
      {aside}
    </div>
    {children}
  </section>;
}

function Who({ item }: { item: Compared }) {
  return <span className="flex min-w-0 items-center gap-2"><AgentMark label={item.agent}/><span className="min-w-0"><span className="block truncate text-sm font-medium text-ink">{item.agent}</span><span className="block truncate text-xs text-muted" title={item.models.join(", ")}>{item.models.join(", ") || "Unknown model"}</span></span></span>;
}

function share(part: number, whole: number): string {
  return whole ? `${Math.round((part / whole) * 100)}%` : "—";
}

/* One request's input as a horizontal bar of categories, in prompt order. */
function CategoryBar({ max, turn }: { max: number; turn: TurnModel }) {
  const parts = byCategory(turn);
  return <div className="flex h-5 overflow-hidden rounded-mark bg-canvas" style={{ width: `${max ? (turn.input / max) * 100 : 0}%`, minWidth: turn.input ? 2 : 0 }}>
    {parts.map(([category, tokens]) => <span className="h-full" key={category} style={{ background: categoryColor(category), width: `${(tokens / turn.input) * 100}%` }} title={`${CATEGORY_META[category].title}: ${formatNumber(tokens)} tokens (${share(tokens, turn.input)})`}/>)}
  </div>;
}

const STRIP_HEIGHT = 96;

/* Every turn of a conversation as a column of categories, in capture order, so
   context growth, category shifts, and compaction read at a glance. */
function TurnStrip({ max, turns }: { max: number; turns: TurnModel[] }) {
  return <div className="flex items-end gap-0.5" style={{ height: STRIP_HEIGHT + 14 }}>
    {turns.map((turn) => {
      const height = max ? Math.max(turn.input ? 1 : 0, (turn.input / max) * STRIP_HEIGHT) : 0;
      const parts = byCategory(turn);
      const title = [`Turn ${turn.label} · ${turn.step}`, `${formatNumber(turn.input)} input · ${share(turn.cached, turn.input)} cached`, ...parts.map(([category, tokens]) => `${CATEGORY_META[category].title}: ${formatCompact(tokens)}`)].join("\n");
      return <div className="flex w-3.5 shrink-0 flex-col items-center gap-0.5 sm:w-4" key={turn.id} title={title}>
        <div className="flex w-full flex-col-reverse overflow-hidden rounded-mark" style={{ height }}>
          {parts.map(([category, tokens]) => <span className="w-full shrink-0" key={category} style={{ background: categoryColor(category), height: `${(tokens / turn.input) * 100}%` }}/>)}
        </div>
        <span aria-hidden="true" className={`h-3 text-center font-mono text-xs leading-3 ${turn.kind === "compaction" || turn.change?.rewritten ? "text-ink" : "text-transparent"}`}>{turn.kind === "compaction" ? "C" : turn.change?.rewritten ? "R" : "·"}</span>
      </div>;
    })}
  </div>;
}

function Legend({ categories }: { categories: InputCategory[] }) {
  return <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">{categories.map((category) => <span className="inline-flex items-center gap-1.5" key={category}><Swatch color={categoryColor(category)}/>{CATEGORY_META[category].title}</span>)}</p>;
}

/* Conversations side by side: what each spent, what its first request carried,
   how its context changed turn by turn, and what each query cost. Only each
   conversation's own requests are compared; background work and auxiliary
   requests keep their own column. */
export function CompareView({ ids, onBack, onOpen }: { ids: string[]; onBack: () => void; onOpen: (id: string) => void }) {
  const { error, loaded } = useComparedTurns(ids);
  const [firstScale, setFirstScale] = useState<Scale>("shared");
  const [turnScale, setTurnScale] = useState<Scale>("shared");
  const items = useMemo(() => (loaded || []).map(({ id, payload, turns }) => compare(id, payload, turns)), [loaded]);
  const present = CATEGORY_ORDER.filter((category) => items.some((item) => item.own.some((turn) => turn.categories.some((entry) => entry.category === category && entry.tokens))));
  const firstMax = Math.max(0, ...items.map((item) => item.first?.input || 0));
  const turnMax = Math.max(0, ...items.flatMap((item) => item.own.map((turn) => turn.input)));
  const queryCount = Math.max(0, ...items.map((item) => item.queries.length));
  const title = `Compare ${ids.length} conversations`;

  if (error) return <AppShell onBack={onBack} title={title}><main className="tf-gutter mx-auto max-w-3xl py-6"><Notice title="These conversations could not be loaded" tone="danger">{error}</Notice></main></AppShell>;
  if (!loaded) return <AppShell onBack={onBack} title={title}><main className="grid min-h-[70dvh] place-items-center"><EmptyState>Loading conversations…</EmptyState></main></AppShell>;

  const scaleSwitch = (value: Scale, onChange: (next: Scale) => void) => <Segmented label="Bar scale" onChange={onChange} options={[["shared", "Same scale"], ["own", "Own scale"]]} value={value}/>;
  return <AppShell onBack={onBack} title={title}>
    <main className="tf-gutter mx-auto w-full max-w-page space-y-3 py-3">
      <Section note="Each conversation's own requests, including the sub-agents and searches they spawned. Background work and auxiliary requests are counted apart." title="At a glance">
        <div className="-mx-2 overflow-x-auto">
          <table className="w-full min-w-[44rem] text-left text-sm">
            <thead className="tf-eyebrow"><tr className="border-b border-line">
              <th className="px-2 pb-2 font-medium">Agent</th><th className="px-2 pb-2 text-right font-medium">Turns</th><th className="px-2 pb-2 text-right font-medium">Input</th><th className="px-2 pb-2 text-right font-medium">Cached</th><th className="px-2 pb-2 text-right font-medium">Output</th><th className="px-2 pb-2 text-right font-medium">Model time</th><th className="px-2 pb-2 text-right font-medium">Background</th>
            </tr></thead>
            <tbody className="divide-y divide-line">{items.map((item) => <tr key={item.id}>
              <td className="max-w-64 px-2 py-2.5"><button className="tf-focus-inset -m-1 block max-w-full rounded-control p-1 text-left hover:bg-fill-hover" onClick={() => onOpen(item.id)} title={`Open “${item.title}”`} type="button"><Who item={item}/></button></td>
              <td className="px-2 text-right font-mono text-xs">{formatNumber(item.totals.requests)}</td>
              <td className="px-2 text-right font-mono text-xs text-ink">{formatCompact(item.totals.input)}</td>
              <td className="px-2 text-right font-mono text-xs">{share(item.totals.cached, item.totals.input)}</td>
              <td className="px-2 text-right font-mono text-xs">{formatCompact(item.totals.output)}</td>
              <td className="px-2 text-right font-mono text-xs">{item.totals.durationMs ? formatDuration(item.totals.durationMs) : "—"}</td>
              <td className="px-2 text-right font-mono text-xs" title={item.background.requests ? `${item.background.requests} background ${item.background.requests === 1 ? "turn" : "turns"}` : "No background work"}>{item.background.requests ? formatCompact(item.background.input) : "—"}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </Section>

      <Section aside={scaleSwitch(firstScale, setFirstScale)} note="Everything the harness sends before any work happens: the first request of each conversation, split by category." title="First request">
        <div className="space-y-3">{items.map((item) => <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[12rem_minmax(0,1fr)_4.5rem] sm:items-center sm:gap-3" key={item.id}>
          <Who item={item}/>
          {item.first ? <CategoryBar max={firstScale === "shared" ? firstMax : item.first.input} turn={item.first}/> : <span className="text-xs text-muted">No request</span>}
          <span className="font-mono text-xs text-ink sm:text-right">{item.first ? formatCompact(item.first.input) : "—"}</span>
        </div>)}</div>
        <Legend categories={present}/>
      </Section>

      <Section aside={scaleSwitch(turnScale, setTurnScale)} note="One column per turn, in capture order; its height is the turn's input. C marks a compaction request, R a turn whose earlier history was replaced." title="Every turn">
        <div className="space-y-4">{items.map((item) => {
          const max = turnScale === "shared" ? turnMax : Math.max(0, ...item.own.map((turn) => turn.input));
          return <div className="grid grid-cols-1 gap-2 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-3" key={item.id}>
            <div className="min-w-0 space-y-1"><Who item={item}/><p className="font-mono text-xs text-muted">max {formatCompact(max)}</p></div>
            <div className="min-w-0 overflow-x-auto"><TurnStrip max={max} turns={item.own}/></div>
          </div>;
        })}</div>
        <Legend categories={present}/>
      </Section>

      <Section note="Turns grouped by the user query they served, with each query's input and output." title="By query">
        <div className="-mx-2 overflow-x-auto">
          <table className="w-full text-left text-sm" style={{ minWidth: `${12 + queryCount * 14}rem` }}>
            <thead className="tf-eyebrow"><tr className="border-b border-line"><th className="px-2 pb-2 font-medium">Agent</th>{Array.from({ length: queryCount }, (_, index) => <th className="px-2 pb-2 font-medium" key={index}>Query {index + 1}</th>)}</tr></thead>
            <tbody className="divide-y divide-line">{items.map((item) => <tr className="align-top" key={item.id}>
              <td className="w-48 px-2 py-2.5"><Who item={item}/></td>
              {Array.from({ length: queryCount }, (_, index) => {
                const query = item.queries[index];
                return <td className="px-2 py-2.5" key={index}>{query ? <div className="space-y-0.5">
                  <p className="truncate text-xs text-muted" title={query.text}>{query.text}</p>
                  <p className="flex flex-wrap items-center gap-x-2 font-mono text-xs"><span className="text-ink">{formatCompact(query.input)}</span><span className="text-muted">{query.requests} {query.requests === 1 ? "turn" : "turns"} · {formatCompact(query.output)} out</span>{query.compactions ? <Badge tone="warning">{query.compactions} compact</Badge> : null}</p>
                </div> : <span className="text-xs text-muted">—</span>}</td>;
              })}
            </tr>)}</tbody>
          </table>
        </div>
      </Section>
    </main>
  </AppShell>;
}
