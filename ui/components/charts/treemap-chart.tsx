"use client";

import { useMemo } from "react";
import { hierarchy, treemap, treemapBinary, type HierarchyRectangularNode } from "d3-hierarchy";
import { formatNumber } from "@/lib/format";
import type { TokenCategory, TokenSelection, TurnModel } from "@/lib/types";

const WIDTH = 900;
const HEIGHT = 500;

function clippedLabel(label: string, width: number): string {
  const limit = Math.max(8, Math.floor((width - 28) / 8));
  return label.length <= limit ? label : `${label.slice(0, Math.max(1, limit - 1))}…`;
}

export function TreemapChart({ onOpenRequest, onSelectToken, selection, turn }: { onOpenRequest: (selection: TokenSelection) => void; onSelectToken: (selection: TokenSelection | null) => void; selection: TokenSelection | null; turn: TurnModel }) {
  const categories = turn.categories;
  const leaves = useMemo(() => {
    if (!categories.length) return [];
    const root = hierarchy<{ children?: TokenCategory[] }>({ children: categories }).sum((item) => "tokens" in item ? Number(item.tokens) : 0).sort((a, b) => (b.value || 0) - (a.value || 0));
    const laidOut = treemap<{ children?: TokenCategory[] }>().tile(treemapBinary).size([WIDTH, HEIGHT]).paddingInner(4).paddingOuter(2)(root);
    return (laidOut as HierarchyRectangularNode<{ children?: TokenCategory[] }>).leaves();
  }, [categories]);

  return <section className="min-w-0 overflow-hidden rounded-2xl border border-line bg-panel shadow-sm">
    <div className="flex items-start justify-between gap-4 border-b border-line p-4 sm:p-5"><div><h2 className="text-base font-semibold">Composition</h2><p className="mt-1 text-xs text-muted">Click a block to link it. Double-click to open its request data.</p></div><div className="flex shrink-0 items-center gap-3 text-[10px] text-muted">{selection ? <button className="max-w-40 truncate rounded-full border border-line bg-canvas px-2 py-1 text-ink" onClick={() => onSelectToken(null)} type="button">{selection.label} ×</button> : null}<span className="hidden items-center gap-1.5 sm:inline-flex"><i className="size-2.5 border border-success/40 bg-[repeating-linear-gradient(135deg,transparent_0,transparent_2px,var(--cached)_2px,var(--cached)_3px)]"/>Cache read</span><span className="hidden items-center gap-1.5 sm:inline-flex"><i className="size-2.5 rounded-[2px] bg-ink"/>Fresh</span></div></div>
    {!leaves.length ? <div className="grid min-h-64 place-items-center p-6 text-center text-sm text-muted">This turn has no token attribution data.</div> : <div className="overflow-x-auto p-3 sm:p-4"><svg aria-label="Token composition treemap. Rectangle area represents category tokens; hatching represents cached tokens." className="h-auto min-w-[680px]" onClick={() => onSelectToken(null)} role="group" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
      <defs>
        <pattern height="10" id="cache-hatch" patternUnits="userSpaceOnUse" width="10"><path d="M-3 3L3-3M0 10L10 0M7 13L13 7" fill="none" stroke="var(--cached)" strokeOpacity="0.34" strokeWidth="1"/></pattern>
      </defs>
        {leaves.map((leaf, index) => {
          const category = leaf.data as unknown as TokenCategory;
          const width = leaf.x1 - leaf.x0;
          const height = leaf.y1 - leaf.y0;
          const cachedRatio = category.tokens ? Math.min(1, category.cached / category.tokens) : 0;
          const cachedWidth = width * cachedRatio;
          const share = turn.input ? (category.tokens / turn.input) * 100 : 0;
          const clipId = `treemap-leaf-${index}`;
          const selectedIds = selection?.blockIds || (selection ? [selection.blockId] : []);
          const active = selection?.turnId === turn.id && selectedIds.includes(category.id);
          const dimmed = Boolean(selection) && !active;
          const next = { blockId: category.id, label: category.label, turnId: turn.id };
          return <g aria-label={`${category.label}, ${formatNumber(category.tokens)} tokens, ${share.toFixed(1)}% of input tokens, ${formatNumber(category.cached)} cached, ${formatNumber(category.fresh)} fresh. Double-click to open request data.`} className="cursor-pointer outline-none" key={category.id} onClick={(event) => { event.stopPropagation(); onSelectToken(active ? null : next); }} onDoubleClick={(event) => { event.stopPropagation(); onOpenRequest(next); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectToken(active ? null : next); } }} role="button" tabIndex={0}>
            <clipPath id={clipId}><rect height={Math.max(0, height)} rx="10" width={Math.max(0, width)} x={leaf.x0} y={leaf.y0}/></clipPath>
            <g clipPath={`url(#${clipId})`} opacity={dimmed ? 0.28 : 1}>
              <rect fill={category.color} fillOpacity="0.2" height={Math.max(0, height)} width={Math.max(0, width)} x={leaf.x0} y={leaf.y0}/>
              {cachedWidth > 0 ? <rect fill="url(#cache-hatch)" height={Math.max(0, height)} width={cachedWidth} x={leaf.x0} y={leaf.y0}/> : null}
              {cachedRatio > 0.02 && cachedRatio < 0.98 ? <line stroke="var(--panel)" strokeOpacity="0.9" strokeWidth="2" x1={leaf.x0 + cachedWidth} x2={leaf.x0 + cachedWidth} y1={leaf.y0} y2={leaf.y1}/> : null}
            </g>
            <rect fill="none" height={Math.max(0, height)} rx="10" stroke={active ? "var(--ink)" : "var(--panel)"} strokeWidth={active ? 4 : 3} width={Math.max(0, width)} x={leaf.x0} y={leaf.y0}/>
            <g opacity={dimmed ? 0.32 : 1}>{width > 92 && height > 42 ? <text fill="var(--ink)" fontSize="14" fontWeight="650" x={leaf.x0 + 14} y={leaf.y0 + 27}>{clippedLabel(category.label, width)}</text> : null}
            {width > 120 && height > 66 ? <text fill="var(--ink)" fontFamily="var(--font-token-flow-mono)" fontSize="22" fontWeight="700" x={leaf.x0 + 14} y={leaf.y0 + 56}>{formatNumber(category.tokens)}</text> : null}
            {width > 120 && height > 94 ? <text fill="var(--muted)" fontFamily="var(--font-token-flow-mono)" fontSize="12" x={leaf.x0 + 14} y={leaf.y0 + 79}>{share.toFixed(1)}% of input</text> : null}
            {width > 220 && height > 128 ? <text fill="var(--ink)" fontFamily="var(--font-token-flow-mono)" fontSize="11" x={leaf.x0 + 14} y={leaf.y1 - 16}><tspan fill="var(--cached)" fontWeight="700">Cache {formatNumber(category.cached)}</tspan><tspan fill="var(--muted)">  ·  </tspan><tspan fontWeight="700">Fresh {formatNumber(category.fresh)}</tspan></text> : null}</g>
            <title>{category.label}: {formatNumber(category.tokens)} tokens ({share.toFixed(1)}% of input tokens); cache read {formatNumber(category.cached)}; fresh {formatNumber(category.fresh)}. Double-click to open request data.</title>
          </g>;
        })}
      </svg></div>}
  </section>;
}
