import { categoryColor, LAYER_COLORS } from "./category-palette";
import type { InputClass, InputLayer, ItemState, TokenCategory, TraceRecord, TurnModel } from "./types";

type AnyObject = Record<string, unknown>;

function asObject(value: unknown): AnyObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as AnyObject) : {};
}

function asNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  const block = asObject(value);
  if (typeof block.text === "string" && block.text.trim()) return block.text;
  if (typeof block.output === "string") return block.output;
  return "";
}

function responseBody(record: TraceRecord): AnyObject {
  const body = record.response?.body;
  if (body && typeof body === "object" && !Array.isArray(body)) return body as AnyObject;
  return {};
}

function usageFor(record: TraceRecord): AnyObject {
  const body = responseBody(record);
  const direct = asObject(body.usage);
  if (Object.keys(direct).length) return direct;
  const response = asObject(body.response);
  const nested = asObject(response.usage);
  if (Object.keys(nested).length) return nested;
  const metadata = asObject(asObject(record as unknown).usage);
  return metadata;
}

function isTurnRecord(record: TraceRecord): boolean {
  if (record.transport === "cursor-transcript") return true;
  const path = String(record.request?.path || "").split("?", 1)[0].toLowerCase();
  if (!path || path.includes("/count_tokens") || path.endsWith("/models")) return false;
  const responsesPath = path === "/responses" || path.endsWith("/v1/responses") || path.endsWith("/backend-api/codex/responses");

  // Mirrors Token Flow's backend display-turn contract: a Turn is one displayable
  // primary model request, not every captured HTTP record and not a Query.
  if (responsesPath) {
    const requestBody = record.request?.body ?? {};
    const body = responseBody(record);
    const payload = Object.keys(asObject(body.response)).length ? asObject(body.response) : body;
    const output = Array.isArray(payload.output) ? payload.output : [];
    const usage = asObject(payload.usage);
    const generateFalse = requestBody.generate === false || payload.generate === false;
    if (generateFalse && output.length === 0 && asNumber(usage.output_tokens) === 0) return false;
  }

  if (asObject(record as unknown).derived_from_websocket === true || responsesPath) return true;
  if (path.startsWith("/model/") && (path.endsWith("/invoke") || path.endsWith("/invoke-with-response-stream"))) return true;
  if (path.includes("generatecontent")) return true;
  return [
    "/v1/messages",
    "/zen/v1/messages",
    "/v1/chat/completions",
    "/chat/completions",
    "/v1/completions",
    "/completions",
    "/v1internal:generatecontent",
    "/v1internal:streamgeneratecontent",
    "/cursor/transcript/",
  ].some((prefix) => path.startsWith(prefix));
}

function stableTurnId(record: TraceRecord, index: number): string {
  if (record.request_id) return record.request_id;
  const captured = record.capture_turn ?? record.turn ?? index + 1;
  return ["turn", captured, record.timestamp || "", record.request?.path || ""].join(":");
}

function brief(value: string, limit = 26): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

const INJECTED_USER_PREFIXES = [
  "# AGENTS.md instructions",
  "<INSTRUCTIONS>",
  "<app-context",
  "<environment_context",
  "<permissions instructions",
  "<system-reminder",
  "<in-app-browser-context",
  "# Files mentioned by the user:",
  "<recommended_plugins",
];

const METADATA_PROMPTS: Array<[string, string]> = [
  ["generate a concise, single-line task title", "Generate task title"],
  ["you are a helpful assistant. you will be presented with a user prompt, and your job is to provide a short title", "Generate task title"],
  ["write a brief catch-up for a user returning", "Generate task catch-up"],
  ["the user stepped away and is coming back", "Resume conversation"],
];

/* Text parts of a user message that may be the typed prompt. When Codex App
   declares part kinds, only `user.text` parts qualify. */
function userPromptParts(item: AnyObject): string[] {
  const content = item.content ?? item.parts ?? item.text ?? item;
  const kinds = asObject(item.internal_chat_message_metadata_passthrough).content_item_kinds;
  if (Array.isArray(content) && Array.isArray(kinds) && kinds.length === content.length) {
    return textParts(content.filter((_, index) => kinds[index] === "user.text"));
  }
  return textParts(content);
}

