import type { InputLayer } from "./types";

/* The single category color scheme shared by Composition, Token flow, and Request.
   Every label the classifier can emit has a fixed color, so a category keeps the
   same color in every view, turn, and conversation. Hues follow the input layer:
   teal for capabilities, violet for instructions, amber for injected context,
   blue for the conversation, and gray for unattributed or aggregated input. */
export const LAYER_COLORS: Record<InputLayer, string> = {
  capabilities: "#0d9488",
  instructions: "#7c3aed",
  context: "#d97706",
  conversation: "#2563eb",
  unknown: "#94a3b8",
};

export const CATEGORY_COLORS: Record<string, string> = {
  "Tool definitions": "#0d9488",

  "Base instructions": "#6d28d9",
  "Agent role": "#4f46e5",
  "Developer instructions": "#8b5cf6",
  Memory: "#a855f7",
  Skills: "#7e22ce",
  Permissions: "#c026d3",
  "Collaboration mode": "#818cf8",
  Apps: "#9333ea",
  Plugins: "#d946ef",
  "Multi-agent mode": "#6366f1",

  "AGENTS.md": "#d97706",
  Environment: "#b45309",
  "Recommended plugins": "#f59e0b",
  "App context": "#ea580c",
  "Browser context": "#c2410c",
  "System reminder": "#ca8a04",
  "Mentioned files": "#f97316",

  "User prompt": "#2563eb",
  "Assistant messages": "#0891b2",
  Reasoning: "#1e40af",
  "Tool calls": "#0284c7",
  "Tool results": "#38bdf8",

  "Unattributed input": "#94a3b8",
  Others: "#a1a1aa",
};

export function categoryColor(label: string, layer: InputLayer = "unknown"): string {
  return CATEGORY_COLORS[label] || LAYER_COLORS[layer];
}
