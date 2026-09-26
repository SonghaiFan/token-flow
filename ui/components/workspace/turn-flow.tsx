"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { categoryColor, FADED_MARK_OPACITY } from "@/lib/category-palette";
import { formatCompact, formatDuration, formatNumber, formatTime } from "@/lib/format";
import { CATEGORY_META, CATEGORY_ORDER } from "@/lib/input-categories";
import { LAYER_META, LAYER_ORDER, layerTotals } from "@/lib/token-model";
import { threadIndices, threadTree, type ThreadNode } from "@/lib/threads";
import { queryGroups } from "@/lib/turn-order";
import type { InputCategory, InputLayer, TokenSelection, TurnModel } from "@/lib/types";
import { Badge, Swatch } from "../ui/badge";
import { activateOnKey } from "../motion";
import { IconButton } from "../ui/button";
import { EmptyState } from "../ui/feedback";
import { SearchField } from "../ui/field";
import { ChevronRightIcon, SearchIcon } from "../ui/icons";
import { Segmented } from "../ui/segmented";
import type { CategoryFocus } from "./input-units";

/* Fixed geometry keeps every Sankey node and ribbon aligned with its HTML row. */
const ROW = 56;
const HEADER = 30;
const THREAD_HEADER = 40;
const BRANCH = 36;
const AUXILIARY = "auxiliary";
const NODE_TOP = 20;
const NODE = 14;
const GAP = 6;
const MIN_NODE = 2;
const SEARCH_THRESHOLD = 7;

type Granularity = "layers" | "categories";

type FlowItem =
  | { kind: "thread"; key: string; label: string; top: number }
  | { kind: "query"; key: string; label: string; top: number }
  | { kind: "branch"; depth: number; detail: string; key: string; label: string; name?: string; open: boolean; threadId: string; top: number }
  | { kind: "turn"; depth: number; key: string; index: number; top: number };

