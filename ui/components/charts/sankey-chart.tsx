"use client";

import { useMemo, type KeyboardEvent, type MouseEvent } from "react";
import { hierarchy, treemap, treemapBinary, type HierarchyRectangularNode } from "d3-hierarchy";
import { sankey, type SankeyGraph, type SankeyLink, type SankeyNode } from "d3-sankey";
import { formatNumber } from "@/lib/format";
import { categoryColor } from "@/lib/category-palette";
import { CategoryLegend } from "./category-legend";
import type { TokenCategory, TokenSelection, TurnModel } from "@/lib/types";

interface FlowNode {
  id: string;
  layer: number;
  turnIndex: number;
  kind: "block" | "anchor";
  category?: TokenCategory;
  label: string;
  fixedValue?: number;
  order: number;
}

interface FlowLink {
  source: string | FlowNode;
  target: string | FlowNode;
  value: number;
  kind: "fresh" | "base" | "anchor";
  color: string;
  sourceAmount: number;
  targetAmount: number;
}

interface FlowTurn { turn: TurnModel; originalIndex: number }

interface MiniLeaf { category: TokenCategory; x0: number; x1: number; y0: number; y1: number }

const FLOW_BOTTOM = 470;
const MINI_Y = 500;
const MINI_WIDTH = 204;
const MINI_HEIGHT = 112;
const DESKTOP_HEIGHT = 638;
const MOBILE_WIDTH = 360;
const MIN_FLOW_SHARE = 0.03;

function rankedFlowTurn(turn: TurnModel): TurnModel {
  const grouped = new Map<string, TokenCategory>();
  for (const category of turn.categories) {
    const current = grouped.get(category.label);
    if (current) {
      current.tokens += category.tokens;
      current.cached += category.cached;
      current.fresh += category.fresh;
      current.memberIds?.push(category.id);
    } else {
      grouped.set(category.label, {
        ...category,
        id: `category:${turn.id}:${category.label}`,
        memberIds: [category.id],
      });
    }
  }
  const threshold = turn.input * MIN_FLOW_SHARE;
  const groupedCategories = [...grouped.values()];
  const visible = groupedCategories.filter((category) => category.tokens >= threshold);
  const small = groupedCategories.filter((category) => category.tokens < threshold);
  const categories = [...visible];
  if (small.length) categories.push({
    id: `others:${turn.id}`,
    label: "Others",
    tokens: small.reduce((sum, category) => sum + category.tokens, 0),
    cached: small.reduce((sum, category) => sum + category.cached, 0),
    fresh: small.reduce((sum, category) => sum + category.fresh, 0),
    color: categoryColor("Others"),
    aggregate: true,
    memberIds: small.flatMap((category) => category.memberIds || [category.id]),
  });
  categories.sort((left, right) => right.tokens - left.tokens || left.label.localeCompare(right.label));
  return { ...turn, categories };
}

