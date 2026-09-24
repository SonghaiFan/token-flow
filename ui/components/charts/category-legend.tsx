import { categoryColor } from "@/lib/category-palette";
import type { InputLayer } from "@/lib/types";
import { Swatch } from "../ui/badge";

export function CategorySwatch({ label, layer }: { label: string; layer?: InputLayer }) {
  return <Swatch color={categoryColor(label, layer)}/>;
}
