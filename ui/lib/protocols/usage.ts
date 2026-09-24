import { asNumber, asObject, type AnyObject } from "../json";
import type { TraceRecord } from "../types";
import type { PromptUsage } from "./types";

export function responseBody(record: TraceRecord): AnyObject {
  return asObject(record.response?.body);
}

/* The usage object a response reports: at the top level, inside a WebSocket
   `response` wrapper, or as backend-attached record metadata. */
export function usageObject(record: TraceRecord): AnyObject {
  const body = responseBody(record);
  const direct = asObject(body.usage);
  if (Object.keys(direct).length) return direct;
  const nested = asObject(asObject(body.response).usage);
  if (Object.keys(nested).length) return nested;
  return asObject(asObject(record as unknown).usage);
}

/* Read prompt, cache, and output counts. `cacheReadSeparate` is the protocol's own
   convention: OpenAI- and Gemini-shaped usage counts cache reads inside the prompt
   total, Anthropic-shaped usage reports cache reads and writes beside it. The
   backend's `cache_read_in_input` marker, when present, is captured evidence and
   wins over the convention. */
export function promptUsage(usage: AnyObject, cacheReadSeparate: boolean): PromptUsage {
  const base = asNumber(usage.input_tokens ?? usage.prompt_tokens);
  const output = asNumber(usage.output_tokens ?? usage.completion_tokens);
  const details = asObject(usage.input_tokens_details ?? usage.prompt_tokens_details);
  const read = asNumber(usage.cache_read_input_tokens ?? details.cached_tokens);
  const separate = typeof usage.cache_read_in_input === "boolean" ? !usage.cache_read_in_input : cacheReadSeparate;
  if (!separate) return { input: base, cached: Math.min(base, read), output };
  return { input: base + read + asNumber(usage.cache_creation_input_tokens), cached: read, output };
}