function graphFor(flowTurns: FlowTurn[], extent: [[number, number], [number, number]]): SankeyGraph<FlowNode, FlowLink> | null {
  if (flowTurns.length < 2) return null;
  const nodes: FlowNode[] = [];
  const links: FlowLink[] = [];
  flowTurns.forEach(({ turn, originalIndex }, layer) => {
    turn.categories.forEach((category, categoryIndex) => nodes.push({
      id: `${layer}:${category.id}`,
      layer,
      turnIndex: originalIndex,
      kind: "block",
      category,
      label: category.label,
      fixedValue: Math.max(0.001, category.tokens),
      order: categoryIndex,
    }));
    nodes.push({ id: `anchor:${layer}`, layer, turnIndex: originalIndex, kind: "anchor", label: "", fixedValue: 0.001, order: Number.MAX_SAFE_INTEGER });
  });

  const nearest = (layer: number, target: TokenCategory): { category: TokenCategory; layer: number } | null => {
    for (let sourceLayer = layer - 1; sourceLayer >= 0; sourceLayer -= 1) {
      const match = flowTurns[sourceLayer].turn.categories.find((candidate) => candidate.label === target.label);
      if (match) return { category: match, layer: sourceLayer };
    }
    return null;
  };

  for (let layer = 1; layer < flowTurns.length; layer += 1) {
    links.push({ source: `anchor:${layer - 1}`, target: `anchor:${layer}`, value: 0.001, kind: "anchor", color: "transparent", sourceAmount: 0, targetAmount: 0 });
    flowTurns[layer].turn.categories.forEach((target) => {
      const closest = nearest(layer, target);
      if (closest) links.push({
        source: `${closest.layer}:${closest.category.id}`,
        target: `${layer}:${target.id}`,
        value: 0.001,
        kind: "base",
        color: target.color,
        sourceAmount: closest.category.tokens,
        targetAmount: target.tokens,
      });
      if (closest) links.push({
        source: `${closest.layer}:${closest.category.id}`,
        target: `${layer}:${target.id}`,
        value: 0.001,
        kind: "fresh",
        color: target.color,
        sourceAmount: closest.category.fresh,
        targetAmount: target.fresh,
      });
    });
  }
  if (!nodes.some((node) => node.kind === "block")) return null;
  const graph = sankey<FlowNode, FlowLink>()
    .nodeId((node) => node.id)
    .nodeAlign((node) => node.layer)
    .nodeSort((left, right) => left.order - right.order)
    .nodeWidth(14)
    .nodePadding(8)
    .extent(extent)({ nodes: nodes.map((node) => ({ ...node })), links: links.map((link) => ({ ...link })) });
  const [top, bottom] = [extent[0][1], extent[1][1]];
  for (let layer = 0; layer < flowTurns.length; layer += 1) {
    const column = graph.nodes.filter((node) => node.kind === "block" && node.layer === layer).sort((left, right) => (left.y0 || 0) - (right.y0 || 0));
    if (!column.length) continue;
    const first = column[0].y0 || 0;
    const last = column[column.length - 1].y1 || first;
    const offset = top + (bottom - top - (last - first)) / 2 - first;
    column.forEach((node) => { node.y0 = (node.y0 || 0) + offset; node.y1 = (node.y1 || 0) + offset; });
  }
  return graph;
}

function layerPosition(graph: SankeyGraph<FlowNode, FlowLink>, layer: number): number {
  return (graph.nodes.find((node) => node.layer === layer) as SankeyNode<FlowNode, FlowLink> | undefined)?.x0 || 0;
}

function selectionFor(node: FlowNode, turns: TurnModel[]): TokenSelection | null {
  const turn = turns[node.turnIndex];
  if (!node.category || node.category.aggregate || !turn) return null;
  const blockIds = node.category.memberIds || [node.category.id];
  return { blockId: blockIds[0], blockIds, label: node.category.label, turnId: turn.id };
}

function isSelected(selection: TokenSelection | null, node: FlowNode, turns: TurnModel[]): boolean {
  const candidate = selectionFor(node, turns);
  if (!candidate || selection?.turnId !== candidate.turnId) return false;
  const selectedIds = selection.blockIds || [selection.blockId];
  const candidateIds = candidate.blockIds || [candidate.blockId];
  return selectedIds.some((id) => candidateIds.includes(id));
}

function linkIsSelected(selection: TokenSelection | null, link: SankeyLink<FlowNode, FlowLink>, turns: TurnModel[]): boolean {
  return isSelected(selection, link.source as FlowNode, turns) || isSelected(selection, link.target as FlowNode, turns);
}

function stop(event: MouseEvent | KeyboardEvent) { event.stopPropagation(); }

function span(node: SankeyNode<FlowNode, FlowLink>, amount: number, kind: "fresh" | "base"): [number, number] {
  if (kind === "base") return [node.y0 || 0, node.y1 || 0];
  const category = node.category;
  const height = Math.max(0, (node.y1 || 0) - (node.y0 || 0));
  const size = category?.tokens ? height * Math.min(1, Math.max(0, amount) / category.tokens) : 0;
  return [(node.y1 || 0) - size, node.y1 || 0];
}