function textParts(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(textParts);
  const item = asObject(value);
  if (!Object.keys(item).length) return [];
  const direct = item.text ?? item.output ?? item.input_text ?? item.output_text ?? item.prompt ?? item.query;
  if (direct !== undefined && direct !== value) return textParts(direct);
  if (item.content !== undefined && item.content !== value) return textParts(item.content);
  if (item.parts !== undefined && item.parts !== value) return textParts(item.parts);
  return [];
}

function attributedParts(item: AnyObject): unknown[] {
  const source = item.content ?? item.parts ?? item.output;
  if (Array.isArray(source)) return source;
  return source === undefined ? [] : [source];
}

function cleanPromptText(value: string): string {
  let text = value.trim();
  text = text.replace(/<in-app-browser-context[\s\S]*?<\/in-app-browser-context>/gi, "").trim();
  const explicitRequest = text.match(/##\s*My request:\s*([\s\S]*)$/i);
  if (explicitRequest?.[1]?.trim()) text = explicitRequest[1].trim();
  const codexRequest = text.match(/#+\s*My request for Codex:\s*([\s\S]*)$/i);
  if (codexRequest?.[1]?.trim()) text = codexRequest[1].trim();
  return text;
}

function turnIdentity(body: AnyObject): { title: string; kind: "user" | "metadata" | "tool" | "unknown" } {
  const source = body.input ?? body.messages ?? body.contents;
  const items = Array.isArray(source) ? source : source === undefined ? [] : [source];
  let hasToolOutput = false;

  for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
    const item = asObject(items[itemIndex]);
    const type = String(item.type || "").toLowerCase();
    if (type.endsWith("_call_output") || type === "tool_result" || type === "function_call_output") hasToolOutput = true;
    if (String(item.role || "").toLowerCase() !== "user") continue;

    const parts = userPromptParts(item);
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const original = parts[partIndex];
      const lowered = original.toLowerCase();
      const metadata = METADATA_PROMPTS.find(([prefix]) => lowered.startsWith(prefix));
      if (metadata) return { title: metadata[1], kind: "metadata" };
      const cleaned = cleanPromptText(original);
      if (!cleaned || INJECTED_USER_PREFIXES.some((prefix) => cleaned.startsWith(prefix))) continue;
      return { title: brief(cleaned, 64), kind: "user" };
    }
  }

  return hasToolOutput ? { title: "Tool result follow-up", kind: "tool" } : { title: "Model request", kind: "unknown" };
}

/* Keep the query boundary compatible with Token Flow's backend session grouping:
   Responses requests carry the same user message through every reasoning/tool
   step, so text alone cannot mean "new query". Its position among conversational
   messages is the stable boundary; a later user message gets a later index. */
