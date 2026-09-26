import { ReadableText } from "@/components/workspace/section-views";
import { asObject, type AnyObject } from "../json";
import { gemini } from "../protocols/gemini";
import { partText, type ResultPart } from "../tool-results";
import type { InputClass, TraceRecord } from "../types";
import { SkillList, skillCount, splitTaggedSections, type SkillEntry } from "./prompt-sections";
import type { AgentPlugin } from "./types";
import { inputClass } from "../input-categories";

/* Antigravity talks to Code Assist (`v1internal:*generateContent`), which wraps a
   Gemini request with `requestType` and `requestId`:

   - `agent`: the agent loop. `requestId` is `agent/<conversation>/<time>/<step>`.
   - `checkpoint`: conversation title generation.
   - `web_search`: the model call the `search_web` tool makes, whose one user
     message is the query the agent passed to that call.

   The system instruction is one text of top-level pseudo-XML sections. A user
   turn wraps the typed request in `<USER_REQUEST>` and appends harness context
   (`<ADDITIONAL_METADATA>`, `<USER_SETTINGS_CHANGE>`) in the same text part. */

const SECTION_CLASSES: Array<[string, InputClass]> = [
  ["identity", inputClass("harness", "Base instructions")],
  ["user_information", inputClass("runtime", "Environment")],
  ["mcp_servers", inputClass("tools", "MCP servers")],
  ["user_rules", inputClass("project", "AGENTS.md")],
  ["skills", inputClass("tools", "Skills")],
  ["subagents", inputClass("tools", "Sub-agents")],
  ["messaging", inputClass("harness", "Messaging")],
  ["conversation_transcript", inputClass("harness", "Transcripts")],
  ["artifacts", inputClass("harness", "Artifacts")],
  ["slash_commands", inputClass("tools", "Slash commands")],
  ["guidelines", inputClass("harness", "Guidelines")],
  ["communication_style", inputClass("harness", "Communication style")],
];

interface CodeAssistRequest {
  id: string;
  request: AnyObject;
  type: string;
}

function codeAssist(record: TraceRecord): CodeAssistRequest {
  const body = asObject(record.request?.body);
  return { id: String(body.requestId || ""), request: asObject(body.request), type: String(body.requestType || "") };
}

/* The conversation an agent request belongs to. */
function conversationId(record: TraceRecord): string | undefined {
  const { id, request, type } = codeAssist(record);
  if (type !== "agent") return undefined;
  const conversation = id.split("/")[1];
  return conversation || String(asObject(request.labels).trajectory_id || "") || undefined;
}

function firstText(request: AnyObject): string {
  const contents = Array.isArray(request.contents) ? request.contents : [];
  const parts = asObject(contents[0]).parts;
  const text = Array.isArray(parts) ? asObject(parts[0]).text : undefined;
  return typeof text === "string" ? text.trim() : "";
}

/* The `search_web` call in an agent response that asked for this query. */
function searchCall(record: TraceRecord, query: string): AnyObject | undefined {
  for (const content of gemini.output?.(record) || []) {
    for (const raw of asObject(content).parts as unknown[] || []) {
      const call = asObject(asObject(raw).functionCall);
      if (call.name === "search_web" && String(asObject(call.args).query || "").trim() === query) return call;
    }
  }
  return undefined;
}

/* `<USER_REQUEST>` holds what the user typed; the rest of the part is context. */
function userRequest(text: string): string | undefined {
  return /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(text)?.[1];
}

function injectedContext(text: string): Array<[string, string]> {
  return [...text.matchAll(/<([A-Z][A-Z_]+)>\s*([\s\S]*?)\s*<\/\1>/g)]
    .filter((match) => match[1] !== "USER_REQUEST")
    .map((match) => [match[1].toLowerCase().replaceAll("_", " "), match[2]]);
}

/* Skills are listed as `- name (path): description` lines. */
function parseSkills(text: string): SkillEntry[] | null {
  if (!/^\s*<skills>/.test(text)) return null;
  const skills = [...text.matchAll(/^- ([^\s(]+) \(([^)\n]+)\): ?(.*)$/gm)].map((match) => ({ description: match[3].trim(), location: match[2], name: match[1] }));
  return skills.length ? skills : null;
}

