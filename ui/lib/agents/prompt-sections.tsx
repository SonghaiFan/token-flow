/* Prompt structure several harnesses share: a system prompt assembled from
   top-level pseudo-XML sections, and a skill catalog listed inside it. */

/* Split a system prompt at its top-level pseudo-XML sections, each opened and
   closed on its own line (`<tools>` … `</tools>`), so every section is labeled
   and rendered on its own. Text outside a section stays as its own block. Tags
   nested inside a section are part of it. Text with fewer than two sections is
   kept whole; Raw always shows the exact capture. */
export function splitTaggedSections(text: string): string[] {
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

export interface SkillEntry {
  description: string;
  location: string;
  name: string;
}

export function decodeXmlText(value: string): string {
  return value.replace(/&(quot|apos|lt|gt|amp);/g, (entity, name: string) => ({ amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' })[name] || entity).trim();
}

export function skillCount(skills: SkillEntry[]): string {
  return `${skills.length} ${skills.length === 1 ? "skill" : "skills"}`;
}

export function SkillList({ skills }: { skills: SkillEntry[] }) {
  return <ul className="max-h-[36rem] divide-y divide-line overflow-auto rounded-inset border border-line text-xs">
    {skills.map((skill, index) => <li className="space-y-0.5 px-3 py-2" key={`${skill.name}-${index}`}>
      <p className="break-all font-mono font-medium text-ink">{skill.name}</p>
      <p className="line-clamp-2 text-muted" title={skill.description}>{skill.description || "No description"}</p>
      {skill.location ? <p className="truncate font-mono text-xs text-muted" title={skill.location}>{skill.location}</p> : null}
    </li>)}
  </ul>;
}

