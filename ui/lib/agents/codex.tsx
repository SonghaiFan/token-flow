import { environmentChanges, environmentPreview, EnvironmentView, previewText, ReadableText, type EnvironmentFacts } from "@/components/workspace/section-views";
import { asObject } from "../json";
import { codexResultParts } from "./codex-results";
import type { InputClass } from "../types";

/* Codex names sub-agents in `x-openai-subagent`; these are the kinds seen so far. */
const SUBAGENT_LABELS: Record<string, string> = {
  collab_spawn: "Sub-agent",
  guardian: "Guardian review",
  memory_consolidation: "Memory consolidation",
};

/* Work Codex does on its own beside a conversation. Memory writing summarizes
   earlier rollouts (phase 1, one request per rollout, sent under the
   conversation's own thread id) and consolidates them (phase 2, a sub-agent);
   Skysight writes memories from recorded activity. Their prompts are written by
   the harness even where they arrive as user messages. */
const BACKGROUND_TASKS: Array<[RegExp, string]> = [
  [/^## Memory Writing Agent: Phase 1\b/, "Rollout summary"],
  [/^## Memory Writing Agent: Phase 2\b/, "Memory consolidation"],
  [/^You are a memory writer for Codex Skysight\b/, "Skysight memory"],
];
const BACKGROUND_PROMPT = /^(?:## Memory Writing Agent\b|You are a memory writer for Codex\b|Analyze this rollout and produce JSON\b)/;

function leadingTexts(body: Record<string, unknown>): string[] {
  const input = Array.isArray(body.input) ? body.input : [];
  return input.slice(0, 12).flatMap((raw) => {
    const content = asObject(raw).content;
    return Array.isArray(content) ? content.map((part) => String(asObject(part).text || "").trim()) : [];
  });
}
import type { AgentPlugin } from "./types";
import { inputClass } from "../input-categories";

/* Codex App labels each content part with `internal_chat_message_metadata_passthrough
   .content_item_kinds[partIndex]`. Prefer that captured evidence; text patterns
   below are only the fallback for requests that do not send it. Generic kinds are
   deliberately absent so their text can still be recognized. */
const CONTENT_KINDS: Record<string, InputClass> = {
  "model.base_instructions": inputClass("harness", "Base instructions"),
  "memories.instructions": inputClass("project", "Memory"),
  "host_skills.instructions": inputClass("tools", "Skills"),
  "permissions.instructions": inputClass("harness", "Permissions"),
  "collaboration_mode.instructions": inputClass("harness", "Collaboration mode"),
  "apps.instructions": inputClass("tools", "Apps"),
  "plugins.usage_instructions": inputClass("tools", "Plugins"),
  "multi_agent.usage_hint": inputClass("harness", "Multi-agent mode"),
  "multi_agent.mode_instructions": inputClass("harness", "Multi-agent mode"),
  "agents_md.instructions": inputClass("project", "AGENTS.md"),
  "environments.environment_context": inputClass("runtime", "Environment"),
  "plugins.recommendations": inputClass("tools", "Recommended plugins"),
  "user.text": inputClass("user", "User prompt"),
};

function codexContentKind(item: Record<string, unknown>, partIndex: number | undefined): string {
  if (partIndex === undefined) return "";
  const kinds = asObject(item.internal_chat_message_metadata_passthrough).content_item_kinds;
  const kind = Array.isArray(kinds) && typeof kinds[partIndex] === "string" ? kinds[partIndex] : "";
  // A background task's prompt is declared as user text; it is the harness's.
  if (kind === "user.text" && Array.isArray(item.content) && BACKGROUND_PROMPT.test(String(asObject(item.content[partIndex]).text || "").trim())) return "";
  return kind;
}

function parseEnvironment(value: string): EnvironmentFacts | null {
  const body = /<environment_context>([\s\S]*?)<\/environment_context>/i.exec(value)?.[1];
  if (body === undefined) return null;
  const fileSystem = /<filesystem>([\s\S]*?)<\/filesystem>/i.exec(body)?.[1] || "";
  const scalars = body.replace(/<filesystem>[\s\S]*?<\/filesystem>/i, "");
  return {
    entries: [...fileSystem.matchAll(/<entry\b([^>]*)>([\s\S]*?)<\/entry>/gi)].map((match) => {
      const path = /<path>([\s\S]*?)<\/path>/i.exec(match[2])?.[1];
      const special = /<special>([\s\S]*?)<\/special>/i.exec(match[2])?.[1];
      return {
        access: /\baccess="([^"]*)"/.exec(match[1])?.[1] || "Unknown",
        escalatable: /\bescalatable="([^"]*)"/.exec(match[1])?.[1] || "",
        special: path === undefined && special !== undefined,
        target: (path ?? special ?? match[2]).trim(),
      };
    }),
    fields: [...scalars.matchAll(/<([A-Za-z_][\w-]*)>([\s\S]*?)<\/\1>/g)].map((match) => [match[1], match[2].trim()]),
    fileSystem: /<file_system\b[^>]*\btype="([^"]*)"/i.exec(fileSystem)?.[1] || "",
    profile: /<permission_profile\b[^>]*\btype="([^"]*)"/i.exec(fileSystem)?.[1] || "",
    roots: [...fileSystem.matchAll(/<root>([\s\S]*?)<\/root>/gi)].map((match) => match[1].trim()),
  };
}