function desktopRibbon(link: SankeyLink<FlowNode, FlowLink>): string {
  const source = link.source as SankeyNode<FlowNode, FlowLink>;
  const target = link.target as SankeyNode<FlowNode, FlowLink>;
  const sx = source.x1 || 0;
  const tx = target.x0 || 0;
  const middle = (sx + tx) / 2;
  const [sy0, sy1] = span(source, link.sourceAmount, link.kind as "fresh" | "base");
  const [ty0, ty1] = span(target, link.targetAmount, link.kind as "fresh" | "base");
  return `M${sx},${sy0}C${middle},${sy0} ${middle},${ty0} ${tx},${ty0}L${tx},${ty1}C${middle},${ty1} ${middle},${sy1} ${sx},${sy1}Z`;
}

function mobileRibbon(link: SankeyLink<FlowNode, FlowLink>): string {
  const source = link.source as SankeyNode<FlowNode, FlowLink>;
  const target = link.target as SankeyNode<FlowNode, FlowLink>;
  const sy = source.x1 || 0;
  const ty = target.x0 || 0;
  const middle = (sy + ty) / 2;
  const [sx0, sx1] = span(source, link.sourceAmount, link.kind as "fresh" | "base");
  const [tx0, tx1] = span(target, link.targetAmount, link.kind as "fresh" | "base");
  return `M${sx0},${sy}C${sx0},${middle} ${tx0},${middle} ${tx0},${ty}L${tx1},${ty}C${tx1},${middle} ${sx1},${middle} ${sx1},${sy}Z`;
}

function miniLeaves(categories: TokenCategory[]): MiniLeaf[] {
  if (!categories.length) return [];
  const root = hierarchy<{ children?: TokenCategory[] }>({ children: categories })
    .sum((item) => "tokens" in item ? Number(item.tokens) : 0)
    .sort((left, right) => (right.value || 0) - (left.value || 0));
  const layout = treemap<{ children?: TokenCategory[] }>().tile(treemapBinary).size([MINI_WIDTH, MINI_HEIGHT]).paddingInner(2)(root) as HierarchyRectangularNode<{ children?: TokenCategory[] }>;
  return layout.leaves().map((leaf) => ({ category: leaf.data as unknown as TokenCategory, x0: leaf.x0, x1: leaf.x1, y0: leaf.y0, y1: leaf.y1 }));
}

function Pattern({ id }: { id: string }) {
  return <defs><pattern height="8" id={id} patternUnits="userSpaceOnUse" width="8"><path d="M-2 2L2-2M0 8L8 0M6 10L10 6" fill="none" stroke="var(--ink)" strokeOpacity="0.34" strokeWidth="1"/></pattern></defs>;
}

