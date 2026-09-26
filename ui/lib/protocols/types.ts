import type { AnyObject } from "../json";
import type { InputClass, TraceRecord } from "../types";

/* Prompt tokens the model read, how many came from cache, and output tokens. */
export interface PromptUsage {
  input: number;
  cached: number;
  output: number;
}

/* Prompt-cache accounting for one request, in prompt order: tokens read from
   cache, tokens written up to the last cache breakpoint, and tokens after it.
   `breakpoint` is the index in `items()` of the last item carrying a breakpoint,
   or -1 when only system text or tools carry one. */
export interface CachePrefix {
  read: number;
  written: number;
  after: number;
  breakpoint: number;
}

/* A wire protocol (OpenAI Responses, Anthropic Messages, …). It owns everything
   that follows from the request and response shape, whichever agent sent it:
   which records are model turns, the token schema, where the harness puts system
   text and conversation items, and typed content blocks. Agent-specific meaning
   lives in agent plugins (`ui/lib/agents`). */
export interface ProtocolAdapter {
  id: string;
  /* Claims a record. `path` is the request path, lower-cased, without the query. */
  matches(record: TraceRecord, path: string): boolean;
  /* One displayable primary model request. Defaults to every claimed record. */
  isTurn?(record: TraceRecord): boolean;
  /* Token schema: read prompt, cache, and output counts from the response. */
  usage(record: TraceRecord): PromptUsage;
  /* Input tokens per captured item id, when the provider reports them. */
  blockTokens?(record: TraceRecord): AnyObject;
  /* Cache counts that measure a prompt prefix (Anthropic prompt caching). */
  cachePrefix?(record: TraceRecord): CachePrefix | undefined;
  /* One conversation item as the steps it contains, in the item shapes the
     timeline reads (OpenAI Responses: message, reasoning, function_call,
     function_call_output). Protocols that pack tool calls, results, and thinking
     into one message's content blocks split them here. */
  expand?(item: unknown): unknown[];
  /* What the model returned for this request, as conversation items in the same
     shape as `items()`, so a timeline can show a turn's response after its input. */
  output?(record: TraceRecord): unknown[];
  /* Harness instructions sent beside the conversation, if any. */
  system(body: AnyObject): unknown;
  /* Tool declarations the model can call, one entry per tool with its `name`.
     Defaults to `body.tools`. */
  tools?(body: AnyObject): unknown[];
  /* Conversation items in the order the model reads them. */
  items(body: AnyObject): unknown[];
  /* Class of a typed content block inside a message (tool call, result, thinking). */
  partClass?(part: AnyObject): InputClass | undefined;
  /* A content block that carries a tool result rather than typed user text. */
  isToolResultPart?(part: AnyObject): boolean;
  /* Server-side conversation state: a request that sends only new items. */
  chain?: {
    previousId(body: AnyObject): string;
    responseId(record: TraceRecord): string;
    output(record: TraceRecord): unknown[];
  };
}