interface NodeData {
  aggregate?: boolean;
  blockIds: string[];
  cached: number;
  /* The category a Categories node stands for; absent for layers and Others. */
  category?: InputCategory;
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

/* Nodes for one turn. Layers: one node per input layer. Categories: one node per
   input category, with categories under 3% of the turn's input combined as Others.
   Both keep prompt order (capabilities, instructions, context, conversation,
   unattributed). */
export function nodesFor(turn: TurnModel, granularity: Granularity): NodeData[] {
  if (granularity === "layers") {
    const totals = layerTotals(turn);
    return LAYER_ORDER.flatMap((layer) => totals[layer].tokens ? [{
      blockIds: turn.categories.filter((category) => (category.layer || "unknown") === layer).flatMap((category) => category.memberIds || [category.id]),
      estimated: turn.categories.some((category) => (category.layer || "unknown") === layer && category.estimated),
      cached: Math.min(totals[layer].cached, totals[layer].tokens),
      color: LAYER_META[layer].color,
      key: layer,
      label: LAYER_META[layer].title,
      layer,
      tokens: totals[layer].tokens,
    }] : []);
  }
  const grouped = new Map<InputCategory, NodeData>();
  for (const category of turn.categories) {
    const meta = CATEGORY_META[category.category];
    const current = grouped.get(category.category) || { blockIds: [], cached: 0, category: category.category, color: categoryColor(category.category), key: category.category, label: meta.title, layer: meta.layer, tokens: 0 };
    grouped.set(category.category, { ...current, blockIds: [...current.blockIds, ...(category.memberIds || [category.id])], cached: current.cached + category.cached, estimated: current.estimated || category.estimated, tokens: current.tokens + category.tokens });
  }
  // Small categories still carry distinct meaning and selection targets. Keep
  // their true widths instead of merging them into an uninspectable remainder.
  return [...grouped.values()].sort((left, right) => CATEGORY_ORDER.indexOf(left.category as InputCategory) - CATEGORY_ORDER.indexOf(right.category as InputCategory));
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

export function TurnFlow({ focus = null, onSelectNode, onSelectTurn, selected, selection, turns }: { focus?: CategoryFocus | null; onSelectNode: (index: number, selection: TokenSelection) => void; onSelectTurn: (index: number | null) => void; selected: number | null; selection: TokenSelection | null; turns: TurnModel[] }) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [granularity, setGranularity] = useState<Granularity>("layers");
  const [width, setWidth] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<number, HTMLButtonElement>());
  const normalized = query.trim().toLowerCase();
  const tree = useMemo(() => threadTree(turns), [turns]);
  // Branches open on demand; the branch holding the selected turn is always open.
  const [openThreads, setOpenThreads] = useState<Set<string>>(() => new Set());
  const openIds = useMemo(() => {
    const ids = new Set(openThreads);
    if (selected !== null) {
      for (const id of tree.pathOf.get(selected) || []) ids.add(id);
      if (tree.auxiliary.includes(selected)) ids.add(AUXILIARY);
    }
    return ids;
  }, [openThreads, selected, tree]);
  const toggleThread = (id: string) => setOpenThreads((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const totalInput = useMemo(() => turns.reduce((sum, turn) => sum + turn.input, 0), [turns]);

  // The diagram is drawn in real pixels so hatching, labels, and strokes stay undistorted.
  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /* Rows by thread: each top-level thread is a section, a sub-agent thread is a
     branch row after the parent turn it followed, and auxiliary requests sit at
     the end. A search lists matching turns flat, in capture order. */
  const layout = useMemo(() => {
    const items: FlowItem[] = [];
    let top = 0;
    const pushTurn = (index: number, depth: number) => {
      items.push({ depth, index, key: turns[index].id, kind: "turn", top });
      top += ROW;
    };
    if (normalized) {
      turns.forEach((turn, index) => {
        if (matchesTurn(turn, normalized)) pushTurn(index, 0);
      });
      return { height: top, items };
    }
    const inputOf = (indices: number[]) => indices.reduce((sum, index) => sum + turns[index].input, 0);
    const pushBranch = (id: string, label: string, indices: number[], depth: number, note?: string, name?: string) => {
      const open = openIds.has(id);
      const counts = `${indices.length} ${indices.length === 1 ? "turn" : "turns"} · ${formatCompact(inputOf(indices))}`;
      // A spawned agent reads by its task; the kind of thread moves into the detail.
      items.push({ depth, detail: note || (name ? `${label} · ${counts}` : counts), key: `branch-${id}`, kind: "branch", label, name, open, threadId: id, top });
      top += BRANCH;
      return open;
    };
    const emit = (node: ThreadNode, depth: number) => {
      // Query headers mark a new user request in a top-level thread.
      const groupOf = new Map<number, { id: string; label: string }>();
      if (depth === 0) {
        const groups = queryGroups(node.indices.map((index) => turns[index]));
        if (groups.length > 1) for (const group of groups) for (const position of group.indices) groupOf.set(node.indices[position], group);
      }
      const branchesAfter = (index: number) => node.branches.filter((branch) => branch.after === index);
      const emitBranch = ({ node: child }: { node: ThreadNode }) => {
        if (pushBranch(child.id, child.label || "Thread", threadIndices(child), depth, undefined, child.name)) emit(child, depth + 1);
      };
      branchesAfter(-1).forEach(emitBranch);
      let lastGroup = "";
      for (const index of node.indices) {
        const group = groupOf.get(index);
        if (group && group.id !== lastGroup) {
          items.push({ key: `query-${group.id}`, kind: "query", label: group.label, top });
          top += HEADER;
          lastGroup = group.id;
        }
        pushTurn(index, depth);
        branchesAfter(index).forEach(emitBranch);
      }
    };
    tree.roots.forEach((root, position) => {
      if (tree.roots.length > 1) {
        const asked = root.indices.map((index) => turns[index].queryText).find(Boolean);
        items.push({ key: `thread-${root.id}`, kind: "thread", label: `Conversation ${position + 1}${asked ? ` · ${asked}` : ""}`, top });
        top += THREAD_HEADER;
      }
      emit(root, 0);
    });
    // Work the harness did on its own reads after the conversation, one folded row per thread.
    if (tree.background.length) {
      items.push({ key: "thread-background", kind: "thread", label: "Background", top });
      top += THREAD_HEADER;
      tree.background.forEach((node) => {
        if (pushBranch(node.id, node.label || "Background task", threadIndices(node), 0, undefined, node.name)) emit(node, 1);
      });
    }
    if (tree.auxiliary.length && pushBranch(AUXILIARY, "Auxiliary requests", tree.auxiliary, 0, `${tree.auxiliary.length} · title generation and empty requests`)) {
      for (const index of tree.auxiliary) pushTurn(index, 1);
    }
    return { height: top, items };
  }, [normalized, openIds, tree, turns]);
  const visible = useMemo(() => layout.items.flatMap((item) => (item.kind === "turn" ? [item.index] : [])), [layout.items]);

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
        const threadId = turns[row.index].thread.id;
        for (const target of row.nodes) {
          for (let earlier = position - 1; earlier >= 0; earlier -= 1) {
            const candidate = rows[earlier];
            if (turns[candidate.index].thread.id !== threadId) continue;
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
  const focusKey = focus ? (granularity === "layers" ? focus.layer : focus.category) : "";
  const relatedKeys = selectedNodes
    ? new Set(graph.rows.flatMap((row) => row.nodes.filter((node) => isActive(row, node)).map((node) => node.key)))
    : new Set(focusKey ? [focusKey] : []);
  const hasTokenSelection = relatedKeys.size > 0;
  const pick = (row: FlowRow, node: PlacedNode) => {
    const turn = turns[row.index];
    const layerNode = granularity === "layers" && node.layer !== "unknown";
    onSelectNode(row.index, { blockId: node.blockIds[0] || "", blockIds: node.blockIds, category: node.category, label: node.label, layer: layerNode ? node.layer : undefined, turnId: turn.id });
  };

  return <aside aria-label="Token flow" className="min-w-0 border-b border-line bg-panel [--text-w:8.5rem] sm:[--text-w:10rem] lg:tf-panel lg:sticky lg:top-[calc(var(--tf-toolbar-height)+0.75rem)] lg:flex lg:h-[calc(100dvh-var(--tf-toolbar-height)-1.5rem)] lg:flex-col">
    <div className="tf-inset space-y-2 border-b border-line py-2">
      <div className="flex items-center gap-2">
        {/* The overview is the flow's resting state; this line returns to it. */}
        <button aria-current={selected === null ? "page" : undefined} className={`tf-control -ml-2 flex min-w-0 flex-1 items-center gap-2 rounded-control px-2 text-left transition-colors hover:bg-fill-hover ${selected === null ? "text-ink" : "text-muted hover:text-ink"}`} onClick={() => onSelectTurn(null)} title="Conversation overview (Esc)" type="button">
          <span className="whitespace-nowrap text-sm font-semibold">{turns.length} {turns.length === 1 ? "turn" : "turns"}</span>
          <span className="hidden truncate font-mono text-xs text-muted sm:inline">{formatCompact(totalInput)} input</span>
        </button>
        {turns.length >= SEARCH_THRESHOLD ? <IconButton active={searchOpen || Boolean(query)} aria-expanded={searchOpen} label="Search turns" onClick={() => { const next = !searchOpen; setSearchOpen(next); if (!next) setQuery(""); else window.requestAnimationFrame(() => searchRef.current?.focus()); }} title="Search turns (/)"><SearchIcon/></IconButton> : null}
        <Segmented label="Flow nodes" onChange={setGranularity} options={[["layers", "Layers"], ["categories", "Categories"]]} value={granularity}/>
      </div>
      {searchOpen || query ? <div className="flex"><SearchField autoFocus={!query} inputRef={searchRef} label="Search turns" onChange={setQuery} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setQuery(""); setSearchOpen(false); } }} placeholder="Search turns" value={query}/></div> : null}
      <div aria-label="Legend" className="flex flex-wrap gap-x-3 gap-y-1 pb-0.5 text-xs text-muted" role="list">
        {granularity === "layers" ? LAYER_ORDER.filter((layer) => layer !== "unknown").map((layer) => <span className="inline-flex items-center gap-1.5" key={layer} role="listitem"><Swatch color={LAYER_META[layer].color}/>{LAYER_META[layer].title}</span>) : CATEGORY_ORDER.filter((category) => turns.some((turn) => turn.categories.some((item) => item.category === category && item.tokens > 0))).map((category) => {
          const row = graph.rows.find((candidate) => candidate.index === selected);
          const node = row?.nodes.find((candidate) => candidate.category === category);
          return <span className="inline-flex items-center" key={category} role="listitem"><button aria-label={`Select ${CATEGORY_META[category].title} in current turn`} aria-pressed={Boolean(row && node && isActive(row, node))} className="tf-focus-inset inline-flex min-h-11 items-center gap-1.5 text-left disabled:cursor-default" disabled={!row || !node} onClick={() => { if (row && node) pick(row, node); }} type="button"><Swatch color={categoryColor(category)}/>{CATEGORY_META[category].title}</button></span>;
        })}
        <span className="inline-flex items-center gap-1.5" role="listitem" title="Hatched: read from cache. Darker ribbons carry new tokens into the next turn."><Swatch className="border border-line bg-[repeating-linear-gradient(135deg,transparent_0,transparent_2px,var(--ink)_2px,var(--ink)_3px)] opacity-60"/>cached</span>
      </div>
    </div>

    <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
      {normalized && !visible.length ? <EmptyState title={`No turns match “${query}”`}>Search matches turn numbers, prompts, tools, models, and status.</EmptyState> : null}
      <div className="relative" style={{ height: layout.height }}>
        <ol>
          {layout.items.map((item) => {
            if (item.kind === "thread") return <li className="tf-inset absolute inset-x-0 flex items-end truncate border-t border-line pb-1.5 text-sm font-semibold text-ink" key={item.key} style={{ height: THREAD_HEADER, top: item.top }} title={item.label}>{item.label}</li>;
            if (item.kind === "query") return <li className="tf-inset absolute inset-x-0 flex items-end truncate pb-1 text-xs font-medium text-muted" key={item.key} style={{ height: HEADER, top: item.top }} title={item.label}>{item.label}</li>;
            if (item.kind === "branch") return <li className="absolute inset-x-0" key={item.key} style={{ height: BRANCH, top: item.top }}>
              <button aria-expanded={item.open} className="tf-focus-inset tf-inset flex h-full w-full items-center gap-1.5 border-t border-line text-left text-xs text-muted transition-colors hover:bg-fill-hover hover:text-ink" onClick={() => toggleThread(item.threadId)} type="button">
                {item.depth ? <span aria-hidden="true" className="shrink-0" style={{ width: item.depth * 14 }}/> : null}
                <ChevronRightIcon className={`size-3.5 shrink-0 transition-transform ${item.open ? "rotate-90" : ""}`}/>
                {item.name
                  ? <span className="shrink-0 text-ink" title={item.name}>↳ <span className="font-mono font-medium">{item.name.startsWith("/") ? item.name.split("/").pop() : item.name}</span></span>
                  : <span className="shrink-0 font-medium text-ink">↳ {item.label}</span>}
                <span className="truncate">{item.detail}</span>
              </button>
            </li>;
            const turn = turns[item.index];
            const active = item.index === selected;
            const failed = turn.status >= 400;
            const auxiliary = turn.kind === "metadata";
            return <li className="absolute inset-x-0" key={item.key} style={{ height: ROW, top: item.top }}>
              <button
                aria-current={active ? "page" : undefined}
                aria-label={`Turn ${turn.label}, ${turn.step}, ${formatNumber(turn.input)} input tokens, ${cacheShare(turn)}${failed ? `, HTTP ${turn.status}` : ""}`}
                className={`tf-focus-inset tf-inset grid h-full w-full grid-cols-[var(--text-w)_minmax(0,1fr)] gap-3 border-t border-line text-left transition-colors ${active ? "bg-fill-selected shadow-[inset_3px_0_0_var(--ink)]" : "hover:bg-fill-hover"}`}
                onClick={() => onSelectTurn(item.index)}
                ref={(element) => { if (element) rowRefs.current.set(item.index, element); else rowRefs.current.delete(item.index); }}
                title={[turn.captureTurn !== undefined ? `Captured request ${turn.captureTurn}` : "", cacheShare(turn), formatDuration(turn.durationMs), formatTime(turn.timestamp)].filter(Boolean).join(" · ")}
                type="button"
              >
                {/* All row text stays in the left column; the right column belongs to the Sankey,
                    whose overlay starts at this row's inset plus the text column and gap. */}
                <span className="min-w-0 pt-2.5" style={item.depth ? { paddingLeft: item.depth * 14 } : undefined}>
                  <span className="flex items-center gap-1.5">
                    <strong className="whitespace-nowrap text-sm">Turn {turn.label}</strong>
                    {auxiliary ? <span className="hidden sm:inline-flex"><Badge title="Auxiliary request in its own thread, outside the flow">Meta</Badge></span> : null}
                    {turn.kind === "compaction" ? <span className="hidden sm:inline-flex"><Badge title="The harness asked the model to summarize the conversation so far">Compact</Badge></span> : null}
                    {turn.change?.rewritten ? <span className="hidden sm:inline-flex"><Badge title={`The conversation before this turn was replaced${turn.change.removed ? `; ${turn.change.removed} earlier ${turn.change.removed === 1 ? "item is" : "items are"} gone` : ""}`} tone="warning">Rewritten</Badge></span> : null}
                    {failed ? <Badge mono tone="danger">HTTP {turn.status}</Badge> : null}
                    <b className="ml-auto font-mono text-xs font-semibold">{formatCompact(turn.input)}</b>
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted">{turn.step}</span>
                </span>
                <span aria-hidden="true"/>
              </button>
            </li>;
          })}
        </ol>
        <div className="pointer-events-none absolute inset-y-0 left-[calc(var(--text-w)+1.5rem)] right-3 sm:left-[calc(var(--text-w)+1.75rem)] sm:right-4" ref={canvasRef}>
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
                return <g aria-label={`Turn ${turn.label}: ${node.label}`} aria-pressed={active} className="t-fade cursor-pointer" key={node.key} onClick={(event) => { event.stopPropagation(); pick(row, node); }} onKeyDown={(event) => activateOnKey(event, () => pick(row, node))} role="button" style={{ opacity: hasTokenSelection && !relatedKeys.has(node.key) ? FADED_MARK_OPACITY : 1, pointerEvents: "all" }} tabIndex={0}>
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