function MiniTreemap({ hatchId, onOpenRequest, onSelectToken, onSelectTurn, selection, turn, turnIndex }: { hatchId: string; onOpenRequest: (selection: TokenSelection) => void; onSelectToken: (selection: TokenSelection | null) => void; onSelectTurn: (index: number) => void; selection: TokenSelection | null; turn: TurnModel; turnIndex: number }) {
  return <>{miniLeaves(turn.categories).map((leaf) => {
    const blockIds = leaf.category.memberIds || [leaf.category.id];
    const next = { blockId: blockIds[0], blockIds, label: leaf.category.label, turnId: turn.id };
    const selectedIds = selection?.blockIds || (selection ? [selection.blockId] : []);
    const active = selection?.turnId === turn.id && selectedIds.some((id) => blockIds.includes(id));
    const width = Math.max(0, leaf.x1 - leaf.x0);
    const height = Math.max(0, leaf.y1 - leaf.y0);
    const cachedWidth = leaf.category.tokens ? width * Math.min(1, leaf.category.cached / leaf.category.tokens) : 0;
    const activate = () => { onSelectTurn(turnIndex); onSelectToken(leaf.category.aggregate ? null : active ? null : next); };
    return <g aria-label={`${leaf.category.label}, ${formatNumber(leaf.category.tokens)} tokens in Turn ${turnIndex + 1}${leaf.category.aggregate ? ", aggregated from categories below 3%" : ""}`} className="cursor-pointer outline-none" key={leaf.category.id} onClick={(event) => { stop(event); activate(); }} onDoubleClick={(event) => { stop(event); if (!leaf.category.aggregate) onOpenRequest(next); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); stop(event); activate(); } }} opacity={selection && !active ? 0.25 : 1} role="button" tabIndex={0}>
      <rect fill={leaf.category.color} fillOpacity="0.22" height={height} rx="3" stroke={active ? "var(--ink)" : "var(--panel)"} strokeWidth={active ? 3 : 1.5} width={width} x={leaf.x0} y={leaf.y0}/>
      {cachedWidth > 0 ? <rect fill={`url(#${hatchId})`} height={height} rx="3" width={cachedWidth} x={leaf.x0} y={leaf.y0}/> : null}
      {width > 72 && height > 24 ? <text fill="var(--ink)" fontSize="8" fontWeight="650" pointerEvents="none" x={leaf.x0 + 5} y={leaf.y0 + 13}>{leaf.category.label.slice(0, Math.max(7, Math.floor(width / 7)))}</text> : null}
      <title>{leaf.category.label}: {formatNumber(leaf.category.tokens)} tokens{blockIds.length > 1 ? ` across ${blockIds.length} request blocks` : ""}.{leaf.category.aggregate ? " Categories below 3% are combined here." : " Double-click to open request data."}</title>
    </g>;
  })}</>;
}

function FlowLinks({ graph, mobile, onSelectToken, onSelectTurn, selection, turns }: { graph: SankeyGraph<FlowNode, FlowLink>; mobile?: boolean; onSelectToken: (selection: TokenSelection | null) => void; onSelectTurn: (index: number) => void; selection: TokenSelection | null; turns: TurnModel[] }) {
  return <g>{graph.links.filter((link) => link.kind !== "anchor").map((link, index) => {
    const typed = link as SankeyLink<FlowNode, FlowLink>;
    const target = typed.target as FlowNode;
    const next = selectionFor(target, turns);
    const active = linkIsSelected(selection, typed, turns);
    const d = mobile ? mobileRibbon(typed) : desktopRibbon(typed);
    const activate = () => { onSelectTurn(target.turnIndex); onSelectToken(next); };
    const sourceTurn = (typed.source as FlowNode).turnIndex + 1;
    const targetTurn = target.turnIndex + 1;
    const meaning = link.kind === "base" ? "category footprint" : "fresh token use";
    return <path aria-label={`${next?.label || target.label}, ${meaning}: ${formatNumber(link.sourceAmount)} tokens in Turn ${sourceTurn} to ${formatNumber(link.targetAmount)} tokens in Turn ${targetTurn}`} className="cursor-pointer outline-none" d={d} fill={link.color} fillOpacity={selection && !active ? 0.025 : active ? (link.kind === "base" ? 0.25 : 0.52) : (link.kind === "base" ? 0.08 : 0.22)} key={`${index}-${(typed.source as FlowNode).id}-${target.id}-${link.kind}`} onClick={(event) => { stop(event); activate(); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); stop(event); activate(); } }} role="button" stroke="transparent" strokeWidth="8" tabIndex={0}><title>{next?.label || target.label}: {meaning} from Turn {sourceTurn} to Turn {targetTurn}</title></path>;
  })}</g>;
}

