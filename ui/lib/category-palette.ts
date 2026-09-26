import type { InputCategory, InputLayer } from "./types";

/* The single category color scheme shared by Composition, Token flow, and Request.
   Each of the seven categories has a fixed color, so it keeps the same color in
   every view, turn, conversation, and agent; a block's detail label takes its
   category's color. Hues follow the input layer: teal for capabilities, violet
   for instructions, amber for injected context, blue for the conversation, and
   gray for unattributed or aggregated input. */
export const LAYER_COLORS: Record<InputLayer, string> = {
  capabilities: "#0d9488",
  instructions: "#7c3aed",
  context: "#d97706",
  conversation: "#2563eb",
  unknown: "#94a3b8",
};

export const CATEGORY_COLORS: Record<InputCategory | "others", string> = {
  tools: "#0d9488",
  harness: "#7c3aed",
  project: "#b45309",
  runtime: "#f59e0b",
  user: "#2563eb",
  model: "#6366f1",
  results: "#38bdf8",
  unknown: "#94a3b8",
  others: "#a1a1aa",
};

export function categoryColor(category: InputCategory | "others" = "unknown"): string {
  return CATEGORY_COLORS[category];
}

/* Opacity of chart marks outside the current selection or focus, in every chart. */
export const FADED_MARK_OPACITY = 0.22;
