import type { ProtocolAdapter } from "./types";
import { asObject, type AnyObject } from "../json";
import { promptUsage, responseBody, usageObject } from "./usage";

const SYSTEM_ROLES = new Set(["system", "developer"]);

/* The system and developer messages before the conversation starts. The model
   reads them first, exactly like a separate system field, so they are the
   harness instructions; later ones stay in the conversation where they were sent. */
function leadingSystem(messages: unknown[]): number {
  const index = messages.findIndex((message) => !SYSTEM_ROLES.has(String(asObject(message).role || "")));
  return index < 0 ? messages.length : index;
}

function messagesOf(body: AnyObject): unknown[] {
  return Array.isArray(body.messages) ? body.messages : [];
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join("\n");
  const part = asObject(value);
  return typeof part.text === "string" ? part.text : "";
}

/* Reasoning an assistant message carries, from whichever field the provider uses:
   OpenRouter's `reasoning_details`, or `reasoning_content` / `reasoning` text. */
export function messageReasoning(message: AnyObject): { encrypted: boolean; text: string } | undefined {
  const details = Array.isArray(message.reasoning_details) ? message.reasoning_details.map(asObject) : [];
  const detailText = details.map((detail) => (typeof detail.text === "string" ? detail.text : typeof detail.summary === "string" ? detail.summary : "")).filter(Boolean).join("\n\n");
  const plain = [message.reasoning_content, message.reasoning].find((value): value is string => typeof value === "string" && Boolean(value));
  const reasoning = detailText || plain || "";
  const encrypted = details.some((detail) => detail.type === "reasoning.encrypted");
  return reasoning || encrypted ? { encrypted, text: reasoning } : undefined;
}

/* One message as timeline steps: an assistant message splits into its reasoning,
   its text, and one call per tool call; a `tool` message is the result of the call
   it names. */
function expandMessage(item: unknown): unknown[] {
  const message = asObject(item);
  const role = String(message.role || "");
  if (role === "tool") return [{ type: "function_call_output", call_id: message.tool_call_id, output: text(message.content) }];
  if (role !== "assistant") return [item];
  const steps: unknown[] = [];
  const reasoning = messageReasoning(message);
  if (reasoning) steps.push({ type: "reasoning", summary: reasoning.text ? [{ type: "summary_text", text: reasoning.text }] : [], encrypted_content: reasoning.encrypted ? true : undefined });
  if (text(message.content)) steps.push({ role: "assistant", content: message.content });
  for (const raw of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const call = asObject(raw);
    const fn = asObject(call.function);
    steps.push({ type: "function_call", name: fn.name, call_id: call.id, arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}) });
  }
  return steps.length ? steps : [item];
}

/* OpenAI Chat Completions and legacy Completions, including OpenAI-compatible
   gateways that serve them under their own prefix. */
export const chatCompletions: ProtocolAdapter = {
  id: "chat-completions",
  matches: (_record, path) =>
    path.endsWith("/chat/completions") ||
    ["/v1/chat/completions", "/chat/completions", "/v1/completions", "/completions"].some((prefix) => path.startsWith(prefix)),
  usage: (record) => promptUsage(usageObject(record), false),
  expand: expandMessage,
  output: (record) => {
    const choices = responseBody(record).choices;
    const message = Array.isArray(choices) ? asObject(asObject(choices[0]).message) : {};
    return Object.keys(message).length ? [{ ...message, role: "assistant" }] : [];
  },
  system(body) {
    const messages = messagesOf(body);
    const system = messages.slice(0, leadingSystem(messages)).map((message) => asObject(message).content);
    if (!system.length) return undefined;
    return system.length === 1 ? system[0] : system.map((content) => ({ type: "text", text: text(content) }));
  },
  // Each tool is `{type: "function", function: {name, description, parameters}}`.
  tools: (body) => (Array.isArray(body.tools) ? body.tools : []).map((raw) => {
    const tool = asObject(raw);
    const fn = asObject(tool.function);
    return Object.keys(fn).length ? { ...fn, type: tool.type } : tool;
  }),
  items(body) {
    if (Array.isArray(body.messages)) return body.messages.slice(leadingSystem(body.messages));
    return body.prompt === undefined ? [] : [{ type: "message", role: "user", content: body.prompt }];
  },
};