function FlowNodes({ graph, hatchId, mobile, onSelectToken, onSelectTurn, selection, turns }: { graph: SankeyGraph<FlowNode, FlowLink>; hatchId: string; mobile?: boolean; onSelectToken: (selection: TokenSelection | null) => void; onSelectTurn: (index: number) => void; selection: TokenSelection | null; turns: TurnModel[] }) {
  return <g>{graph.nodes.filter((node) => node.kind === "block").map((node) => {
    const typed = node as SankeyNode<FlowNode, FlowLink>;
    const category = node.category!;
    const active = isSelected(selection, node, turns);
    const width = mobile ? Math.max(2, (typed.y1 || 0) - (typed.y0 || 0)) : (typed.x1 || 0) - (typed.x0 || 0);
    const height = mobile ? (typed.x1 || 0) - (typed.x0 || 0) : Math.max(2, (typed.y1 || 0) - (typed.y0 || 0));
    const x = mobile ? typed.y0 || 0 : typed.x0 || 0;
    const y = mobile ? typed.x0 || 0 : typed.y0 || 0;
    const cachedSize = category.tokens ? (mobile ? width : height) * Math.min(1, category.cached / category.tokens) : 0;
    const activate = () => { const next = selectionFor(node, turns); onSelectTurn(node.turnIndex); onSelectToken(next); };
    return <g key={node.id} opacity={selection && !active ? 0.2 : 1}>
      <rect aria-label={`${category.label}, ${formatNumber(category.tokens)} tokens in Turn ${node.turnIndex + 1}; cache read ${formatNumber(category.cached)}; fresh ${formatNumber(category.fresh)}${(category.memberIds?.length || 0) > 1 ? `; ${category.memberIds?.length} request blocks combined` : ""}`} className="cursor-pointer outline-none" fill={category.color} fillOpacity="0.82" height={height} onClick={(event) => { stop(event); activate(); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); stop(event); activate(); } }} role="button" rx="3" stroke={active ? "var(--ink)" : "var(--panel)"} strokeWidth={active ? 3 : 1} tabIndex={0} width={width} x={x} y={y}><title>{category.label}: {formatNumber(category.tokens)} tokens; cache read {formatNumber(category.cached)}; fresh {formatNumber(category.fresh)}{(category.memberIds?.length || 0) > 1 ? `; ${category.memberIds?.length} request blocks combined` : ""}</title></rect>
      {cachedSize > 0 ? <rect fill={`url(#${hatchId})`} height={mobile ? height : cachedSize} pointerEvents="none" rx="3" width={mobile ? cachedSize : width} x={x} y={y}/> : null}
      {!mobile && height > 17 ? <text fill="var(--muted)" fontSize="10" fontWeight={active ? "700" : "400"} pointerEvents="none" x={(typed.x1 || 0) + 5} y={(typed.y0 || 0) + 12}>{category.label.slice(0, 22)}</text> : null}
    </g>;
  })}</g>;
}

