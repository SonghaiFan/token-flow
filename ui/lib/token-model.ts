import { agentById, agentForRecord, type AgentPlugin } from "./agents";
import { categoryColor, LAYER_COLORS } from "./category-palette";
import { asNumber, asObject, textOf, textParts, type AnyObject } from "./json";
import { protocolById, protocolFor, toolDeclarations, turnProtocol, type ProtocolAdapter } from "./protocols";
import { messageReasoning } from "./protocols/chat-completions";
import { responseBody } from "./protocols/usage";
import type { InputClass, InputLayer, ItemState, TokenCategory, TraceRecord, TurnModel } from "./types";

/* Turns are read by two plugins. The wire protocol (`ui/lib/protocols`) owns the
   request and response shape and the token schema; the agent (`ui/lib/agents`)
   owns what the harness means by its content. This module combines their answers
   into turns, categories, and queries. */

function stableTurnId(record: TraceRecord, index: number): string {
  if (record.request_id) return record.request_id;
  const captured = record.capture_turn ?? record.turn ?? index + 1;
  return ["turn", captured, record.timestamp || "", record.request?.path || ""].join(":");
}

function brief(value: string, limit = 26): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

/* Text parts of a user message that may be the typed prompt. When the client
   declared part kinds, only `user.text` parts qualify. Tool results that a
   protocol carries inside user messages never do. */
function userPromptParts(item: AnyObject, agent: AgentPlugin, protocol: ProtocolAdapter): string[] {
  const content = item.content ?? item.parts ?? item.text ?? item;
  if (Array.isArray(content)) {
    const kinds = content.map((_, index) => agent.declaredKind?.(item, index) || "");
    if (kinds.some(Boolean)) return textParts(content.filter((_, index) => kinds[index] === "user.text"));
    if (protocol.isToolResultPart) return textParts(content.filter((part) => !protocol.isToolResultPart?.(asObject(part))));
  }
  return textParts(content);
}

function cleanPromptText(value: string, agent: AgentPlugin): string {
  const text = value.trim();
  return agent.cleanPrompt ? agent.cleanPrompt(text) : text;
}

function isInjected(text: string, agent: AgentPlugin): boolean {
  return (agent.injectedUserPrefixes || []).some((prefix) => text.startsWith(prefix));
}

function attributedParts(item: AnyObject): unknown[] {
  const source = item.content ?? item.parts ?? item.output;
  if (Array.isArray(source)) return source;
  return source === undefined ? [] : [source];
}

function hasToolResult(item: AnyObject, protocol: ProtocolAdapter): boolean {
  const type = String(item.type || "").toLowerCase();
  if (type.endsWith("_call_output") || type === "tool_result" || type === "function_call_output") return true;
  const content = item.content ?? item.parts;
  return Array.isArray(content) && Boolean(protocol.isToolResultPart) && content.some((part) => protocol.isToolResultPart?.(asObject(part)));
}

function turnIdentity(record: TraceRecord, items: unknown[], agent: AgentPlugin, protocol: ProtocolAdapter): { title: string; kind: "user" | "metadata" | "tool" | "unknown" } {
  const declared = agent.metadataRequest?.(record);
  if (declared) return { title: declared, kind: "metadata" };
  let hasToolOutput = false;

  for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
    const item = asObject(items[itemIndex]);
    if (hasToolResult(item, protocol)) hasToolOutput = true;
    if (String(item.role || "").toLowerCase() !== "user") continue;

    const parts = userPromptParts(item, agent, protocol);
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const original = parts[partIndex];
      const lowered = original.toLowerCase();
      const metadata = (agent.metadataPrompts || []).find(([prefix]) => lowered.startsWith(prefix));
      if (metadata) return { title: metadata[1], kind: "metadata" };
      const cleaned = cleanPromptText(original, agent);
      if (!cleaned || isInjected(cleaned, agent)) continue;
      return { title: brief(cleaned, 64), kind: "user" };
    }
  }

  return hasToolOutput ? { title: "Tool result follow-up", kind: "tool" } : { title: "Model request", kind: "unknown" };
}

/* Keep the query boundary compatible with Token Flow's backend session grouping:
   Responses requests carry the same user message through every reasoning/tool
   step, so text alone cannot mean "new query". Its position among conversational
   messages is the stable boundary; a later user message gets a later index. */
