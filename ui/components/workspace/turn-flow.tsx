"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { categoryColor } from "@/lib/category-palette";
import { formatCompact, formatDuration, formatNumber, formatTime } from "@/lib/format";
import { LAYER_META, LAYER_ORDER, layerTotals } from "@/lib/token-model";
import { queryGroups } from "@/lib/turn-order";
import type { InputLayer, TokenSelection, TurnModel } from "@/lib/types";
import { SearchIcon } from "../icons";
import { Segmented } from "../motion";

/* Fixed geometry keeps every Sankey node and ribbon aligned with its HTML row. */
const ROW = 56;
const HEADER = 30;
const NODE_TOP = 20;
const NODE = 14;
const GAP = 6;
const MIN_NODE = 2;
const MIN_SHARE = 0.03;
const SEARCH_THRESHOLD = 7;

type Granularity = "layers" | "categories";

type FlowItem =
  | { kind: "query"; key: string; label: string; top: number }
  | { kind: "turn"; key: string; index: number; top: number };

interface NodeData {
  aggregate?: boolean;
  blockIds: string[];
  cached: number;
  color: string;
  estimated?: boolean;
  key: string;
  label: string;
  layer: InputLayer;
  tokens: number;
}

interface PlacedNode extends NodeData {
  x0: number;
  x1: number;
}

interface FlowRow {
  index: number;
  nodes: PlacedNode[];
  top: number;
}

/* Nodes for one turn. Layers: one node per input layer. Categories: blocks sharing a
   label, with categories under 3% of the turn's input combined as Others. Both keep
   prompt order (capabilities, instructions, context, conversation, unattributed). */
function nodesFor(turn: TurnModel, granularity: Granularity): NodeData[] {
  if (granularity === "layers") {
    const totals = layerTotals(turn);
    return LAYER_ORDER.flatMap((layer) => totals[layer].tokens ? [{
      blockIds: turn.categories.filter((category) => (category.layer || "unknown") === layer).map((category) => category.id),
      estimated: turn.categories.some((category) => (category.layer || "unknown") === layer && category.estimated),
      cached: Math.min(totals[layer].cached, totals[layer].tokens),
      color: LAYER_META[layer].color,
      key: layer,
      label: LAYER_META[layer].title,
      layer,
      tokens: totals[layer].tokens,
    }] : []);
  }
  const grouped = new Map<string, NodeData>();
  for (const category of turn.categories) {
    const layer = category.layer || "unknown";
    const current = grouped.get(category.label) || { blockIds: [], cached: 0, color: categoryColor(category.label, layer), key: category.label, label: category.label, layer, tokens: 0 };
    grouped.set(category.label, { ...current, blockIds: [...current.blockIds, category.id], cached: current.cached + category.cached, estimated: current.estimated || category.estimated, tokens: current.tokens + category.tokens });
  }
  const threshold = turn.input * MIN_SHARE;
  const all = [...grouped.values()];
  const kept = all.filter((node) => node.tokens >= threshold).sort((left, right) => LAYER_ORDER.indexOf(left.layer) - LAYER_ORDER.indexOf(right.layer) || right.tokens - left.tokens);
  const small = all.filter((node) => node.tokens < threshold);
  if (small.length) kept.push({
    aggregate: true,
    blockIds: small.flatMap((node) => node.blockIds),
    cached: small.reduce((sum, node) => sum + node.cached, 0),
    color: categoryColor("Others"),
    estimated: small.some((node) => node.estimated),
    key: "Others",
    label: "Others",
    layer: "unknown",
    tokens: small.reduce((sum, node) => sum + node.tokens, 0),
  });
  return kept;
}

/* A top-to-bottom ribbon between a source node's bottom edge and a target node's top edge. */
function ribbon(source: [number, number], target: [number, number], y0: number, y1: number): string {
  const middle = (y0 + y1) / 2;
  return `M${source[0]} ${y0} C${source[0]} ${middle} ${target[0]} ${middle} ${target[0]} ${y1} L${target[1]} ${y1} C${target[1]} ${middle} ${source[1]} ${middle} ${source[1]} ${y0} Z`;
}