function DesktopFlow({ flowTurns, graph, onOpenRequest, onSelectToken, onSelectTurn, selected, selection, turns, width }: { flowTurns: FlowTurn[]; graph: SankeyGraph<FlowNode, FlowLink>; onOpenRequest: (selection: TokenSelection) => void; onSelectToken: (selection: TokenSelection | null) => void; onSelectTurn: (index: number) => void; selected: number; selection: TokenSelection | null; turns: TurnModel[]; width: number }) {
  return <div aria-label="Scrollable token flow diagram" className="hidden overflow-x-auto p-4 md:block" tabIndex={0}><svg aria-label="Category token flow across turns, left to right" className="block h-auto max-w-none" onClick={() => onSelectToken(null)} role="group" style={{ width }} viewBox={`0 0 ${width} ${DESKTOP_HEIGHT}`}>
    <Pattern id="token-flow-hatch"/>
    {flowTurns.map(({ turn, originalIndex }, layer) => { const x = layerPosition(graph, layer) + 4; return <g className="cursor-pointer outline-none" key={turn.id} onClick={(event) => { stop(event); onSelectTurn(originalIndex); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); stop(event); onSelectTurn(originalIndex); } }} role="button" tabIndex={0}><rect fill={originalIndex === selected ? "var(--canvas)" : "transparent"} height="52" rx="8" width="190" x={x - 8} y="2"/><text fill={originalIndex === selected ? "var(--ink)" : "var(--muted)"} fontSize="13" fontWeight="650" x={x} y="24">Turn {originalIndex + 1}</text><text fill="var(--muted)" fontFamily="var(--font-token-flow-mono)" fontSize="10" x={x} y="42">{formatNumber(turn.input)} input tokens</text></g>; })}
    <FlowLinks graph={graph} onSelectToken={onSelectToken} onSelectTurn={onSelectTurn} selection={selection} turns={turns}/>
    <FlowNodes graph={graph} hatchId="token-flow-hatch" onSelectToken={onSelectToken} onSelectTurn={onSelectTurn} selection={selection} turns={turns}/>
    <line stroke="var(--line)" x1="20" x2={width - 20} y1={FLOW_BOTTOM + 12} y2={FLOW_BOTTOM + 12}/>
    <g aria-label="Turn composition treemaps">{flowTurns.map(({ turn, originalIndex }, layer) => <g key={turn.id} transform={`translate(${layerPosition(graph, layer) - 5} ${MINI_Y})`}><text fill="var(--muted)" fontSize="9" fontWeight="650" letterSpacing="0.08em" x="0" y="-9">COMPOSITION</text><MiniTreemap hatchId="token-flow-hatch" onOpenRequest={onOpenRequest} onSelectToken={onSelectToken} onSelectTurn={onSelectTurn} selection={selection} turn={turn} turnIndex={originalIndex}/></g>)}</g>
  </svg></div>;
}

function MobileFlow({ flowTurns, graph, height, onSelectToken, onSelectTurn, selected, selection, turns }: { flowTurns: FlowTurn[]; graph: SankeyGraph<FlowNode, FlowLink>; height: number; onSelectToken: (selection: TokenSelection | null) => void; onSelectTurn: (index: number) => void; selected: number; selection: TokenSelection | null; turns: TurnModel[] }) {
  return <div className="p-3 md:hidden"><svg aria-label="Category token flow across turns, top to bottom" className="block h-auto w-full" onClick={() => onSelectToken(null)} role="group" viewBox={`0 0 ${MOBILE_WIDTH} ${height}`}><Pattern id="token-flow-mobile-hatch"/>
    {flowTurns.map(({ turn, originalIndex }, layer) => { const y = layerPosition(graph, layer); return <g className="cursor-pointer outline-none" key={turn.id} onClick={(event) => { stop(event); onSelectTurn(originalIndex); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); stop(event); onSelectTurn(originalIndex); } }} role="button" tabIndex={0}><rect fill={originalIndex === selected ? "var(--canvas)" : "transparent"} height="48" rx="8" width="316" x="14" y={y - 52}/><text fill={originalIndex === selected ? "var(--ink)" : "var(--muted)"} fontSize="13" fontWeight="650" x="22" y={y - 36}>Turn {originalIndex + 1}</text><text fill="var(--muted)" fontFamily="var(--font-token-flow-mono)" fontSize="10" x="22" y={y - 20}>{formatNumber(turn.input)} input tokens</text></g>; })}
    <FlowLinks graph={graph} mobile onSelectToken={onSelectToken} onSelectTurn={onSelectTurn} selection={selection} turns={turns}/><FlowNodes graph={graph} hatchId="token-flow-mobile-hatch" mobile onSelectToken={onSelectToken} onSelectTurn={onSelectTurn} selection={selection} turns={turns}/>
  </svg></div>;
}

