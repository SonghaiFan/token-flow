"use client";

import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { categoryColor, FADED_MARK_OPACITY } from "@/lib/category-palette";
import { formatNumber } from "@/lib/format";
import { LAYER_META, LAYER_ORDER } from "@/lib/token-model";
import type { InputLayer } from "@/lib/types";
import { Swatch } from "../ui/badge";

export interface CategoryTotal {
  cached: number;
  /* Some of its tokens are local estimates scaled to a measured total. */
  estimated?: boolean;
  label: string;
  layer: InputLayer;
  tokens: number;
}

export interface CategoryFocus {
  label: string;
  layer: InputLayer;
}

const TARGET_UNITS = 700;
const CELL = 10;
const GAP = 2;
const PITCH = CELL + GAP;
/* Below this many columns, layers stack as horizontal bands instead of vertical ones. */
const NARROW_COLUMNS = 40;

interface UnitGroup {
  cached: number;
  category: CategoryTotal;
  count: number;
  rounded: boolean;
}

interface Cell {
  x: number;
  y: number;
}

/* A round token amount per square, so the whole conversation fits in roughly
   TARGET_UNITS squares: 1, 2, or 5 times a power of ten. */
function unitSize(total: number): number {
  const raw = Math.max(1, total / TARGET_UNITS);
  const power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((step) => step * power).find((step) => step >= raw) || power * 10;
}

/* Slice-and-dice treemap on a grid, with exact unit counts and no empty cells:
   layers take consecutive cells along the major direction (vertical bands on wide
   screens), then categories take consecutive cells of their layer along the minor
   direction (horizontal bands inside each layer). Only the last column (or row) of
   the whole chart can be partly empty. */
function layoutUnits(layers: Array<{ groups: UnitGroup[]; layer: InputLayer }>, columns: number) {
  const total = layers.reduce((sum, layer) => sum + layer.groups.reduce((inner, group) => inner + group.count, 0), 0);
  const narrow = columns < NARROW_COLUMNS;
  const lanes = narrow ? columns : Math.max(1, Math.ceil(total / columns));
  const steps = Math.ceil(total / lanes);
  const at = (lane: number, step: number): Cell => (narrow ? { x: lane, y: step } : { x: step, y: lane });
  let next = 0;
  const regions = layers.map(({ groups, layer }) => {
    const size = groups.reduce((sum, group) => sum + group.count, 0);
    const slots = Array.from({ length: size }, (_, offset) => ({ lane: (next + offset) % lanes, step: Math.floor((next + offset) / lanes) }));
    next += size;
    // Inside a layer the direction turns: fill lane by lane, so categories form bands across it.
    slots.sort((left, right) => left.lane - right.lane || left.step - right.step);
    let used = 0;
    const categories = groups.map((group) => {
      const cells = slots.slice(used, used + group.count).map((slot) => at(slot.lane, slot.step));
      used += group.count;
      return { cells, group };
    });
    return { categories, layer };
  });
  const width = (narrow ? lanes : steps) * PITCH - GAP;
  const height = (narrow ? steps : lanes) * PITCH - GAP;
  return { height, regions, width };
}

/* Conversation input as a unit treemap: one rounded square per fixed amount of input
   tokens, laid out as a slice-and-dice treemap of layers and categories. Cached squares
   are pale and fresh squares solid. Labels stay outside the chart, so every square is data. */
export function InputUnits({ categories, focus, onFocus, total }: { categories: CategoryTotal[]; focus: CategoryFocus | null; onFocus: (focus: CategoryFocus | null) => void; total: number }) {
  const [available, setAvailable] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const unit = unitSize(total);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setAvailable(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const layers = useMemo(() => LAYER_ORDER.map((layer) => {
    const members = categories.filter((category) => category.layer === layer && category.tokens > 0).sort((left, right) => right.tokens - left.tokens);
    const groups: UnitGroup[] = members.map((category) => {
      const exact = category.tokens / unit;
      const count = Math.max(1, Math.round(exact));
      return { cached: Math.min(count, Math.round(count * (category.cached / category.tokens))), category, count, rounded: exact < 0.5 };
    });
    return {
      cached: members.reduce((sum, category) => sum + category.cached, 0),
      groups,
      layer,
      tokens: members.reduce((sum, category) => sum + category.tokens, 0),
    };
  }).filter((layer) => layer.tokens > 0), [categories, unit]);

  const layout = useMemo(() => {
    const columns = Math.floor((available + GAP) / PITCH);
    if (columns < 4 || !layers.length) return null;
    return layoutUnits(layers, columns);
  }, [available, layers]);

  const toggle = (category: CategoryTotal) => onFocus(focus?.label === category.label ? null : { label: category.label, layer: category.layer });
  const pickFromGrid = (event: MouseEvent<SVGSVGElement>) => {
    const square = (event.target as Element).closest<SVGElement>("[data-category]");
    const category = categories.find((item) => item.label === square?.dataset.category);
    if (category) toggle(category);
    else onFocus(null);
  };

  return <div className="space-y-3">
    <div className="w-full" ref={containerRef}>
      {layout ? <svg aria-hidden="true" className="block cursor-pointer" height={layout.height} onClick={pickFromGrid} width={layout.width}>
        <g>
          {layout.regions.flatMap((region) => region.categories.map(({ cells, group }) => {
            const { cached, category } = group;
            const color = categoryColor(category.label, category.layer);
            const faded = Boolean(focus) && focus?.label !== category.label;
            return <g className="t-fade" data-category={category.label} key={`${region.layer}-${category.label}`} style={{ opacity: faded ? FADED_MARK_OPACITY : 1 }}>
              <title>{`${category.label}: ${category.estimated ? "≈" : ""}${formatNumber(category.tokens)} tokens, ${formatNumber(category.cached)} cached · ${cells.length} ${cells.length === 1 ? "square" : "squares"}`}</title>
              {cells.map((cell, index) => <rect fill={color} fillOpacity={index < cached ? 0.38 : 1} height={CELL} key={index} rx={2.5} width={CELL} x={cell.x * PITCH} y={cell.y * PITCH}/>)}
            </g>;
          }))}
        </g>
      </svg> : <div className="h-40"/>}
    </div>

    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      {layers.map((layer) => <span className="inline-flex items-center gap-1.5" key={layer.layer}><Swatch color={LAYER_META[layer.layer].color}/>{LAYER_META[layer.layer].title}</span>)}
      <span className="inline-flex items-center gap-1.5"><Swatch className="bg-ink"/>1 square = {formatNumber(unit)} tokens</span>
      <span className="inline-flex items-center gap-1.5"><Swatch className="bg-ink opacity-40"/>cached</span>
      <span>A category under half a square shows as one.</span>
    </p>
  </div>;
}
