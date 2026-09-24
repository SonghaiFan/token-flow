import { environmentChanges, environmentPreview, EnvironmentView, ReadableText, type EnvironmentFacts } from "@/components/workspace/section-views";
import type { AgentPlugin } from "./types";

/* Pi assembles one system prompt from top-level pseudo-XML sections, each opened
   and closed on its own line: a plain preamble, then `<tools>`, `<rules>`,
   `<docs>`, `<project_context>`, `<skills>`, and `<cwd>`. Split at those
   boundaries so every section is labeled and rendered on its own. Text with fewer
   than two sections is kept whole; Raw always shows the exact capture. */
function splitSections(text: string): string[] {
  const lines = text.split("\n");
  const sections: string[] = [];
  let loose: string[] = [];
  let tagged = 0;
  const flush = () => {
    const value = loose.join("\n").trim();
    if (value) sections.push(value);
    loose = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const tag = /^<([A-Za-z_][\w-]*)(?:\s[^>]*)?>$/.exec(lines[index].trimEnd())?.[1];
    const end = tag ? lines.findIndex((line, lineIndex) => lineIndex > index && line.trimEnd() === `</${tag}>`) : -1;
    if (!tag || end < 0) {
      loose.push(lines[index]);
      continue;
    }
    flush();
    sections.push(lines.slice(index, end + 1).join("\n"));
    tagged += 1;
    index = end;
  }
  flush();
  return tagged >= 2 ? sections : [text];
}

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

interface SkillEntry {
  description: string;
  location: string;
  name: string;
}

function decodeXmlText(value: string): string {
  return value.replace(/&(quot|apos|lt|gt|amp);/g, (entity, name: string) => ({ amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' })[name] || entity).trim();
}

/* Skills listed as `<skill><name/><description/><location/></skill>` entries. */
function parseSkills(value: string): SkillEntry[] | null {
  const skills = [...value.matchAll(/<skill>([\s\S]*?)<\/skill>/gi)].map((match) => {
    const field = (name: string) => decodeXmlText(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i").exec(match[1])?.[1] || "");
    return { description: field("description"), location: field("location"), name: field("name") };
  }).filter((skill) => skill.name);
  return skills.length ? skills : null;
}

function skillCount(skills: SkillEntry[]): string {
  return `${skills.length} ${skills.length === 1 ? "skill" : "skills"}`;
}

function SkillList({ skills }: { skills: SkillEntry[] }) {
  return <ul className="max-h-[36rem] divide-y divide-line overflow-auto rounded-lg border border-line text-xs">
    {skills.map((skill, index) => <li className="space-y-0.5 px-3 py-2" key={`${skill.name}-${index}`}>
      <p className="break-all font-mono font-medium text-ink">{skill.name}</p>
      <p className="line-clamp-2 text-muted" title={skill.description}>{skill.description || "No description"}</p>
      {skill.location ? <p className="truncate font-mono text-[11px] text-muted" title={skill.location}>{skill.location}</p> : null}
    </li>)}
  </ul>;
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
  splitSystemText: splitSections,
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
