import { categoryColor, LAYER_COLORS } from "@/lib/category-palette";
import type { InputCategory, InputLayer } from "@/lib/types";
import { Swatch } from "../ui/badge";

/* The color key of a category, or of a whole input layer when `layer` is set. */
export function CategorySwatch({ category, layer }: { category?: InputCategory; layer?: InputLayer }) {
  return <Swatch color={layer ? LAYER_COLORS[layer] : categoryColor(category)}/>;
}