function MobileTreemaps({ flowTurns, onOpenRequest, onSelectToken, onSelectTurn, selection }: { flowTurns: FlowTurn[]; onOpenRequest: (selection: TokenSelection) => void; onSelectToken: (selection: TokenSelection | null) => void; onSelectTurn: (index: number) => void; selection: TokenSelection | null }) {
  return <div className="space-y-3 border-t border-line p-3 md:hidden"><p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">Turn compositions</p>{flowTurns.map(({ turn, originalIndex }) => <div className="rounded-xl border border-line p-2" key={turn.id}><div className="mb-2 flex items-center justify-between text-[10px]"><strong>Turn {originalIndex + 1}</strong><span className="font-mono text-muted">{formatNumber(turn.input)} input</span></div><svg aria-label={`Turn ${originalIndex + 1} composition treemap`} className="h-auto w-full" onClick={() => onSelectToken(null)} role="group" viewBox={`0 0 ${MINI_WIDTH} ${MINI_HEIGHT}`}><Pattern id={`token-flow-mini-${originalIndex}`}/><MiniTreemap hatchId={`token-flow-mini-${originalIndex}`} onOpenRequest={onOpenRequest} onSelectToken={onSelectToken} onSelectTurn={onSelectTurn} selection={selection} turn={turn} turnIndex={originalIndex}/></svg></div>)}</div>;
}

export function SankeyChart({ onOpenRequest, onSelectToken, onSelectTurn, selected, selection, turns }: { onOpenRequest: (selection: TokenSelection) => void; onSelectToken: (selection: TokenSelection | null) => void; onSelectTurn: (index: number) => void; selected: number; selection: TokenSelection | null; turns: TurnModel[] }) {
  const flowTurns = useMemo(() => turns.map((turn, originalIndex) => ({ turn: rankedFlowTurn(turn), originalIndex })).filter(({ turn }) => turn.kind !== "metadata"), [turns]);
  const desktopWidth = Math.max(900, flowTurns.length * 290 + 80);
  const mobileHeight = Math.max(520, 140 + (flowTurns.length - 1) * 190);
  const desktopGraph = useMemo(() => graphFor(flowTurns, [[28, 70], [desktopWidth - MINI_WIDTH - 28, FLOW_BOTTOM]]), [desktopWidth, flowTurns]);
  const mobileGraph = useMemo(() => graphFor(flowTurns, [[72, 22], [mobileHeight - 24, MOBILE_WIDTH - 22]]), [flowTurns, mobileHeight]);
  if (!desktopGraph || !mobileGraph) return <section className="rounded-2xl border border-line bg-panel p-6 text-sm text-muted">Token flow appears after a conversation has at least two turns.</section>;
  return <section className="overflow-hidden rounded-2xl border border-line bg-panel shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line p-4 sm:p-5"><div><h2 className="text-base font-semibold">Token flow</h2><p className="mt-1 text-xs text-muted">Ranked by token use. Categories below 3% are grouped as Others; Meta turns are omitted.</p></div><div className="flex flex-wrap items-center justify-end gap-3 text-[10px] text-muted">{selection ? <button className="max-w-44 truncate rounded-full border border-line bg-canvas px-2 py-1 text-ink" onClick={() => onSelectToken(null)} type="button">{selection.label} ×</button> : null}<span>■ Fresh use</span><span className="inline-flex items-center gap-1.5"><i className="size-2.5 bg-current opacity-20"/>Category footprint</span><span className="inline-flex items-center gap-1.5"><i className="size-2.5 border border-ink/20 bg-[repeating-linear-gradient(135deg,transparent_0,transparent_2px,currentColor_2px,currentColor_3px)]"/>Cached block</span></div></div>
    <DesktopFlow flowTurns={flowTurns} graph={desktopGraph} onOpenRequest={onOpenRequest} onSelectToken={onSelectToken} onSelectTurn={onSelectTurn} selected={selected} selection={selection} turns={turns} width={desktopWidth}/>
    <MobileFlow flowTurns={flowTurns} graph={mobileGraph} height={mobileHeight} onSelectToken={onSelectToken} onSelectTurn={onSelectTurn} selected={selected} selection={selection} turns={turns}/>
    <MobileTreemaps flowTurns={flowTurns} onOpenRequest={onOpenRequest} onSelectToken={onSelectToken} onSelectTurn={onSelectTurn} selection={selection}/>
    <CategoryLegend categories={flowTurns.flatMap(({ turn }) => turn.categories)}/>
  </section>;
}