function parseAgentsMd(value: string): { body: string; path: string } | null {
  const heading = /^# AGENTS\.md instructions(?: for ([^\n]+))?\s*\n/i.exec(value);
  const wrapped = /<INSTRUCTIONS>([\s\S]*?)(?:<\/INSTRUCTIONS>|$)/i.exec(value)?.[1];
  if (!heading && wrapped === undefined) return null;
  return { body: (wrapped ?? value.slice(heading?.[0].length || 0)).trim(), path: heading?.[1]?.trim() || "" };
}

export const codex: AgentPlugin = {
  id: "codex",
  clients: ["codex", "codexapp"],
  declaredKind: codexContentKind,
  // Every request names its thread; a sub-agent's requests also name the thread
  // that spawned it and the kind of sub-agent.
  thread(record) {
    const body = asObject(record.request?.body);
    const metadata = asObject(body.client_metadata);
    const text = (key: string) => (typeof metadata[key] === "string" && metadata[key] ? (metadata[key] as string) : undefined);
    const role = text("x-openai-subagent");
    // A spawned agent carries its task path (`/root/release_docs`) as agent_name in
    // the turn metadata; the root agent and guardian reviews are just `/root`.
    let name: string | undefined;
    try {
      const turn = asObject(JSON.parse(text("x-codex-turn-metadata") || "{}"));
      if (typeof turn.agent_name === "string" && turn.agent_name.includes("/", 1)) name = turn.agent_name;
    } catch {
      name = undefined;
    }
    const texts = leadingTexts(body);
    const task = BACKGROUND_TASKS.find(([pattern]) => texts.some((value) => pattern.test(value)))?.[1];
    // Each rollout summary is its own request, though it names the conversation's thread.
    if (task === "Rollout summary") return { id: `rollout:${text("turn_id") || text("thread_id") || ""}`, label: task, background: true };
    if (task || role === "memory_consolidation") return { id: text("thread_id"), label: task || SUBAGENT_LABELS.memory_consolidation, background: true };
    return {
      id: text("thread_id"),
      parentId: text("x-codex-parent-thread-id"),
      label: role ? SUBAGENT_LABELS[role] || role.replaceAll("_", " ") : undefined,
      name,
    };
  },
  resultParts: codexResultParts,
  contentKinds: CONTENT_KINDS,
  textPatterns: [
    [/^You are Codex, an agent/i, CONTENT_KINDS["model.base_instructions"]],
    [/^You are `?\/root`?, the primary agent/i, inputClass("harness", "Agent role")],
    [/^## Memory Writing Agent\b|^You are a memory writer for Codex\b/i, CONTENT_KINDS["model.base_instructions"]],
    [/^Analyze this rollout and produce JSON\b/i, inputClass("harness", "Background task")],
    [/^(?:##\s*)?Memory\s*(?:\n|$)|^<Memory>/i, CONTENT_KINDS["memories.instructions"]],
    [/^<skills_instructions>/i, CONTENT_KINDS["host_skills.instructions"]],
    [/^<permissions instructions>/i, CONTENT_KINDS["permissions.instructions"]],
    [/^<collaboration_mode>/i, CONTENT_KINDS["collaboration_mode.instructions"]],
    [/^<apps_instructions>/i, CONTENT_KINDS["apps.instructions"]],
    [/^<plugins_instructions>/i, CONTENT_KINDS["plugins.usage_instructions"]],
    [/^<multi_agent_mode>/i, CONTENT_KINDS["multi_agent.mode_instructions"]],
    [/^# AGENTS\.md instructions|^<INSTRUCTIONS>/i, CONTENT_KINDS["agents_md.instructions"]],
    [/^<environment_context>/i, CONTENT_KINDS["environments.environment_context"]],
    [/^<recommended_plugins>/i, CONTENT_KINDS["plugins.recommendations"]],
    [/^<app-context>/i, inputClass("runtime", "App context")],
    [/^<in-app-browser-context/i, inputClass("runtime", "Browser context")],
    [/^# Files mentioned by the user:/i, inputClass("user", "Mentioned files")],
  ],
  injectedUserPrefixes: [
    "# AGENTS.md instructions",
    "<INSTRUCTIONS>",
    "<app-context",
    "<environment_context",
    "<permissions instructions",
    "<in-app-browser-context",
    "# Files mentioned by the user:",
    "<recommended_plugins",
    "## Memory Writing Agent",
    "You are a memory writer for Codex",
    "Analyze this rollout and produce JSON",
  ],
  metadataPrompts: [
    ["generate a concise, single-line task title", "Generate task title"],
    ["you are a helpful assistant. you will be presented with a user prompt, and your job is to provide a short title", "Generate task title"],
    ["write a brief catch-up for a user returning", "Generate task catch-up"],
    ["the user stepped away and is coming back", "Resume conversation"],
  ],
  cleanPrompt(value) {
    let text = value.replace(/<in-app-browser-context[\s\S]*?<\/in-app-browser-context>/gi, "").trim();
    const explicitRequest = text.match(/##\s*My request:\s*([\s\S]*)$/i);
    if (explicitRequest?.[1]?.trim()) text = explicitRequest[1].trim();
    const codexRequest = text.match(/#+\s*My request for Codex:\s*([\s\S]*)$/i);
    if (codexRequest?.[1]?.trim()) text = codexRequest[1].trim();
    return text;
  },
  sections: {
    Environment: {
      preview: (text) => {
        const facts = parseEnvironment(text);
        return facts ? environmentPreview(facts) : undefined;
      },
      changes: (text, previous) => {
        const facts = parseEnvironment(text);
        return facts && previous ? environmentChanges(facts, parseEnvironment(previous)) : [];
      },
      render: (text, previous) => {
        const facts = parseEnvironment(text);
        return facts ? <EnvironmentView earlier={previous ? parseEnvironment(previous) : null} facts={facts}/> : undefined;
      },
    },
    "AGENTS.md": {
      preview: (text) => {
        const parsed = parseAgentsMd(text);
        return parsed ? parsed.path || previewText(parsed.body.replace(/<!--[\s\S]*?-->/g, "")) : undefined;
      },
      render: (text) => {
        const parsed = parseAgentsMd(text);
        return parsed ? <ReadableText value={parsed.body}/> : undefined;
      },
    },
  },
};