function queryInputInfo(items: unknown[], agent: AgentPlugin, protocol: ProtocolAdapter): { text: string; userIndex: number; messageCount: number } {
  const rawMessages = items.filter((raw) => {
    const item = asObject(raw);
    return typeof item.role === "string" && (!item.type || item.type === "message");
  });

  for (let index = rawMessages.length - 1; index >= 0; index -= 1) {
    const message = asObject(rawMessages[index]);
    if (String(message.role || "").toLowerCase() !== "user") continue;
    const parts = userPromptParts(message, agent, protocol);
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const cleaned = cleanPromptText(parts[partIndex], agent);
      if (!cleaned || isInjected(cleaned, agent)) continue;
      return { text: brief(cleaned, 64), userIndex: index, messageCount: rawMessages.length };
    }
  }
  return { text: "", userIndex: -1, messageCount: rawMessages.length };
}

export const LAYER_ORDER: InputLayer[] = ["capabilities", "instructions", "context", "conversation", "unknown"];

export const LAYER_META: Record<InputLayer, { title: string; description: string; color: string }> = {
  capabilities: { title: "Capabilities", description: "Tools the model can call", color: LAYER_COLORS.capabilities },
  instructions: { title: "Instructions", description: "Written by the agent harness", color: LAYER_COLORS.instructions },
  context: { title: "Injected context", description: "Added by the harness on the user's behalf", color: LAYER_COLORS.context },
  conversation: { title: "Conversation", description: "Your prompts and the agent loop", color: LAYER_COLORS.conversation },
  unknown: { title: "Unattributed", description: "Not matched to a captured input block", color: LAYER_COLORS.unknown },
};

const UNATTRIBUTED: InputClass = { layer: "unknown", label: "Unattributed input" };

function classify(agent: AgentPlugin, item: AnyObject | undefined, text: string, partIndex?: number): InputClass {
  const value = text.trim();
  const type = String(item?.type || "").toLowerCase();
  if (type === "additional_tools") return { layer: "capabilities", label: "Tool definitions" };
  if (type === "reasoning" || type === "thinking") return { layer: "conversation", label: "Reasoning" };
  if (type.endsWith("_call_output") || type === "tool_result" || type === "tool_output") return { layer: "conversation", label: "Tool results" };
  if (type.endsWith("_call") || type === "tool_use") return { layer: "conversation", label: "Tool calls" };
  const declared = item && agent.declaredKind ? agent.contentKinds?.[agent.declaredKind(item, partIndex)] : undefined;
  if (declared) return declared;
  const matched = (agent.textPatterns || []).find(([pattern]) => pattern.test(value));
  if (matched) return matched[1];
  if (item?.role === "tool") return { layer: "conversation", label: "Tool results" };
  if (item?.role === "assistant" && !value && Array.isArray(item.tool_calls) && item.tool_calls.length) return { layer: "conversation", label: "Tool calls" };
  if (item?.role === "assistant" || item?.role === "model") return { layer: "conversation", label: "Assistant messages" };
  if (item?.role === "developer" || item?.role === "system") return { layer: "instructions", label: "Developer instructions" };
  if (item?.role === "user") return { layer: "conversation", label: "User prompt" };
  return UNATTRIBUTED;
}

function classifyPart(agent: AgentPlugin, protocol: ProtocolAdapter | undefined, rawItem: unknown, rawPart?: unknown, partIndex?: number): InputClass {
  const item = asObject(rawItem);
  if (rawPart !== undefined) {
    const typed = protocol?.partClass?.(asObject(rawPart));
    if (typed) return typed;
  }
  const value = rawPart === undefined ? textParts(item.content ?? item.parts ?? item.text ?? item)[0] || "" : textOf(rawPart);
  return classify(agent, item, value, rawPart === undefined ? 0 : partIndex);
}

/* Class of one captured input item, or of one content part of it. */
export function classifyInput(record: TraceRecord, rawItem: unknown, rawPart?: unknown, partIndex?: number): InputClass {
  return classifyPart(agentForRecord(record), protocolFor(record), rawItem, rawPart, partIndex);
}

/* The plugins that read a built turn. */
export function turnPlugins(turn: TurnModel): { agent: AgentPlugin; protocol: ProtocolAdapter | undefined } {
  return { agent: agentById(turn.agent), protocol: protocolById(turn.protocol) };
}

