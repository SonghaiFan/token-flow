import { asNumber, asObject, type AnyObject } from "../json";
import type { TraceRecord } from "../types";
import type { ProtocolAdapter } from "./types";
import { promptUsage, responseBody, usageObject } from "./usage";

/* The Responses payload: WebSocket captures wrap it in `response`. */
function responsePayload(record: TraceRecord): AnyObject {
  const body = responseBody(record);
  const nested = asObject(body.response);
  return Object.keys(nested).length ? nested : body;
}

function isResponsesPath(path: string): boolean {
  return path === "/responses" || path.endsWith("/v1/responses") || path.endsWith("/backend-api/codex/responses");
}

export const openaiResponses: ProtocolAdapter = {
  id: "openai-responses",
  matches: (record, path) => asObject(record as unknown).derived_from_websocket === true || isResponsesPath(path),
  // Mirrors the backend display-turn contract: a warm-up request with
  // `generate: false` that produced nothing is not a turn.
  isTurn(record) {
    const requestBody = asObject(record.request?.body);
    const payload = responsePayload(record);
    const output = Array.isArray(payload.output) ? payload.output : [];
    const generateFalse = requestBody.generate === false || payload.generate === false;
    return !(generateFalse && output.length === 0 && asNumber(asObject(payload.usage).output_tokens) === 0);
  },
  usage: (record) => promptUsage(usageObject(record), false),
  // Codex reports input tokens per captured item id in `usage.attribution.items`.
  blockTokens: (record) => asObject(asObject(usageObject(record).attribution).items),
  system: (body) => body.instructions,
  items(body) {
    const input = body.input;
    if (Array.isArray(input)) return input;
    return input === undefined ? [] : [{ type: "message", role: "user", content: input }];
  },
  // A request with `previous_response_id` sends only new items; the server
  // prepends the previous request's context and its output.
  chain: {
    previousId: (body) => (typeof body.previous_response_id === "string" ? body.previous_response_id : ""),
    responseId: (record) => {
      const id = responsePayload(record).id;
      return typeof id === "string" ? id : "";
    },
    output: (record) => {
      const output = responsePayload(record).output;
      return Array.isArray(output) ? output : [];
    },
  },
};
