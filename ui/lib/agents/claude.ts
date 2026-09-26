import { asObject, type AnyObject } from "../json";
import { inputClass } from "../input-categories";
import { anthropicMessages } from "../protocols/anthropic-messages";
import type { TraceRecord } from "../types";
import type { AgentPlugin } from "./types";

/* Claude Code assembles its prompt from:

   - system blocks: a billing header, the identity line, and one main prompt of
     top-level `# ` sections (Harness, Memory, Environment, …);
   - a system-role message inside the conversation holding the environment, the
     sub-agent catalog, MCP server instructions, and mode notes, restated after
     every compaction together with files it re-read;
   - `<system-reminder>` blocks in the first user message: CLAUDE.md files, the
     user's context (email, git status), and attribution guidance.

   Besides the agent loop it sends a session-title request, a request per
   WebSearch call, and compaction requests that ask the model to summarize the
   conversation, which then continues from the summary. (Its one-token quota
   check never reaches the turn list: the backend drops one-token probes.) */

/* Lines that open a section of Claude Code's system text. */
const SECTION_START = /^(?:# \S|Available agent types for the Agent tool|While [\w -]+ mode is active:|Called the \w+ tool with the following input|Today's date is)/;

/* Split a system text at its section openers, outside fenced code blocks. Text
   with a single section stays whole. */
function splitSections(text: string): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (!fenced && SECTION_START.test(line) && current.some((value) => value.trim())) {
      sections.push(current.join("\n").trim());
      current = [];
    }
    current.push(line);
  }
  if (current.some((value) => value.trim())) sections.push(current.join("\n").trim());
  return sections.length > 1 ? sections : [text];
}

function systemTexts(record: TraceRecord): string[] {
  const system = asObject(record.request?.body).system;
  if (typeof system === "string") return [system];
  return Array.isArray(system) ? system.map((block) => String(asObject(block).text || "")) : [];
}

function firstUserText(record: TraceRecord): string {
  const messages = asObject(record.request?.body).messages;
  const content = Array.isArray(messages) ? asObject(messages[0]).content : undefined;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? String(asObject(content[0]).text || "") : "";
}

function sessionId(record: TraceRecord): string | undefined {
  const headers = asObject(record.request?.headers);
  const header = Object.entries(headers).find(([name]) => name.toLowerCase() === "x-claude-code-session-id")?.[1];
  return typeof header === "string" && header ? header : undefined;
}

const WEB_SEARCH = /^Perform a web search for the query: ([\s\S]+)$/;

function isWebSearch(record: TraceRecord): boolean {
  return systemTexts(record).some((text) => text.startsWith("You are an assistant for performing a web search"));
}

/* The WebSearch call in an agent response that asked for this query. */
function webSearchCall(record: TraceRecord, query: string): AnyObject | undefined {
  for (const message of anthropicMessages.output?.(record) || []) {
    for (const raw of asObject(message).content as unknown[] || []) {
      const block = asObject(raw);
      if (block.type === "tool_use" && block.name === "WebSearch" && String(asObject(block.input).query || "").trim() === query) return block;
    }
  }
  return undefined;
}

/* The reminder rule every harness convention shares; agents without a plugin use it. */
export const REMINDER_PATTERN: [RegExp, ReturnType<typeof inputClass>] = [/^<system-reminder/i, inputClass("runtime", "System reminder")];

export const claude: AgentPlugin = {
  id: "claude",
  clients: ["claude"],
  textPatterns: [
    [/^x-anthropic-billing-header:/, inputClass("harness", "Billing header")],
    [/^You are Claude Code\b/, inputClass("harness", "Base instructions")],
    [/^You are an interactive agent/, inputClass("harness", "Base instructions")],
    [/^# Environment\b|^Today's date is/, inputClass("runtime", "Environment")],
    [/^# (?:auto )?Memory\b/i, inputClass("project", "Memory")],
    [/^# MCP Server Instructions|^# Claude in Chrome/, inputClass("tools", "MCP servers")],
    [/^Available agent types for the Agent tool/, inputClass("tools", "Sub-agents")],
    [/^While [\w -]+ mode is active:/, inputClass("harness", "Permissions")],
    [/^Called the \w+ tool with the following input/, inputClass("results", "Restored files")],
    [/^<system-reminder>\s*(?:Codebase and user instructions|[\s\S]*?\n# claudeMd\n)/, inputClass("project", "CLAUDE.md")],
    [/^<system-reminder>\s*As you answer the user's questions, you can use the following context/, inputClass("runtime", "Environment")],
    [/^<system-reminder>\s*The following skills are available/, inputClass("tools", "Skills")],
    [/^<system-reminder>\s*The following deferred tools/, inputClass("tools", "Tool definitions")],
    [/^<system-reminder>\s*Attribution for git commits/, inputClass("harness", "Attribution")],
    REMINDER_PATTERN,
    [/^This session is being continued from a previous conversation/, inputClass("model", "Compaction summary")],
    [/^CRITICAL: Respond with TEXT ONLY/, inputClass("harness", "Compaction prompt")],
    [/^# \S/, inputClass("harness", "Guidelines")],
  ],
  injectedUserPrefixes: ["<system-reminder", "This session is being continued from a previous conversation", "CRITICAL: Respond with TEXT ONLY"],
  compactionPrompts: ["critical: respond with text only"],
  splitSystemText: splitSections,
  metadataRequest: (record) => (systemTexts(record).some((text) => text.startsWith("You are naming a coding session")) ? "Generate session title" : undefined),
  // Requests name their session. A WebSearch request is a branch of the agent
  // request whose WebSearch call carried its exact query.
  thread(record, { index, records }) {
    const session = sessionId(record);
    if (!isWebSearch(record)) return session ? { id: session } : undefined;
    const query = WEB_SEARCH.exec(firstUserText(record).trim())?.[1]?.trim() || "";
    for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
      const call = query && !isWebSearch(records[earlier]) ? webSearchCall(records[earlier], query) : undefined;
      if (call) return { id: `web_search:${String(call.id || index)}`, label: "Web search", name: query, parentId: sessionId(records[earlier]) };
    }
    return { id: `web_search:${index}`, label: "Web search", name: query || undefined, parentId: session };
  },
};
