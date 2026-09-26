import type { InputCategory, InputClass, InputLayer } from "./types";

/* The seven categories of `.agents/docs/standards/token-model.md`, in prompt order.
   Each is changed by one driver and belongs to one layer. */
export const CATEGORY_ORDER: InputCategory[] = ["tools", "harness", "project", "runtime", "user", "model", "results", "unknown"];

export const CATEGORY_META: Record<InputCategory, { title: string; layer: InputLayer; description: string }> = {
  tools: { title: "Tools & capabilities", layer: "capabilities", description: "What the model can call or load" },
  harness: { title: "Harness instructions", layer: "instructions", description: "Written by the agent harness" },
  project: { title: "Project & memory", layer: "context", description: "Kept by the user or project in files" },
  runtime: { title: "Runtime state", layer: "context", description: "Observed and injected per request" },
  user: { title: "User input", layer: "conversation", description: "Typed or attached by the user" },
  model: { title: "Model output", layer: "conversation", description: "Produced by the model" },
  results: { title: "Tool results", layer: "conversation", description: "Returned by tools" },
  unknown: { title: "Unattributed", layer: "unknown", description: "Not matched to a captured input block" },
};

/* A class in `category`, labeled with the agent's own `detail`. */
export function inputClass(category: InputCategory, detail: string = CATEGORY_META[category].title): InputClass {
  return { category, layer: CATEGORY_META[category].layer, label: detail };
}