type TurnContext = { input: unknown[]; chainedFrom?: number; chainedItems: number; chainBroken: boolean };

/* The input the model actually received. When a protocol keeps conversation state
   on the server, a request sends only new items and names the previous response.
   Rebuild the rest from captured turns, matched only by response id, so a tool
   result is read next to the call the model made in the previous turn. When the
   previous response was not captured, only the request's own input is used. */
function turnContexts(records: TraceRecord[], protocols: ProtocolAdapter[]): TurnContext[] {
  const byResponseId = new Map<string, number>();
  const effective: unknown[][] = [];
  return records.map((record, index) => {
    const protocol = protocols[index];
    const body = asObject(record.request?.body);
    const own = protocol.items(body);
    const chain = protocol.chain;
    const previousId = chain ? chain.previousId(body) : "";
    const chainedFrom = previousId ? byResponseId.get(previousId) : undefined;
    const chained = chainedFrom === undefined ? [] : effective[chainedFrom];
    const input = [...chained, ...own];
    effective[index] = chain ? [...input, ...chain.output(record)] : input;
    const responseId = chain ? chain.responseId(record) : "";
    if (responseId) byResponseId.set(responseId, index);
    return { input, chainedFrom, chainedItems: chained.length, chainBroken: Boolean(previousId) && chainedFrom === undefined };
  });
}

type CatalogEntry = { item: AnyObject; classes: InputClass[]; itemClass: InputClass };

function buildCatalog(contexts: TurnContext[], agents: AgentPlugin[]): Map<string, CatalogEntry> {
  const catalog = new Map<string, CatalogEntry>();
  contexts.forEach(({ input }, index) => {
    const agent = agents[index];
    for (const rawItem of input) {
      const item = asObject(rawItem);
      if (typeof item.id !== "string" || !item.id) continue;
      const content = attributedParts(item);
      const classes = content.map((part, partIndex) => classify(agent, item, textOf(part), partIndex));
      catalog.set(item.id, { item, classes, itemClass: classify(agent, item, "", 0) });
    }
  });
  return catalog;
}

function contentSignature(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/* An item id seen in any earlier turn is carried over; the same id with different
   content is changed. Comparing against every earlier turn (not only the previous
   one) keeps auxiliary requests, such as title generation, from resetting state. */
function itemStatesByTurn(contexts: TurnContext[]): Array<Record<string, ItemState>> {
  const seen = new Map<string, string>();
  return contexts.map(({ input }) => {
    const states: Record<string, ItemState> = {};
    const current: Array<[string, string]> = [];
    for (const rawItem of input) {
      const item = asObject(rawItem);
      if (typeof item.id !== "string" || !item.id) continue;
      const signature = contentSignature(item);
      const previous = seen.get(item.id);
      states[item.id] = previous === undefined ? "new" : previous === signature ? "carried" : "changed";
      current.push([item.id, signature]);
    }
    for (const [id, signature] of current) seen.set(id, signature);
    return states;
  });
}

/* One block of the prompt, in the order the model reads it: tool definitions and
   system sections first (`item` -1), then each part of each conversation item. */
interface PromptBlock {
  inputClass: InputClass;
  item: number;
  text: string;
}

type Segment = { inputClass: InputClass; tokens: number; cached: number; estimated: boolean };
type TurnAllocation = { segments: Segment[]; fromIndex?: number; carried: number; added: number };
type CachedTurn = { total: number; breakpoint: number; head: string; items: string[]; prefix: Segment[] };

/* Estimated token counts by block text, from `/api/token-estimates`. */
export type TokenEstimates = Map<string, number>;

function blockText(part: unknown): string {
  if (typeof part === "string") return part;
  const record = asObject(part);
  for (const key of ["text", "thinking", "output", "input_text", "output_text"]) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  return contentSignature(part);
}

function systemTexts(system: unknown, agent: AgentPlugin): string[] {
  const split = (text: string) => (agent.splitSystemText ? agent.splitSystemText(text) : [text]);
  if (typeof system === "string") return split(system);
  if (Array.isArray(system)) return system.flatMap((raw) => (typeof asObject(raw).text === "string" ? split(asObject(raw).text as string) : [blockText(raw)]));
  return [blockText(system)];
}

function promptBlocks(record: TraceRecord, protocol: ProtocolAdapter, agent: AgentPlugin): PromptBlock[] {
  const body = asObject(record.request?.body);
  const blocks: PromptBlock[] = [];
  const tools = toolDeclarations(protocol, body);
  if (tools.length) blocks.push({ inputClass: { layer: "capabilities", label: "Tool definitions" }, item: -1, text: contentSignature(tools) });
  const system = protocol.system(body);
  if (system !== undefined) {
    const systemItem = { type: "instructions", role: "system" };
    for (const text of systemTexts(system, agent)) blocks.push({ inputClass: classifyPart(agent, protocol, systemItem, { type: "text", text }, 0), item: -1, text });
  }
  protocol.items(body).forEach((raw, index) => {
    const item = asObject(raw);
    const content = item.content ?? item.parts;
    // Chat Completions carries an assistant turn's reasoning and tool calls beside
    // its text; each is its own block.
    const reasoning = item.role === "assistant" ? messageReasoning(item) : undefined;
    const toolCalls = Array.isArray(item.tool_calls) && item.tool_calls.length ? item.tool_calls : undefined;
    if (reasoning?.text) blocks.push({ inputClass: { layer: "conversation", label: "Reasoning" }, item: index, text: reasoning.text });
    if (Array.isArray(content)) content.forEach((part, partIndex) => blocks.push({ inputClass: classifyPart(agent, protocol, item, part, partIndex), item: index, text: blockText(part) }));
    else if ((content !== undefined && content !== null && content !== "") || (!reasoning && !toolCalls)) blocks.push({ inputClass: classifyPart(agent, protocol, item), item: index, text: blockText(content ?? item) });
    if (toolCalls) blocks.push({ inputClass: { layer: "conversation", label: "Tool calls" }, item: index, text: contentSignature(toolCalls) });
  });
  return blocks;
}

/* Compare captured content without cache breakpoints, which harnesses move from
   turn to turn without changing what the model reads. */
function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "cache_control").map(([key, item]) => [key, withoutCacheControl(item)]));
}