/* `<user_rules>` holds one `<RULE[path]>` per rules file. */
function parseRules(text: string): { body: string; path: string } | null {
  if (!/^\s*<user_rules>/.test(text)) return null;
  const rules = [...text.matchAll(/<RULE\[([^\]]+)\]>\s*([\s\S]*?)\s*<\/RULE\[\1\]>/g)];
  if (!rules.length) return null;
  return { body: rules.map((match) => match[2]).join("\n\n---\n\n"), path: rules.map((match) => match[1]).join(", ") };
}

/* Tool results open with `Created At:` and `Completed At:` lines, and a failed
   run says so on the next line. The times become a wall-time fact when the run
   took long enough to notice; the error becomes the part's failure. */
function toolResultParts(parts: Array<{ part: unknown; partIndex: number }>): ResultPart[] | undefined {
  const texts = parts.map(({ part }) => partText(part) ?? "");
  if (!texts.some((text) => /^Created At: /m.test(text))) return undefined;
  return parts.map(({ partIndex }, index) => {
    let text = texts[index];
    const created = Date.parse(/^Created At: (.+)$/m.exec(text)?.[1] || "");
    const completed = Date.parse(/^Completed At: (.+)$/m.exec(text)?.[1] || "");
    text = text.replace(/^(?:Created|Completed) At: .*(?:\n|$)/gm, "");
    const error = /^Encountered error in tool execution:\s*/m.exec(text);
    if (error) text = text.slice(error.index + error[0].length);
    const seconds = (completed - created) / 1000;
    return { body: { kind: "text", text }, facts: seconds >= 1 ? [`${Math.round(seconds)} s`] : [], failure: error ? "error" : undefined, partIndex };
  });
}

function UserRequest({ text }: { text: string }) {
  const typed = userRequest(text);
  const context = injectedContext(text);
  return <div className="space-y-3">
    <ReadableText value={typed ?? text}/>
    {typed !== undefined && context.length ? <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 border-t border-line pt-3 text-xs">
      {context.map(([label, value], index) => <div className="contents" key={index}><dt className="capitalize text-muted">{label}</dt><dd className="min-w-0 whitespace-pre-wrap break-words text-ink">{value}</dd></div>)}
    </dl> : null}
  </div>;
}

export const antigravity: AgentPlugin = {
  id: "antigravity",
  clients: ["agy"],
  metadataRequest: (record) => (codeAssist(record).type === "checkpoint" ? "Generate conversation title" : undefined),
  // Agent requests name their conversation. A web search names nothing, so it is
  // joined to the agent request whose `search_web` call carried its exact query.
  thread(record, { index, records }) {
    const { request, type } = codeAssist(record);
    if (type === "agent") return { id: conversationId(record) };
    if (type !== "web_search") return undefined;
    const query = firstText(request);
    for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
      const parent = conversationId(records[earlier]);
      const call = parent ? searchCall(records[earlier], query) : undefined;
      if (parent && call) return { id: `web_search:${String(call.id || index)}`, label: "Web search", name: query, parentId: parent };
    }
    return { id: `web_search:${index}`, label: "Web search", name: query };
  },
  textPatterns: SECTION_CLASSES.map(([tag, inputClass]) => [new RegExp(`^<${tag}>`), inputClass]),
  cleanPrompt: (text) => userRequest(text) ?? text,
  resultParts: (_call, parts) => toolResultParts(parts),
  splitSystemText: splitTaggedSections,
  sections: {
    "User prompt": {
      preview: (text) => userRequest(text),
      render: (text) => (userRequest(text) === undefined ? undefined : <UserRequest text={text}/>),
    },
    Skills: {
      preview: (text) => {
        const skills = parseSkills(text);
        return skills ? `${skillCount(skills)}: ${skills.map((skill) => skill.name).join(", ")}` : undefined;
      },
      fact: (text) => {
        const skills = parseSkills(text);
        return skills ? { mono: false, value: skillCount(skills) } : undefined;
      },
      render: (text) => {
        const skills = parseSkills(text);
        return skills ? <SkillList skills={skills}/> : undefined;
      },
    },
    "AGENTS.md": {
      preview: (text) => parseRules(text)?.path,
      render: (text) => {
        const rules = parseRules(text);
        return rules ? <ReadableText value={rules.body}/> : undefined;
      },
    },
  },
};