/* The fresh-token span sits at a node's trailing edge; the cached span is hatched from its leading edge. */
function freshSpan(node: PlacedNode): [number, number] {
  const width = node.x1 - node.x0;
  const size = node.tokens ? width * Math.max(0, node.tokens - node.cached) / node.tokens : 0;
  return [node.x1 - size, node.x1];
}

function matchesTurn(turn: TurnModel, query: string): boolean {
  if (!query) return true;
  return [turn.label, turn.captureTurn, turn.title, turn.step, turn.kind, turn.model, turn.path, turn.status]
    .some((value) => String(value ?? "").toLowerCase().includes(query));
}

function cacheShare(turn: TurnModel): string {
  return turn.input ? `${Math.round((turn.cached / turn.input) * 100)}% cached` : "usage unknown";
}

function selectedIds(selection: TokenSelection | null, turn: TurnModel): string[] {
  return selection?.turnId === turn.id ? selection.blockIds || [selection.blockId] : [];
}

export function TurnFlow({ focus = null, onSelectNode, onSelectTurn, selected, selection, turns }: { focus?: { label: string; layer: InputLayer } | null; onSelectNode: (index: number, selection: TokenSelection) => void; onSelectTurn: (index: number | null) => void; selected: number | null; selection: TokenSelection | null; turns: TurnModel[] }) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [granularity, setGranularity] = useState<Granularity>("layers");
  const [width, setWidth] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<number, HTMLButtonElement>());
  const normalized = query.trim().toLowerCase();
  const visible = useMemo(() => turns.map((_, index) => index).filter((index) => matchesTurn(turns[index], normalized)), [normalized, turns]);
  const groups = useMemo(() => queryGroups(turns), [turns]);
  const totalInput = useMemo(() => turns.reduce((sum, turn) => sum + turn.input, 0), [turns]);

  // The diagram is drawn in real pixels so hatching, labels, and strokes stay undistorted.
  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(() => {
    const groupOf = new Map<number, { id: string; label: string }>();
    for (const group of groups) for (const index of group.indices) groupOf.set(index, group);
    const showHeaders = !normalized && groups.length > 1;
    const items: FlowItem[] = [];
    let top = 0;
    let lastGroup = "";
    for (const index of visible) {
      const group = groupOf.get(index);
      if (showHeaders && group && group.id !== lastGroup) {
        items.push({ key: `query-${group.id}-${index}`, kind: "query", label: group.label, top });
        top += HEADER;
        lastGroup = group.id;
      }
      items.push({ index, key: turns[index].id, kind: "turn", top });
      top += ROW;
    }
    return { height: top, items };
  }, [groups, normalized, turns, visible]);

  const graph = useMemo(() => {
    // Auxiliary requests such as title generation stay in the list but outside the flow.
    const flowItems = layout.items.flatMap((item) => item.kind === "turn" && turns[item.index].kind !== "metadata" ? [item] : []);
    const nodeData = flowItems.map((item) => nodesFor(turns[item.index], granularity));
    const maxTotal = Math.max(0, ...nodeData.map((nodes) => nodes.reduce((sum, node) => sum + node.tokens, 0)));
    const maxCount = Math.max(1, ...nodeData.map((nodes) => nodes.length));
    const scale = maxTotal && width ? Math.max(0, width - GAP * (maxCount - 1)) / maxTotal : 0;
    // One scale for every turn, so a growing context reads as a widening row; each row is centered.
    const rows: FlowRow[] = flowItems.map((item, position) => {
      const data = nodeData[position];
      const widths = data.map((node) => Math.max(MIN_NODE, node.tokens * scale));
      const span = widths.reduce((sum, value) => sum + value, 0) + GAP * Math.max(0, data.length - 1);
      let x = Math.max(0, (width - span) / 2);
      const nodes = data.map((node, nodeIndex) => {
        const placed = { ...node, x0: x, x1: x + widths[nodeIndex] };
        x += widths[nodeIndex] + GAP;
        return placed;
      });
      return { index: item.index, nodes, top: item.top };
    });
    // Each node links to the nearest earlier node with the same key in the same captured
    // thread. Links are hidden while the list is filtered, since rows are then missing.
    const links: Array<{ key: string; source: PlacedNode; sourceRow: FlowRow; target: PlacedNode; targetRow: FlowRow }> = [];
    if (!normalized) {
      rows.forEach((row, position) => {
        const lane = turns[row.index].lane;
        for (const target of row.nodes) {
          for (let earlier = position - 1; earlier >= 0; earlier -= 1) {
            const candidate = rows[earlier];
            if (turns[candidate.index].lane !== lane) continue;
            const source = candidate.nodes.find((node) => node.key === target.key);
            if (source) {
              links.push({ key: `${candidate.index}-${row.index}-${target.key}`, source, sourceRow: candidate, target, targetRow: row });
              break;
            }
          }
        }
      });
    }
    return { links, rows };
  }, [granularity, layout.items, normalized, turns, width]);

  useEffect(() => {
    if (selected !== null) rowRefs.current.get(selected)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  useEffect(() => {
    function navigate(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "/" && turns.length >= SEARCH_THRESHOLD) {
        event.preventDefault();
        setSearchOpen(true);
        window.requestAnimationFrame(() => searchRef.current?.focus());
        return;
      }
      if (event.key === "Escape") {
        onSelectTurn(null);
        return;
      }
      if (!visible.length) return;
      const position = selected === null ? -1 : visible.indexOf(selected);
      let next = position;
      if (event.key === "ArrowDown" || event.key.toLowerCase() === "j") next += 1;
      else if (event.key === "ArrowUp" || event.key.toLowerCase() === "k") next -= 1;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = visible.length - 1;
      else return;
      event.preventDefault();
      onSelectTurn(visible[Math.max(0, Math.min(next, visible.length - 1))]);
    }
    window.addEventListener("keydown", navigate);
    return () => window.removeEventListener("keydown", navigate);
  }, [onSelectTurn, selected, turns.length, visible]);

  const isActive = (row: FlowRow, node: PlacedNode) => {
    const ids = selectedIds(selection, turns[row.index]);
    return ids.length > 0 && node.blockIds.some((id) => ids.includes(id));
  };
  const selectedNodes = Boolean(selection && graph.rows.some((row) => row.nodes.some((node) => isActive(row, node))));
  // The selected node is outlined; the same layer or category stays bright in every
  // turn so its whole path through the conversation reads at once. The rest fades.
  // Without a selected node, a category focused in the overview does the same.
  const focusKey = focus ? (granularity === "layers" ? focus.layer : focus.label) : "";
  const relatedKeys = selectedNodes
    ? new Set(graph.rows.flatMap((row) => row.nodes.filter((node) => isActive(row, node)).map((node) => node.key)))
    : new Set(focusKey ? [focusKey] : []);
  const hasTokenSelection = relatedKeys.size > 0;
  const pick = (row: FlowRow, node: PlacedNode) => {
    const turn = turns[row.index];
    const layerNode = granularity === "layers" && node.layer !== "unknown";
    onSelectNode(row.index, { blockId: node.blockIds[0] || "", blockIds: node.blockIds, label: node.label, layer: layerNode ? node.layer : undefined, turnId: turn.id });
  };

  return <aside aria-label="Token flow" className="min-w-0 border-b border-line bg-panel [--text-w:8.5rem] sm:[--text-w:10rem] lg:sticky lg:top-[68px] lg:flex lg:h-[calc(100dvh-80px)] lg:flex-col lg:rounded-panel lg:border lg:shadow-sm">
    <div className="space-y-2 border-b border-line px-3 py-2.5">
      <div className="flex items-center gap-2">
        {/* The overview is the flow's resting state; this line returns to it. */}
        <button aria-current={selected === null ? "page" : undefined} className={`tf-control -ml-1 flex min-w-0 flex-1 items-baseline gap-2 rounded-control px-1 text-left transition ${selected === null ? "text-ink" : "text-muted hover:text-ink"}`} onClick={() => onSelectTurn(null)} title="Conversation overview (Esc)" type="button">
          <span className="whitespace-nowrap text-sm font-semibold">{turns.length} {turns.length === 1 ? "turn" : "turns"}</span>
          <span className="hidden truncate font-mono text-xs text-muted sm:inline">{formatCompact(totalInput)} input</span>
        </button>
        {turns.length >= SEARCH_THRESHOLD ? <button aria-expanded={searchOpen} aria-label="Search turns" className={`tf-icon-control grid shrink-0 place-items-center rounded-control hover:bg-canvas ${searchOpen || query ? "text-ink" : "text-muted"}`} onClick={() => { const next = !searchOpen; setSearchOpen(next); if (!next) setQuery(""); else window.requestAnimationFrame(() => searchRef.current?.focus()); }} title="Search turns (/)" type="button"><SearchIcon className="size-[18px]"/></button> : null}
        <Segmented compact label="Flow nodes" onChange={setGranularity} options={[["layers", "Layers"], ["categories", "Categories"]]} value={granularity}/>
      </div>
      {searchOpen || query ? <label className="relative block">
        <span className="sr-only">Search turns</span>
        <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted"/>
        <input className="tf-control w-full rounded-control border border-line bg-canvas pl-8 pr-8 text-sm outline-none placeholder:text-muted" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setQuery(""); setSearchOpen(false); } }} autoFocus={!query} placeholder="Search turns" ref={searchRef} type="search" value={query}/>
        {query ? <button aria-label="Clear turn search" className="absolute right-1 top-0 grid size-11 place-items-center text-sm text-muted hover:text-ink" onClick={() => setQuery("")} type="button">×</button> : null}
      </label> : null}
      <div aria-label="Legend" className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted" role="list">
        {LAYER_ORDER.filter((layer) => layer !== "unknown").map((layer) => <span className="inline-flex items-center gap-1.5" key={layer} role="listitem"><i className="size-2 rounded-[2px]" style={{ background: LAYER_META[layer].color }}/>{LAYER_META[layer].title}</span>)}
        <span className="inline-flex items-center gap-1.5" role="listitem" title="Hatched: read from cache. Darker ribbons carry new tokens into the next turn."><i className="size-2 rounded-[2px] border border-line bg-[repeating-linear-gradient(135deg,transparent_0,transparent_2px,var(--ink)_2px,var(--ink)_3px)] opacity-60"/>cached</span>
      </div>
    </div>

    <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
      {normalized && !visible.length ? <div className="px-3 py-10 text-center text-xs text-muted">No turns match “{query}”.</div> : null}
      <div className="relative" style={{ height: layout.height }}>
        <ol>
          {layout.items.map((item) => {
            if (item.kind === "query") return <li className="absolute inset-x-0 flex items-end truncate px-3 pb-1 text-xs font-medium text-muted" key={item.key} style={{ height: HEADER, top: item.top }} title={item.label}>{item.label}</li>;
            const turn = turns[item.index];
            const active = item.index === selected;
            const failed = turn.status >= 400;
            const auxiliary = turn.kind === "metadata";
            return <li className="absolute inset-x-0" key={item.key} style={{ height: ROW, top: item.top }}>
              <button
                aria-current={active ? "page" : undefined}
                aria-label={`Turn ${turn.label}, ${turn.step}, ${formatNumber(turn.input)} input tokens, ${cacheShare(turn)}${failed ? `, HTTP ${turn.status}` : ""}`}
                className={`grid h-full w-full grid-cols-[var(--text-w)_minmax(0,1fr)] gap-3 border-t border-line px-3 text-left transition focus-visible:outline-ink ${active ? "bg-canvas shadow-[inset_3px_0_0_var(--ink)]" : "hover:bg-canvas/60"}`}
                onClick={() => onSelectTurn(item.index)}
                ref={(element) => { if (element) rowRefs.current.set(item.index, element); else rowRefs.current.delete(item.index); }}
                title={[turn.captureTurn !== undefined ? `Captured request ${turn.captureTurn}` : "", cacheShare(turn), formatDuration(turn.durationMs), formatTime(turn.timestamp)].filter(Boolean).join(" · ")}
                type="button"
              >
                {/* All row text stays in the left column; the right column belongs to the Sankey. */}
                <span className="min-w-0 pt-2.5">
                  <span className="flex items-center gap-1.5">
                    <strong className="whitespace-nowrap text-sm">Turn {turn.label}</strong>
                    {auxiliary ? <span className="hidden rounded-full border border-line px-1.5 font-mono text-[10px] uppercase tracking-wide text-muted sm:inline" title="Auxiliary request in its own thread, outside the flow">Meta</span> : null}
                    {failed ? <span className="font-mono text-xs font-semibold text-danger">HTTP {turn.status}</span> : null}
                    <b className="ml-auto font-mono text-xs font-semibold">{formatCompact(turn.input)}</b>
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted">{turn.step}</span>
                </span>
                <span aria-hidden="true"/>
              </button>
            </li>;
          })}
        </ol>
        <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-3" ref={canvasRef} style={{ left: "calc(var(--text-w) + 1.5rem)" }}>
          {width ? <svg className="block overflow-visible" height={layout.height} viewBox={`0 0 ${width} ${Math.max(1, layout.height)}`} width={width}>
            <defs><pattern height="8" id="turn-flow-hatch" patternUnits="userSpaceOnUse" width="8"><path d="M-2 2L2-2M0 8L8 0M6 10L10 6" fill="none" stroke="var(--ink)" strokeOpacity="0.34" strokeWidth="1"/></pattern></defs>
            {(["base", "fresh"] as const).map((kind) => <g key={kind}>{graph.links.map((link) => {
              const related = relatedKeys.has(link.target.key);
              const source: [number, number] = kind === "base" ? [link.source.x0, link.source.x1] : freshSpan(link.source);
              const target: [number, number] = kind === "base" ? [link.target.x0, link.target.x1] : freshSpan(link.target);
              if (kind === "fresh" && source[1] - source[0] <= 0 && target[1] - target[0] <= 0) return null;
              const opacity = hasTokenSelection ? (related ? (kind === "base" ? 0.2 : 0.45) : 0.025) : (kind === "base" ? 0.08 : 0.22);
              return <path className="t-fade" d={ribbon(source, target, link.sourceRow.top + NODE_TOP + NODE, link.targetRow.top + NODE_TOP)} fill={link.target.color} key={`${kind}-${link.key}`} style={{ fillOpacity: opacity }}/>;
            })}</g>)}
            {graph.rows.map((row) => {
              const turn = turns[row.index];
              return <g key={row.index}>{row.nodes.map((node) => {
                const nodeWidth = node.x1 - node.x0;
                const cachedWidth = node.tokens ? nodeWidth * Math.min(1, node.cached / node.tokens) : 0;
                const active = isActive(row, node);
                const y = row.top + NODE_TOP;
                const label = nodeWidth >= node.label.length * 5.4 + 6;
                return <g className="t-fade cursor-pointer" key={node.key} onClick={(event) => { event.stopPropagation(); pick(row, node); }} style={{ opacity: hasTokenSelection && !relatedKeys.has(node.key) ? 0.22 : 1, pointerEvents: "all" }}>
                  <title>{`Turn ${turn.label} · ${node.label}: ${node.estimated ? "≈" : ""}${formatNumber(node.tokens)} tokens${node.estimated ? " (estimated)" : ""}; cache read ${formatNumber(node.cached)}; fresh ${formatNumber(node.tokens - node.cached)}${node.aggregate ? "; categories below 3% combined" : ""}`}</title>
                  <rect fill={node.color} fillOpacity={0.82} height={NODE} rx={3} stroke={active ? "var(--ink)" : "var(--panel)"} strokeWidth={active ? 2 : 1} width={nodeWidth} x={node.x0} y={y}/>
                  {cachedWidth > 0 ? <rect fill="url(#turn-flow-hatch)" height={NODE} pointerEvents="none" rx={3} width={cachedWidth} x={node.x0} y={y}/> : null}
                  {label ? <text fill="var(--muted)" fontSize={9} fontWeight={active ? 700 : 400} pointerEvents="none" x={node.x0 + 1} y={y + NODE + 10}>{node.label}</text> : null}
                </g>;
              })}</g>;
            })}
          </svg> : null}
        </div>
      </div>
    </div>
  </aside>;
}
