import { asNumber, asObject } from "../json";
import type { InputClass } from "../types";
import type { ProtocolAdapter } from "./types";
import { promptUsage, usageObject } from "./usage";

const PART_CLASSES: Record<string, InputClass> = {
  tool_use: { layer: "conversation", label: "Tool calls" },
  tool_result: { layer: "conversation", label: "Tool results" },
  thinking: { layer: "conversation", label: "Reasoning" },
  redacted_thinking: { layer: "conversation", label: "Reasoning" },
};

function hasBreakpoint(value: unknown): boolean {
  const message = asObject(value);
  if (message.cache_control !== undefined) return true;
  return Array.isArray(message.content) && message.content.some((part) => asObject(part).cache_control !== undefined);
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
