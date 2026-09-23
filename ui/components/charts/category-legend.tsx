import { categoryColor } from "@/lib/category-palette";
import { LAYER_META, LAYER_ORDER } from "@/lib/token-model";
import type { InputLayer, TokenCategory } from "@/lib/types";

export function CategorySwatch({ label, layer }: { label: string; layer?: InputLayer }) {
  return <span aria-hidden="true" className="inline-block size-2.5 shrink-0 rounded-[3px]" style={{ background: categoryColor(label, layer) }}/>;
}

/* Legend for the categories visible in a view, grouped by input layer so the
   hue families read the same way in Composition, Token flow, and Request. */
export function CategoryLegend({ categories }: { categories: TokenCategory[] }) {
  const byLayer = new Map<InputLayer, Set<string>>();
  for (const category of categories) {
    const layer = category.layer || "unknown";
    byLayer.set(layer, (byLayer.get(layer) || new Set()).add(category.label));
  }
  const layers = LAYER_ORDER.filter((layer) => byLayer.has(layer));
  if (!layers.length) return null;
  return <div aria-label="Category colors" className="flex flex-wrap gap-x-5 gap-y-2 border-t border-line px-4 py-3 text-[10px] text-muted sm:px-5" role="list">
    {layers.map((layer) => <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1" key={layer} role="listitem">
      <span className="font-semibold text-ink">{LAYER_META[layer].title}</span>
      {[...(byLayer.get(layer) || [])].map((label) => <span className="inline-flex items-center gap-1.5" key={label}><CategorySwatch label={label} layer={layer}/>{label}</span>)}
    </div>)}
  </div>;
}
