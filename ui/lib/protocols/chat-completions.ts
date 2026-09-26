import type { ProtocolAdapter } from "./types";
import { asObject } from "../json";
import { promptUsage, responseBody, usageObject } from "./usage";

/* OpenAI Chat Completions and legacy Completions, including OpenAI-compatible
   gateways that serve them under their own prefix. System text is a message. */
export const chatCompletions: ProtocolAdapter = {
  id: "chat-completions",
  matches: (_record, path) =>
    path.endsWith("/chat/completions") ||
    ["/v1/chat/completions", "/chat/completions", "/v1/completions", "/completions"].some((prefix) => path.startsWith(prefix)),
  usage: (record) => promptUsage(usageObject(record), false),
  output: (record) => {
    const choices = responseBody(record).choices;
    const message = Array.isArray(choices) ? asObject(asObject(choices[0]).message) : {};
    return Object.keys(message).length ? [{ ...message, role: "assistant" }] : [];
  },
  system: () => undefined,
  items(body) {
    if (Array.isArray(body.messages)) return body.messages;
    return body.prompt === undefined ? [] : [{ type: "message", role: "user", content: body.prompt }];
  },
};
