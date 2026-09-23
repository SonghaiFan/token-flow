import { categoryColor } from "@/lib/category-palette";
import type { InputLayer } from "@/lib/types";

export function CategorySwatch({ label, layer }: { label: string; layer?: InputLayer }) {
  return <span aria-hidden="true" className="inline-block size-2.5 shrink-0 rounded-[3px]" style={{ background: categoryColor(label, layer) }}/>;
}
