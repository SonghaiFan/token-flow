import { asNumber, asObject } from "../json";
import type { InputClass } from "../types";
import type { ProtocolAdapter } from "./types";
import { promptUsage, responseBody, usageObject } from "./usage";
import { inputClass } from "../input-categories";

const PART_CLASSES: Record<string, InputClass> = {
  tool_use: inputClass("model", "Tool calls"),
  tool_result: inputClass("results", "Tool results"),
  thinking: inputClass("model", "Reasoning"),
  redacted_thinking: inputClass("model", "Reasoning"),
};

function hasBreakpoint(value: unknown): boolean {
  const message = asObject(value);
  if (message.cache_control !== undefined) return true;
  return Array.isArray(message.content) && message.content.some((part) => asObject(part).cache_control !== undefined);
}

function blockText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(blockText).filter(Boolean).join("\n");
  const block = asObject(value);
  return typeof block.text === "string" ? block.text : "";
}

/* A message's content blocks as timeline steps: text stays a message of its role;
   thinking becomes reasoning; tool_use and tool_result become a call and its result,
   joined by the tool_use id. */
function expandMessage(item: unknown): unknown[] {
  const message = asObject(item);
  const content = message.content;
  if (!Array.isArray(content)) return [item];
  const steps: unknown[] = [];
  let text: unknown[] = [];
  const flush = () => {
    if (text.length) steps.push({ ...message, content: text });
    text = [];
  };
  for (const raw of content) {
    const block = asObject(raw);
    const type = String(block.type || "");
    if (type === "thinking" || type === "redacted_thinking") {
      flush();
      steps.push({ type: "reasoning", summary: typeof block.thinking === "string" && block.thinking ? [{ type: "summary_text", text: block.thinking }] : [], encrypted_content: type === "redacted_thinking" ? block.data : undefined });
    } else if (type === "tool_use") {
      flush();
      steps.push({ type: "function_call", name: block.name, call_id: block.id, arguments: JSON.stringify(block.input ?? {}) });
    } else if (type === "tool_result") {
      flush();
      steps.push({ type: "function_call_output", call_id: block.tool_use_id, output: blockText(block.content), is_error: block.is_error });
    } else text.push(raw);
  }
  flush();
  return steps;
}

/* Anthropic Messages, directly, through gateways that add a path prefix
   (OpenRouter's `/api/v1/messages`), and through Bedrock's invoke endpoints. */
export const anthropicMessages: ProtocolAdapter = {
  id: "anthropic-messages",
  matches: (_record, path) =>
    path.endsWith("/v1/messages") ||
    path.startsWith("/v1/messages") ||
    path.startsWith("/zen/v1/messages") ||
    (path.startsWith("/model/") && (path.endsWith("/invoke") || path.endsWith("/invoke-with-response-stream"))),
  // `input_tokens` excludes cache reads and writes, which are separate buckets.
  usage: (record) => promptUsage(usageObject(record), true),
  // Prompt order is tools → system → messages. `cache_read_input_tokens` is the
  // cached prefix that was reused, `cache_creation_input_tokens` runs from there to
  // the last breakpoint, and `input_tokens` is everything after it.
  cachePrefix(record) {
    const usage = usageObject(record);
    if (usage.cache_read_input_tokens === undefined && usage.cache_creation_input_tokens === undefined) return undefined;
    if (usage.cache_read_in_input === true) return undefined;
    const messages = asObject(record.request?.body).messages;
    const items = Array.isArray(messages) ? messages : [];
    let breakpoint = -1;
    items.forEach((item, index) => {
      if (hasBreakpoint(item)) breakpoint = index;
    });
    return {
      read: asNumber(usage.cache_read_input_tokens),
      written: asNumber(usage.cache_creation_input_tokens),
      after: asNumber(usage.input_tokens),
      breakpoint,
    };
  },
  expand: expandMessage,
  // The response is one assistant message: thinking, text, and tool_use blocks.
  output: (record) => {
    const content = responseBody(record).content;
    return Array.isArray(content) && content.length ? [{ role: "assistant", content }] : [];
  },
  system: (body) => body.system,
  items(body) {
    const messages = body.messages;
    return Array.isArray(messages) ? messages : [];
  },
  // Tool calls, tool results, and thinking arrive as typed content blocks inside
  // ordinary user and assistant messages.
  partClass: (part) => PART_CLASSES[String(part.type || "").toLowerCase()],
  isToolResultPart: (part) => part.type === "tool_result",
};