function promptSignature(value: unknown): string {
  return contentSignature(withoutCacheControl(value));
}

/* Split a measured token count over the blocks it covers. Blocks that share one
   class take the count as measured. Otherwise local estimates size each block
   and are scaled so the parts sum exactly to the measured count; a shared layer
   without estimates becomes one mixed category; anything else stays Unattributed.
   Segments stay in prompt order so cached tokens can be placed as a prefix. */
function splitRange(blocks: PromptBlock[], tokens: number, estimates: TokenEstimates | undefined): Segment[] {
  if (tokens <= 0) return [];
  const labels = new Set(blocks.map((block) => `${block.inputClass.layer}:${block.inputClass.label}`));
  if (blocks.length && labels.size === 1) return [{ inputClass: blocks[0].inputClass, tokens, cached: 0, estimated: false }];
  const counts = blocks.map((block) => estimates?.get(block.text));
  const total = counts.reduce<number>((sum, count) => sum + (count || 0), 0);
  if (blocks.length && total > 0 && counts.every((count) => count !== undefined)) {
    const exact = counts.map((count) => ((count || 0) * tokens) / total);
    const shares = exact.map(Math.floor);
    let remainder = tokens - shares.reduce((sum, share) => sum + share, 0);
    for (const index of exact.map((value, position) => [value - Math.floor(value), position] as const).sort((left, right) => right[0] - left[0]).map(([, position]) => position)) {
      if (remainder <= 0) break;
      shares[index] += 1;
      remainder -= 1;
    }
    return blocks.map((block, index) => ({ inputClass: block.inputClass, tokens: shares[index], cached: 0, estimated: true }));
  }
  const layer = blocks[0]?.inputClass.layer;
  if (layer && layer !== "unknown" && blocks.every((block) => block.inputClass.layer === layer)) {
    return [{ inputClass: { layer, label: `${LAYER_META[layer].title} (mixed)` }, tokens, cached: 0, estimated: false }];
  }
  return [{ inputClass: UNATTRIBUTED, tokens, cached: 0, estimated: false }];
}

/* Cached tokens are always the start of the prompt: place them in order. */
function placeCached(segments: Segment[], cached: number): Segment[] {
  let remaining = cached;
  return segments.map((segment) => {
    const take = Math.min(segment.tokens, Math.max(0, remaining));
    remaining -= take;
    return { ...segment, cached: take };
  });
}

