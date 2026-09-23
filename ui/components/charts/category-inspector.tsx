import { formatNumber } from "@/lib/format";
import { CategorySwatch } from "./category-legend";
import type { TokenCategory } from "@/lib/types";

export function CategoryInspector({ category, total }: { category?: TokenCategory; total: number }) {
  if (!category) return <aside className="rounded-2xl border border-line bg-panel p-5 text-sm text-muted">Select a category to inspect it.</aside>;
  const share = total ? (category.tokens / total) * 100 : 0;
  const cachedShare = category.tokens ? (category.cached / category.tokens) * 100 : 0;
  return (
    <aside className="rounded-2xl border border-line bg-panel p-5 shadow-sm">
      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">Token category</div>
      <h3 className="mt-2 flex items-center gap-2 text-base font-semibold"><CategorySwatch label={category.label} layer={category.layer}/>{category.label}</h3>
      <div className="mt-5 flex items-end justify-between gap-3"><strong className="font-mono text-3xl tracking-[-0.05em]">{formatNumber(category.tokens)}</strong><span className="text-xs text-muted">{share.toFixed(1)}% of turn</span></div>
      <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-canvas" aria-label={`${cachedShare.toFixed(0)}% cached`}><span className="bg-success" style={{ width: `${cachedShare}%` }}/><span className="bg-ink" style={{ width: `${100 - cachedShare}%` }}/></div>
      <dl className="mt-5 divide-y divide-line border-t border-line text-sm">
        <div className="flex items-center justify-between py-3"><dt className="text-muted">Cache read</dt><dd className="font-mono font-semibold">{formatNumber(category.cached)}</dd></div>
        <div className="flex items-center justify-between py-3"><dt className="text-muted">Fresh token use</dt><dd className="font-mono font-semibold">{formatNumber(category.fresh)}</dd></div>
      </dl>
    </aside>
  );
}
