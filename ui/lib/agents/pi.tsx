import { environmentChanges, environmentPreview, EnvironmentView, ReadableText, type EnvironmentFacts } from "@/components/workspace/section-views";
import { decodeXmlText, SkillList, skillCount, splitTaggedSections, type SkillEntry } from "./prompt-sections";
import type { AgentPlugin } from "./types";

/* Pi assembles one system prompt from top-level pseudo-XML sections: a plain
   preamble, then `<tools>`, `<rules>`, `<docs>`, `<project_context>`, `<skills>`,
   and `<cwd>` (see `splitTaggedSections`). */

function parseCwd(value: string): EnvironmentFacts | null {
  const cwd = /^\s*<cwd>([\s\S]*?)<\/cwd>\s*$/i.exec(value)?.[1];
  return cwd === undefined ? null : { entries: [], fields: [["cwd", cwd.trim()]], fileSystem: "", profile: "", roots: [] };
}

/* `<project_context>` wraps one `<project_instructions path="…">` per context file. */
function parseProjectContext(value: string): { body: string; path: string } | null {
  if (!/^\s*<project_context>/i.test(value)) return null;
  const files = [...value.matchAll(/<project_instructions\b([^>]*)>([\s\S]*?)<\/project_instructions>/gi)];
  if (!files.length) return null;
  return {
    body: files.map((match) => match[2].trim()).join("\n\n---\n\n"),
    path: files.map((match) => /\bpath="([^"]*)"/.exec(match[1])?.[1] || "").filter(Boolean).join(", "),
  };
}

/* Skills listed as `<skill><name/><description/><location/></skill>` entries. */
function parseSkills(value: string): SkillEntry[] | null {
  const skills = [...value.matchAll(/<skill>([\s\S]*?)<\/skill>/gi)].map((match) => {
    const field = (name: string) => decodeXmlText(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i").exec(match[1])?.[1] || "");
    return { description: field("description"), location: field("location"), name: field("name") };
  }).filter((skill) => skill.name);
  return skills.length ? skills : null;
}

export const pi: AgentPlugin = {
  id: "pi",
  clients: ["pi"],
  textPatterns: [
    [/^You are an expert coding assistant operating inside pi\b/i, { layer: "instructions", label: "Base instructions" }],
    [/^<tools>/i, { layer: "instructions", label: "Tool guide" }],
    [/^<rules>/i, { layer: "instructions", label: "Rules" }],
    [/^<docs>/i, { layer: "instructions", label: "Harness docs" }],
    [/^<skills>/i, { layer: "instructions", label: "Skills" }],
    [/^<project_context>/i, { layer: "context", label: "AGENTS.md" }],
    [/^<cwd>/i, { layer: "context", label: "Environment" }],
  ],
  splitSystemText: splitTaggedSections,
  sections: {
    Environment: {
      preview: (text) => {
        const facts = parseCwd(text);
        return facts ? environmentPreview(facts) : undefined;
      },
      changes: (text, previous) => {
        const facts = parseCwd(text);
        return facts && previous ? environmentChanges(facts, parseCwd(previous)) : [];
      },
      render: (text, previous) => {
        const facts = parseCwd(text);
        return facts ? <EnvironmentView earlier={previous ? parseCwd(previous) : null} facts={facts}/> : undefined;
      },
    },
    "AGENTS.md": {
      preview: (text) => parseProjectContext(text)?.path || undefined,
      render: (text) => {
        const parsed = parseProjectContext(text);
        return parsed ? <ReadableText value={parsed.body}/> : undefined;
      },
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
  },
};