function mergeSegments(segments: Segment[]): Segment[] {
  const merged = new Map<string, Segment>();
  for (const segment of segments) {
    if (!segment.tokens) continue;
    const key = `${segment.inputClass.layer}:${segment.inputClass.label}`;
    const current = merged.get(key);
    merged.set(key, current ? { ...current, tokens: current.tokens + segment.tokens, cached: current.cached + segment.cached, estimated: current.estimated || segment.estimated } : { ...segment });
  }
  return [...merged.values()];
}

/* Categories for turns whose provider reports no per-item counts. Measured totals
   are split into ranges of prompt blocks, and each range is split by
   `splitRange`.

   Protocols that report a cached prefix as one count (Anthropic) give finer
   ranges. A turn continues an earlier turn only when the evidence is exact: the
   tokens it read from cache equal everything the earlier turn sent up to its last
   breakpoint, its system text and tools are unchanged, and its items up to that
   breakpoint are identical. The carried tokens keep the earlier turn's
   categories; the written tokens cover the items up to this turn's breakpoint and
   the uncached input the items after it. */
function allocateTurns(records: TraceRecord[], protocols: ProtocolAdapter[], agents: AgentPlugin[], estimates: TokenEstimates | undefined): Array<TurnAllocation | undefined> {
  const cachedTurns: Array<CachedTurn | undefined> = [];
  return records.map((record, index) => {
    const protocol = protocols[index];
    if (Object.keys(protocol.blockTokens?.(record) || {}).length) return undefined;
    const blocks = promptBlocks(record, protocol, agents[index]);
    const cache = protocol.cachePrefix?.(record);
    if (!cache) {
      const usage = protocol.usage(record);
      return { segments: mergeSegments(placeCached(splitRange(blocks, usage.input, estimates), usage.cached)), carried: 0, added: usage.input };
    }

    const body = asObject(record.request?.body);
    const items = protocol.items(body);
    const head = promptSignature([protocol.system(body), toolDeclarations(protocol, body)]);
    const signatures = items.map(promptSignature);
    let fromIndex: number | undefined;
    for (let earlierIndex = index - 1; cache.read > 0 && earlierIndex >= 0; earlierIndex -= 1) {
      const earlier = cachedTurns[earlierIndex];
      if (!earlier || earlier.total !== cache.read || earlier.head !== head || earlier.breakpoint >= items.length) continue;
      if (earlier.items.slice(0, earlier.breakpoint + 1).every((signature, itemIndex) => signature === signatures[itemIndex])) {
        fromIndex = earlierIndex;
        break;
      }
    }

    const start = fromIndex === undefined ? -Infinity : (cachedTurns[fromIndex] as CachedTurn).breakpoint;
    const carried = fromIndex === undefined ? [] : (cachedTurns[fromIndex] as CachedTurn).prefix.map((segment) => ({ ...segment, cached: segment.tokens }));
    const written = splitRange(blocks.filter((block) => block.item > start && block.item <= cache.breakpoint), fromIndex === undefined ? cache.read + cache.written : cache.written, estimates);
    const after = splitRange(blocks.filter((block) => block.item > Math.max(start, cache.breakpoint)), cache.after, estimates);
    const own = placeCached([...written, ...after], fromIndex === undefined ? cache.read : 0);
    cachedTurns[index] = {
      total: cache.read + cache.written,
      breakpoint: cache.breakpoint,
      head,
      items: signatures,
      prefix: mergeSegments([...carried, ...written].map((segment) => ({ ...segment, cached: 0 }))),
    };
    return { segments: mergeSegments([...carried, ...own]), fromIndex, carried: fromIndex === undefined ? 0 : cache.read, added: cache.written + cache.after };
  });
}

/* Unique block texts that need an estimate: blocks of turns whose categories are
   not fully measured. Send them to `/api/token-estimates`. */
export function estimateTexts(turns: TurnModel[]): string[] {
  const texts = new Set<string>();
  for (const turn of turns) {
    if (!turn.categories.some((category) => category.layer === "unknown" || category.label.endsWith("(mixed)"))) continue;
    const protocol = protocolById(turn.protocol);
    // Per-item counts from the provider are never replaced by estimates.
    if (!protocol || Object.keys(protocol.blockTokens?.(turn.record) || {}).length) continue;
    for (const block of promptBlocks(turn.record, protocol, agentById(turn.agent))) texts.add(block.text);
  }
  return [...texts];
}