function queryInputInfo(body: AnyObject): { text: string; userIndex: number; messageCount: number } {
  const rawMessages = Array.isArray(body.messages)
    ? body.messages
    : Array.isArray(body.input)
      ? body.input.filter((raw) => {
          const item = asObject(raw);
          return typeof item.role === "string" && (!item.type || item.type === "message");
        })
      : Array.isArray(body.contents)
        ? body.contents
        : [];

  for (let index = rawMessages.length - 1; index >= 0; index -= 1) {
    const message = asObject(rawMessages[index]);
    if (String(message.role || "").toLowerCase() !== "user") continue;
    const parts = userPromptParts(message);
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const original = parts[partIndex];
      const cleaned = cleanPromptText(original);
      if (!cleaned || INJECTED_USER_PREFIXES.some((prefix) => cleaned.startsWith(prefix))) continue;
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

/* Codex App labels each content part with `internal_chat_message_metadata_passthrough
   .content_item_kinds[partIndex]`. Prefer that captured evidence; text patterns
   below are only the fallback for clients that do not send it. Generic kinds are
   deliberately absent so their text can still be recognized. */
const CONTENT_KINDS: Record<string, InputClass> = {
  "model.base_instructions": { layer: "instructions", label: "Base instructions" },
  "memories.instructions": { layer: "instructions", label: "Memory" },
  "host_skills.instructions": { layer: "instructions", label: "Skills" },
  "permissions.instructions": { layer: "instructions", label: "Permissions" },
  "collaboration_mode.instructions": { layer: "instructions", label: "Collaboration mode" },
  "apps.instructions": { layer: "instructions", label: "Apps" },
  "plugins.usage_instructions": { layer: "instructions", label: "Plugins" },
  "multi_agent.usage_hint": { layer: "instructions", label: "Multi-agent mode" },
  "multi_agent.mode_instructions": { layer: "instructions", label: "Multi-agent mode" },
  "agents_md.instructions": { layer: "context", label: "AGENTS.md" },
  "environments.environment_context": { layer: "context", label: "Environment" },
  "plugins.recommendations": { layer: "context", label: "Recommended plugins" },
  "user.text": { layer: "conversation", label: "User prompt" },
};

const TEXT_PATTERNS: Array<[RegExp, InputClass]> = [
  [/^You are Codex, an agent/i, CONTENT_KINDS["model.base_instructions"]],
  [/^You are `?\/root`?, the primary agent/i, { layer: "instructions", label: "Agent role" }],
  [/^(?:##\s*)?Memory\b|^<Memory>/i, CONTENT_KINDS["memories.instructions"]],
  [/^<skills_instructions>/i, CONTENT_KINDS["host_skills.instructions"]],
  [/^<permissions instructions>/i, CONTENT_KINDS["permissions.instructions"]],
  [/^<collaboration_mode>/i, CONTENT_KINDS["collaboration_mode.instructions"]],
  [/^<apps_instructions>/i, CONTENT_KINDS["apps.instructions"]],
  [/^<plugins_instructions>/i, CONTENT_KINDS["plugins.usage_instructions"]],
  [/^<multi_agent_mode>/i, CONTENT_KINDS["multi_agent.mode_instructions"]],
  [/^# AGENTS\.md instructions|^<INSTRUCTIONS>/i, CONTENT_KINDS["agents_md.instructions"]],
  [/^<environment_context>/i, CONTENT_KINDS["environments.environment_context"]],
  [/^<recommended_plugins>/i, CONTENT_KINDS["plugins.recommendations"]],
  [/^<app-context>/i, { layer: "context", label: "App context" }],
  [/^<in-app-browser-context/i, { layer: "context", label: "Browser context" }],
  [/^<system-reminder/i, { layer: "context", label: "System reminder" }],
  [/^# Files mentioned by the user:/i, { layer: "context", label: "Mentioned files" }],
];

function contentItemKind(item: AnyObject | undefined, partIndex: number | undefined): string {
  if (!item || partIndex === undefined) return "";
  const kinds = asObject(item.internal_chat_message_metadata_passthrough).content_item_kinds;
  return Array.isArray(kinds) && typeof kinds[partIndex] === "string" ? kinds[partIndex] : "";
}

function classify(item: AnyObject | undefined, text: string, partIndex?: number): InputClass {
  const value = text.trim();
  const type = String(item?.type || "").toLowerCase();
  if (type === "additional_tools") return { layer: "capabilities", label: "Tool definitions" };
  if (type === "reasoning" || type === "thinking") return { layer: "conversation", label: "Reasoning" };
  if (type.endsWith("_call_output") || type === "tool_result" || type === "tool_output") return { layer: "conversation", label: "Tool results" };
  if (type.endsWith("_call") || type === "tool_use") return { layer: "conversation", label: "Tool calls" };
  const declared = CONTENT_KINDS[contentItemKind(item, partIndex)];
  if (declared) return declared;
  const matched = TEXT_PATTERNS.find(([pattern]) => pattern.test(value));
  if (matched) return matched[1];
  if (item?.role === "assistant") return { layer: "conversation", label: "Assistant messages" };
  if (item?.role === "developer" || item?.role === "system") return { layer: "instructions", label: "Developer instructions" };
  if (item?.role === "user") return { layer: "conversation", label: "User prompt" };
  return UNATTRIBUTED;
}

export function classifyInput(rawItem: unknown, rawPart?: unknown, partIndex?: number): InputClass {
  const item = asObject(rawItem);
  const value = rawPart === undefined ? textParts(item.content ?? item.parts ?? item.text ?? item)[0] || "" : textOf(rawPart);
  return classify(item, value, rawPart === undefined ? 0 : partIndex);
}

type CatalogEntry = { item: AnyObject; classes: InputClass[]; itemClass: InputClass };

function buildCatalog(records: TraceRecord[]): Map<string, CatalogEntry> {
  const catalog = new Map<string, CatalogEntry>();
  for (const record of records) {
    const input = record.request?.body?.input;
    if (!Array.isArray(input)) continue;
    for (const rawItem of input) {
      const item = asObject(rawItem);
      if (typeof item.id !== "string" || !item.id) continue;
      const content = attributedParts(item);
      const classes = content.map((part, partIndex) => classify(item, textOf(part), partIndex));
      catalog.set(item.id, { item, classes, itemClass: classify(item, "", 0) });
    }
  }
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
function itemStatesByTurn(records: TraceRecord[]): Array<Record<string, ItemState>> {
  const seen = new Map<string, string>();
  return records.map((record) => {
    const input = record.request?.body?.input;
    const states: Record<string, ItemState> = {};
    const current: Array<[string, string]> = [];
    for (const rawItem of Array.isArray(input) ? input : []) {
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

function categoryRows(record: TraceRecord, catalog: Map<string, CatalogEntry>, index: number, states: Record<string, ItemState>): TokenCategory[] {
  const usage = usageFor(record);
  const attribution = asObject(usage.attribution);
  const attributionItems = asObject(attribution.items);
  const categories: Omit<TokenCategory, "color" | "fresh">[] = [];
  let attributed = 0;

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

  const input = asNumber(usage.input_tokens ?? usage.prompt_tokens);
  const details = asObject(usage.input_tokens_details);
  const cacheRead = asNumber(usage.cache_read_input_tokens ?? details.cached_tokens);
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
function stepSummary(body: AnyObject, states: Record<string, ItemState>): string {
  const input = Array.isArray(body.input) ? body.input.map(asObject) : [];
  const fresh = input.filter((item) => typeof item.id === "string" && states[item.id] === "new");
  const freshCalls = new Set(fresh.map((item) => String(item.call_id || "")).filter(Boolean));
  const counts = new Map<string, number>();
  const add = (name: string) => counts.set(name, (counts.get(name) || 0) + 1);
  for (const item of fresh) {
    const type = String(item.type || "").toLowerCase();
    if (item.role === "user") {
      const prompt = userPromptParts(item).map(cleanPromptText).find((text) => text && !INJECTED_USER_PREFIXES.some((prefix) => text.startsWith(prefix)));
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

export function buildTurns(records: TraceRecord[]): TurnModel[] {
  const turnRecords = records.filter(isTurnRecord).sort((left, right) => {
    const leftTurn = Number(left.turn);
    const rightTurn = Number(right.turn);
    if (Number.isFinite(leftTurn) && Number.isFinite(rightTurn) && leftTurn !== rightTurn) return leftTurn - rightTurn;
    return String(left.timestamp || "").localeCompare(String(right.timestamp || ""));
  });
  const catalog = buildCatalog(turnRecords);
  const states = itemStatesByTurn(turnRecords);
  return turnRecords.map((record, index) => {
    const usage = usageFor(record);
    const input = asNumber(usage.input_tokens ?? usage.prompt_tokens);
    const output = asNumber(usage.output_tokens ?? usage.completion_tokens);
    const details = asObject(usage.input_tokens_details);
    const cached = Math.min(input, asNumber(usage.cache_read_input_tokens ?? details.cached_tokens));
    const body = record.request?.body ?? {};
    const response = responseBody(record);
    const identity = turnIdentity(body);
    const query = queryInputInfo(body);
    return {
      id: stableTurnId(record, index),
      index,
      label: String(record.display_turn ?? index + 1),
      captureTurn: record.capture_turn ?? record.turn,
      title: identity.title,
      step: identity.kind === "metadata" ? identity.title : stepSummary(body, states[index]) || identity.title,
      kind: identity.kind,
      queryText: query.text,
      queryUserIndex: query.userIndex,
      queryMessageCount: query.messageCount,
      timestamp: record.timestamp,
      durationMs: asNumber(record.duration_ms),
      method: record.request?.method || "",
      path: record.request?.path || "",
      model: String(body.model || response.model || "Unknown"),
      status: Number(record.response?.status || 0),
      input,
      output,
      cached,
      fresh: Math.max(0, input - cached),
      categories: categoryRows(record, catalog, index, states[index]),
      itemStates: states[index],
      lane: laneFor(record),
      record,
    };
  });
}
