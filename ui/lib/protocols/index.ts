import type { AnyObject } from "../json";
import type { TraceRecord } from "../types";
import { anthropicMessages } from "./anthropic-messages";
import { chatCompletions } from "./chat-completions";
import { gemini } from "./gemini";
import { openaiResponses } from "./openai-responses";
import type { ProtocolAdapter } from "./types";
import { promptUsage, usageObject } from "./usage";

export type { CachePrefix, PromptUsage, ProtocolAdapter } from "./types";

/* Legacy Cursor transcript imports: stored conversations stay readable. */
const cursorTranscript: ProtocolAdapter = {
  id: "cursor-transcript",
  matches: (record, path) => record.transport === "cursor-transcript" || path.startsWith("/cursor/transcript/"),
  usage: (record) => promptUsage(usageObject(record), false),
  system: (body) => body.instructions ?? body.system,
  items(body) {
    const source = body.input ?? body.messages;
    return Array.isArray(source) ? source : [];
  },
};

/* First match wins. Add a protocol by writing an adapter and listing it here. */
const PROTOCOLS: ProtocolAdapter[] = [cursorTranscript, openaiResponses, anthropicMessages, gemini, chatCompletions];

/* The tools a request declares, one entry per tool with its `name`. */
export function toolDeclarations(protocol: ProtocolAdapter | undefined, body: AnyObject): unknown[] {
  if (protocol?.tools) return protocol.tools(body);
  return Array.isArray(body.tools) ? body.tools : [];
}

export function requestPath(record: TraceRecord): string {
  return String(record.request?.path || "").split("?", 1)[0].toLowerCase();
}

export function protocolFor(record: TraceRecord): ProtocolAdapter | undefined {
  const path = requestPath(record);
  return PROTOCOLS.find((protocol) => protocol.matches(record, path));
}

export function protocolById(id: string): ProtocolAdapter | undefined {
  return PROTOCOLS.find((protocol) => protocol.id === id);
}

/* A Turn is one displayable primary model request, not every captured HTTP
   record: token counting and model listing are never turns. */
export function turnProtocol(record: TraceRecord): ProtocolAdapter | undefined {
  const path = requestPath(record);
  if (record.transport !== "cursor-transcript" && (!path || path.includes("/count_tokens") || path.endsWith("/models"))) return undefined;
  const protocol = protocolFor(record);
  if (!protocol) return undefined;
  return protocol.isTurn === undefined || protocol.isTurn(record) ? protocol : undefined;
}