/* Input tokens by category. Only counts the provider reported per item are
   attributed; the rest of the prompt stays Unattributed, never estimated. */
function categoryRows(record: TraceRecord, protocol: ProtocolAdapter, catalog: Map<string, CatalogEntry>, index: number, states: Record<string, ItemState>, allocation: TurnAllocation | undefined): TokenCategory[] {
  const attributionItems = protocol.blockTokens?.(record) || {};
  const categories: Omit<TokenCategory, "color" | "fresh">[] = [];
  let attributed = 0;

  if (allocation) {
    for (const segment of allocation.segments) {
      categories.push({ id: `alloc:${index}:${segment.inputClass.layer}:${segment.inputClass.label}`, ...segment.inputClass, tokens: segment.tokens, cached: segment.cached, ...(segment.estimated ? { estimated: true } : {}) });
      attributed += segment.tokens;
    }
  }

  for (const [itemId, rawStats] of Object.entries(attributionItems)) {
    const stats = asObject(rawStats);
    const known = catalog.get(itemId);
    const parts = Array.isArray(stats.content) ? stats.content : [];
    if (parts.length) {
      parts.forEach((rawPart, partIndex) => {
        const part = asObject(rawPart);
        const tokens = asNumber(part.input_tokens);
        if (!tokens) return;
        const cached = Math.min(tokens, asNumber(part.cached_tokens));
        const inputClass = known?.classes[partIndex] || known?.itemClass || UNATTRIBUTED;
        categories.push({ id: `${itemId}:${partIndex}`, ...inputClass, state: states[itemId], tokens, cached });
        attributed += tokens;
      });
    } else {
      const tokens = asNumber(stats.input_tokens);
      if (!tokens) continue;
      const cached = Math.min(tokens, asNumber(stats.cached_tokens));
      categories.push({ id: itemId, ...(known?.itemClass || UNATTRIBUTED), state: states[itemId], tokens, cached });
      attributed += tokens;
    }
  }

  const { input, cached: cacheRead } = protocol.usage(record);
  if (!categories.length && input) {
    categories.push({ id: `unattributed:${index}`, ...UNATTRIBUTED, tokens: input, cached: Math.min(input, cacheRead) });
  } else if (input > attributed) {
    categories.push({ id: `unattributed:${index}`, ...UNATTRIBUTED, tokens: input - attributed, cached: Math.max(0, Math.min(input - attributed, cacheRead - categories.reduce((sum, item) => sum + item.cached, 0))) });
  }

  return categories.map((category) => ({
    ...category,
    fresh: Math.max(0, category.tokens - category.cached),
    color: categoryColor(category.label, category.layer || "unknown"),
  }));
}

/* Summarize the input items this turn adds for the first time: a typed prompt, the
   tools it calls, or results whose call arrived earlier. Carried items are skipped. */
