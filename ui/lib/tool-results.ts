import { asObject } from "./json";

/* One captured tool result can hold several parts. A script that runs several
   tools returns one part per value it prints, so the parts are separate results,
   not one text. Each reads on its own, under the nested call that produced it
   when the call says which. Agent plugins unwrap the payload shapes their
   harness returns (`AgentPlugin.resultParts`); the generic reading below keeps
   each captured part as it is. */

/* A call as the result reader sees it: a tool name and its input. */
export interface ToolCall {
  name: string;
  input: unknown;
}

export type ResultBody =
  | { kind: "text"; text: string }
  | { kind: "value"; value: unknown }
  | { kind: "attachment"; type: string };

export interface ResultPart {
  /* Index of the captured part inside the result item. */
  partIndex: number;
  /* The nested call that produced this part, when the call names it. */
  call?: ToolCall;
  /* The position the script gave this part, such as a Promise.allSettled index. */
  index?: number;
  /* Why the nested call failed, in a word or two: "exit 1", "rejected". */
  failure?: string;
  /* Other facts from the payload worth a glance: a long wall time, a session
     still running. */
  facts: string[];
  /* The harness cut the output down; its original size. */
  truncated?: { lines?: number; tokens?: number };
  body: ResultBody;
}

const TRUNCATION = /^Warning: truncated output \(original token count: ([\d,]+)\)\s*\n(?:Total output lines: ([\d,]+)\s*\n)?\s*/;

/* Codex prefixes a cut output with its original size. */
export function splitTruncation(text: string): { text: string; truncated?: ResultPart["truncated"] } {
  const match = TRUNCATION.exec(text);
  if (!match) return { text };
  const count = (value: string | undefined) => (value ? Number(value.replaceAll(",", "")) : undefined);
  return { text: text.slice(match[0].length), truncated: { lines: count(match[2]), tokens: count(match[1]) } };
}

const TEXT_PARTS = new Set(["", "text", "input_text", "output_text"]);

/* The text of a text part, or undefined for an attachment. */
export function partText(part: unknown): string | undefined {
  if (typeof part === "string") return part;
  const record = asObject(part);
  if (!TEXT_PARTS.has(String(record.type || ""))) return undefined;
  return typeof record.text === "string" ? record.text : "";
}

/* Each captured part as it is: text stays text, anything else is an attachment. */
export function genericResultParts(parts: Array<{ part: unknown; partIndex: number }>): ResultPart[] {
  return parts.map(({ part, partIndex }) => {
    const text = partText(part);
    if (text === undefined) return { body: { kind: "attachment", type: String(asObject(part).type || "content") }, facts: [], partIndex };
    const { text: body, truncated } = splitTruncation(text);
    return { body: { kind: "text", text: body }, facts: [], partIndex, truncated };
  });
}

/* The index of the bracket closing the one at `start`, skipping quoted text. */
export function closingBracket(value: string, start: number): number {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") quote = character;
    else if (character === "{" || character === "[") depth += 1;
    else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/* A JavaScript object literal with plain keys and JSON values, as JSON. */
function objectLiteral(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3'));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/* The `tools.name({...})` calls a script makes, in source order. A call whose
   argument is not a plain literal keeps its name with no input, so positions
   still line up. */
export function scriptToolCalls(script: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const pattern = /tools\.([A-Za-z_$][\w$]*)\s*\(\s*\{/g;
  for (let match = pattern.exec(script); match; match = pattern.exec(script)) {
    const start = match.index + match[0].length - 1;
    const end = closingBracket(script, start);
    calls.push({ input: end < 0 ? undefined : objectLiteral(script.slice(start, end + 1)), name: match[1] });
    if (end > start) pattern.lastIndex = end + 1;
  }
  return calls;
}
