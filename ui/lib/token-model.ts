import type { TokenCategory, TraceRecord, TurnModel } from "./types";

const CATEGORY_COLORS = ["#4f7cff", "#8b5cf6", "#0ea5a4", "#f59e0b", "#ef6c8f", "#64748b", "#22a06b", "#b45309"];

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

function categoryColor(label: string): string {
  let hash = 0;
  for (let index = 0; index < label.length; index += 1) hash = ((hash << 5) - hash + label.charCodeAt(index)) | 0;
  return CATEGORY_COLORS[Math.abs(hash) % CATEGORY_COLORS.length];
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
];

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

    const parts = textParts(item.content ?? item.parts ?? item.text ?? item);
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const original = parts[partIndex];
      const lowered = original.toLowerCase();
      if (lowered.startsWith("generate a concise, single-line task title")) return { title: "Generate task title", kind: "metadata" };
      if (lowered.startsWith("write a brief catch-up for a user returning")) return { title: "Generate task catch-up", kind: "metadata" };
      if (lowered.startsWith("the user stepped away and is coming back")) return { title: "Resume conversation", kind: "metadata" };
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
    const parts = textParts(message.content ?? message.parts ?? message.text ?? message);
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const original = parts[partIndex];
      const cleaned = cleanPromptText(original);
      if (!cleaned || INJECTED_USER_PREFIXES.some((prefix) => cleaned.startsWith(prefix))) continue;
      return { text: brief(cleaned, 64), userIndex: index, messageCount: rawMessages.length };
    }
  }
  return { text: "", userIndex: -1, messageCount: rawMessages.length };
}

function categoryLabel(item: AnyObject | undefined, text: string): string {
  const value = text.trim();
  const type = String(item?.type || "").toLowerCase();
  if (item?.type === "additional_tools") return "Tool definitions";
  if (type === "reasoning" || type === "thinking") return "Reasoning history";
  if (type.endsWith("_call_output") || type === "tool_result" || type === "tool_output") return "Tool results";
  if (type.endsWith("_call") || type === "tool_use") return "Tool calls";
  if (/^<app-context>/i.test(value)) return "<app-context>";
  if (/^(?:##\s*)?Memory\b|^<Memory>/i.test(value)) return "<Memory>";
  const tagged = value.match(/^<(skills_instructions|permissions instructions|collaboration_mode|multi_agent_mode|apps_instructions|plugins_instructions)>/i);
  if (tagged) return `<${tagged[1]}>`;
  if (/^<recommended_plugins>/i.test(value)) return "Plugin list";
  if (/^# AGENTS\.md instructions/i.test(value)) return "AGENTS.md instructions";
  if (/^<environment_context>/i.test(value)) return "Environment";
  if (/^You are Codex, an agent/i.test(value)) return "Codex base instructions";
  if (/^You are `?\/root`?, the primary agent/i.test(value)) return "Agent role";
  if (item?.role === "assistant") return "Assistant history";
  if (item?.role === "developer" || item?.role === "system") return "Developer instructions";
  if (item?.role === "user") return value ? `User · ${brief(value)}` : "User input";
  return "Unattributed input";
}

export function categoryLabelForInput(rawItem: unknown, rawPart?: unknown): string {
  const item = asObject(rawItem);
  const value = rawPart === undefined ? textParts(item.content ?? item.parts ?? item.text ?? item)[0] || "" : textOf(rawPart);
  return categoryLabel(item, value);
}

function buildCatalog(records: TraceRecord[]): Map<string, { item: AnyObject; labels: string[]; label: string }> {
  const catalog = new Map<string, { item: AnyObject; labels: string[]; label: string }>();
  for (const record of records) {
    const input = record.request?.body?.input;
    if (!Array.isArray(input)) continue;
    for (const rawItem of input) {
      const item = asObject(rawItem);
      if (typeof item.id !== "string" || !item.id) continue;
      const content = attributedParts(item);
      const labels = content.map((part) => categoryLabel(item, textOf(part)));
      catalog.set(item.id, { item, labels, label: categoryLabel(item, "") });
    }
  }
  return catalog;
}

function categoryRows(record: TraceRecord, catalog: ReturnType<typeof buildCatalog>, index: number): TokenCategory[] {
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
        categories.push({ id: `${itemId}:${partIndex}`, label: known?.labels[partIndex] || known?.label || "Unattributed input", tokens, cached });
        attributed += tokens;
      });
    } else {
      const tokens = asNumber(stats.input_tokens);
      if (!tokens) continue;
      const cached = Math.min(tokens, asNumber(stats.cached_tokens));
      categories.push({ id: itemId, label: known?.label || "Unattributed input", tokens, cached });
      attributed += tokens;
    }
  }

  const input = asNumber(usage.input_tokens ?? usage.prompt_tokens);
  const details = asObject(usage.input_tokens_details);
  const cacheRead = asNumber(usage.cache_read_input_tokens ?? details.cached_tokens);
  if (!categories.length && input) {
    categories.push({ id: `unattributed:${index}`, label: "Unattributed input", tokens: input, cached: Math.min(input, cacheRead) });
  } else if (input > attributed) {
    categories.push({ id: `unattributed:${index}`, label: "Unattributed input", tokens: input - attributed, cached: Math.max(0, Math.min(input - attributed, cacheRead - categories.reduce((sum, item) => sum + item.cached, 0))) });
  }

  return categories.map((category) => ({
    ...category,
    fresh: Math.max(0, category.tokens - category.cached),
    color: categoryColor(category.label),
  }));
}

export function buildTurns(records: TraceRecord[]): TurnModel[] {
  const turnRecords = records.filter(isTurnRecord).sort((left, right) => {
    const leftTurn = Number(left.turn);
    const rightTurn = Number(right.turn);
    if (Number.isFinite(leftTurn) && Number.isFinite(rightTurn) && leftTurn !== rightTurn) return leftTurn - rightTurn;
    return String(left.timestamp || "").localeCompare(String(right.timestamp || ""));
  });
  const catalog = buildCatalog(turnRecords);
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
      categories: categoryRows(record, catalog, index),
      record,
    };
  });
}