function stepSummary(items: unknown[], states: Record<string, ItemState>, agent: AgentPlugin, protocol: ProtocolAdapter): string {
  const fresh = items.map(asObject).filter((item) => typeof item.id === "string" && states[item.id] === "new");
  const freshCalls = new Set(fresh.map((item) => String(item.call_id || "")).filter(Boolean));
  const counts = new Map<string, number>();
  const add = (name: string) => counts.set(name, (counts.get(name) || 0) + 1);
  for (const item of fresh) {
    const type = String(item.type || "").toLowerCase();
    if (item.role === "user") {
      const prompt = userPromptParts(item, agent, protocol).map((text) => cleanPromptText(text, agent)).find((text) => text && !isInjected(text, agent));
      if (prompt) add(`“${brief(prompt, 40)}”`);
    } else if (type.endsWith("_call_output") || type === "tool_result") {
      if (!freshCalls.has(String(item.call_id || ""))) add("tool result");
    } else if (type.endsWith("_call") || type === "tool_use") add(String(item.name || "tool call"));
    else if (item.role === "assistant") add("reply");
  }
  return [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(", ");
}

/* The captured thread a request belongs to. Auxiliary requests such as title
   generation run in their own thread, so they never join the main flow. */
function laneFor(record: TraceRecord): string {
  const body = asObject(record.request?.body);
  const metadata = asObject(body.client_metadata);
  const headers = asObject(record.request?.headers);
  return String(metadata.thread_id || body.prompt_cache_key || headers["thread-id"] || headers["session-id"] || "");
}

function threadOf(record: TraceRecord, agent: AgentPlugin, records: TraceRecord[], index: number): TurnModel["thread"] {
  const declared = agent.thread?.(record, { index, records }) || {};
  return { id: declared.id || laneFor(record), label: declared.label, name: declared.name, parentId: declared.parentId };
}

export type LayerTotals = Record<InputLayer, { cached: number; tokens: number }>;

export function layerTotals(turn: TurnModel): LayerTotals {
  const totals = Object.fromEntries(LAYER_ORDER.map((layer) => [layer, { cached: 0, tokens: 0 }])) as LayerTotals;
  for (const category of turn.categories) {
    const total = totals[category.layer || "unknown"];
    total.tokens += category.tokens;
    total.cached += category.cached;
  }
  return totals;
}

export function buildTurns(records: TraceRecord[], estimates?: TokenEstimates): TurnModel[] {
  const turnRecords = records
    .map((record) => ({ record, protocol: turnProtocol(record) }))
    .filter((entry): entry is { record: TraceRecord; protocol: ProtocolAdapter } => entry.protocol !== undefined)
    .sort((left, right) => {
      const leftTurn = Number(left.record.turn);
      const rightTurn = Number(right.record.turn);
      if (Number.isFinite(leftTurn) && Number.isFinite(rightTurn) && leftTurn !== rightTurn) return leftTurn - rightTurn;
      return String(left.record.timestamp || "").localeCompare(String(right.record.timestamp || ""));
    });
  const protocols = turnRecords.map((entry) => entry.protocol);
  const agents = turnRecords.map((entry) => agentForRecord(entry.record));
  const allRecords = turnRecords.map((entry) => entry.record);
  const contexts = turnContexts(allRecords, protocols);
  const catalog = buildCatalog(contexts, agents);
  const states = itemStatesByTurn(contexts);
  const cacheLinks = allocateTurns(turnRecords.map((entry) => entry.record), protocols, agents, estimates);
  return turnRecords.map(({ record, protocol }, index) => {
    const agent = agents[index];
    const { input, cached, output } = protocol.usage(record);
    const context = contexts[index];
    const requestBody = asObject(record.request?.body);
    const items = context.chainedItems ? context.input : protocol.items(requestBody);
    const response = responseBody(record);
    const identity = turnIdentity(record, items, agent, protocol);
    const query = queryInputInfo(items, agent, protocol);
    return {
      id: stableTurnId(record, index),
      index,
      label: String(record.display_turn ?? index + 1),
      captureTurn: record.capture_turn ?? record.turn,
      title: identity.title,
      step: identity.kind === "metadata" ? identity.title : stepSummary(items, states[index], agent, protocol) || identity.title,
      kind: identity.kind,
      queryText: query.text,
      queryUserIndex: query.userIndex,
      queryMessageCount: query.messageCount,
      timestamp: record.timestamp,
      durationMs: asNumber(record.duration_ms),
      method: record.request?.method || "",
      path: record.request?.path || "",
      model: String(requestBody.model || response.model || "Unknown"),
      status: Number(record.response?.status || 0),
      input,
      output,
      cached,
      fresh: Math.max(0, input - cached),
      categories: categoryRows(record, protocol, catalog, index, states[index], cacheLinks[index]),
      itemStates: states[index],
      context: {
        input: context.input,
        chainedFromTurn: context.chainedFrom === undefined ? undefined : String(turnRecords[context.chainedFrom].record.display_turn ?? context.chainedFrom + 1),
        chainedItems: context.chainedItems,
        chainBroken: context.chainBroken,
      },
      cacheChain: cacheLinks[index]?.fromIndex === undefined ? undefined : {
        fromTurn: String(turnRecords[cacheLinks[index]?.fromIndex as number].record.display_turn ?? (cacheLinks[index]?.fromIndex as number) + 1),
        carried: cacheLinks[index]?.carried || 0,
        added: cacheLinks[index]?.added || 0,
      },
      lane: laneFor(record),
      thread: threadOf(record, agent, allRecords, index),
      protocol: protocol.id,
      agent: agent.id,
      record,
    };
  });
}
