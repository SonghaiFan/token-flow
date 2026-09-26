import { asObject } from "../json";
import { closingBracket, genericResultParts, partText, scriptToolCalls, splitTruncation, type ResultPart, type ToolCall } from "../tool-results";

/* Codex's `exec` tool runs a script and returns one part per `text(...)` it
   prints, after a header part (`Script completed`, read by the row). The common
   script runs tools in parallel and prints each settled result:

     const rs = await Promise.allSettled([tools.exec_command({...}), ...]);
     rs.forEach((r, i) => text({ i, ...r }));

   so a part `{i, status, value}` is the result of the i-th call in that array.
   The value is a tool's own payload: `exec_command` returns its output with
   run facts, MCP tools return `content` and `structuredContent`. */

/* The calls in the script's first Promise.all or Promise.allSettled array. */
function settledCalls(script: string): ToolCall[] {
  const match = /Promise\.all(?:Settled)?\s*\(\s*\[/.exec(script);
  if (!match) return [];
  const start = match.index + match[0].length - 1;
  const end = closingBracket(script, start);
  return end < 0 ? [] : scriptToolCalls(script.slice(start, end + 1));
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function seconds(value: unknown): string | undefined {
  // Quick runs are the norm; only a run long enough to notice is a fact.
  return typeof value === "number" && value >= 1 ? `${value < 10 ? value.toFixed(1) : Math.round(value)} s` : undefined;
}

/* One tool payload as a part: its readable body and the facts worth a glance. */
function payloadPart(value: unknown, partIndex: number): ResultPart {
  if (typeof value === "string") {
    const { text, truncated } = splitTruncation(value);
    return { body: { kind: "text", text }, facts: [], partIndex, truncated };
  }
  const record = asObject(value);
  // exec_command: a chunk of a command's output. A session id means the process
  // is still running and later polls return the rest.
  if (typeof record.output === "string" && ("chunk_id" in record || "wall_time_seconds" in record)) {
    const { text, truncated } = splitTruncation(record.output);
    const exit = typeof record.exit_code === "number" ? record.exit_code : undefined;
    const facts = [
      record.session_id !== undefined ? `running · session ${record.session_id}` : "",
      seconds(record.wall_time_seconds) || "",
    ].filter(Boolean);
    return { body: { kind: "text", text }, facts, failure: exit ? `exit ${exit}` : undefined, partIndex, truncated };
  }
  // MCP tools: text content, and structured content when the server returns it.
  if (Array.isArray(record.content) && ("isError" in record || "structuredContent" in record)) {
    const structured = asObject(record.structuredContent);
    const text = record.content.map((item) => partText(item) ?? "").filter(Boolean).join("\n");
    const body: ResultPart["body"] = Object.keys(structured).length ? { kind: "value", value: structured } : { kind: "text", text };
    return { body, facts: [], failure: record.isError === true ? "error" : undefined, partIndex };
  }
  if (value === undefined || value === null) return { body: { kind: "text", text: "" }, facts: [], partIndex };
  if (typeof value === "object" && !Object.keys(value).length) return { body: { kind: "text", text: JSON.stringify(value) }, facts: [], partIndex };
  return { body: typeof value === "object" ? { kind: "value", value } : { kind: "text", text: String(value) }, facts: [], partIndex };
}

export function codexResultParts(call: ToolCall | undefined, parts: Array<{ part: unknown; partIndex: number }>): ResultPart[] {
  const settled = typeof call?.input === "string" ? settledCalls(call.input) : [];
  return parts.map(({ part, partIndex }) => {
    const text = partText(part);
    if (text === undefined) return genericResultParts([{ part, partIndex }])[0];
    const parsed = parseJson(text);
    if (parsed === undefined) return genericResultParts([{ part, partIndex }])[0];
    const envelope = asObject(parsed);
    if (typeof envelope.i === "number" && typeof envelope.status === "string") {
      const index = envelope.i;
      const nested = settled[index];
      if (envelope.status === "rejected") {
        return { body: { kind: "text", text: typeof envelope.reason === "string" ? envelope.reason : JSON.stringify(envelope.reason ?? null) }, call: nested, facts: [], failure: "rejected", index, partIndex };
      }
      return { ...payloadPart(envelope.value, partIndex), call: nested, index };
    }
    return payloadPart(parsed, partIndex);
  });
}
