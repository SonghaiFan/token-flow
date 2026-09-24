"use client";

/* View primitives shared by the request view and agent plugins. Agent plugins
   (`ui/lib/agents`) parse their own section formats and render with these, so
   every agent's evidence reads the same way. */

import { Streamdown, type Components } from "streamdown";
import { asObject } from "@/lib/json";
import { Badge } from "../ui/badge";

const markdownComponents: Components = {
  h1: ({ children }) => <h1 className="mb-3 mt-5 text-xl font-semibold tracking-[-0.03em] first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 mt-5 text-lg font-semibold tracking-[-0.02em] first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-2 mt-4 text-base font-semibold first:mt-0">{children}</h3>,
  p: ({ children }) => <p className="my-2 whitespace-pre-wrap leading-6 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-3 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  blockquote: ({ children }) => <blockquote className="my-3 border-l-2 border-line pl-4 text-muted">{children}</blockquote>,
  a: ({ children, href }) => <a className="font-medium underline decoration-line underline-offset-4 hover:decoration-ink" href={href} rel="noreferrer" target="_blank">{children}</a>,
  code: ({ children }) => <code className="rounded-tag bg-canvas px-1 py-0.5 font-mono text-[0.9em]">{children}</code>,
  pre: ({ children }) => <pre className="tf-code tf-well my-3 max-h-[32rem] overflow-auto border border-line p-3">{children}</pre>,
  // Captured markdown tables are evidence to read, so render a plain table without
  // Streamdown's copy, download, and fullscreen chrome. Only wide tables scroll.
  table: ({ children }) => <div className="my-3 overflow-x-auto"><table className="w-full border-collapse text-left text-xs leading-5">{children}</table></div>,
  thead: ({ children }) => <thead className="border-b border-line">{children}</thead>,
  tbody: ({ children }) => <tbody className="divide-y divide-line">{children}</tbody>,
  tr: ({ children }) => <tr>{children}</tr>,
  th: ({ children, style }) => <th className="whitespace-nowrap px-3 py-1.5 font-medium text-muted first:pl-0" style={style}>{children}</th>,
  td: ({ children, style }) => <td className="px-3 py-1.5 align-top first:pl-0 [&_code]:whitespace-nowrap" style={style}>{children}</td>,
};

function escapeCapturedTags(value: string): string {
  let fenced = false;
  return value.split("\n").map((line) => {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      return line;
    }
    if (fenced) return line;
    return line.split(/(`[^`]*`)/g).map((part, index) => index % 2 ? part : part.replace(/<(\/?[A-Za-z][^>\n]*)>/g, "&lt;$1&gt;")).join("");
  }).join("\n");
}

export function previewText(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (Array.isArray(value)) {
    for (const part of value) {
      const record = asObject(part);
      const preview = previewText(record.text ?? record.output ?? record.input_text ?? part);
      if (preview) return preview;
    }
  }
  const record = asObject(value);
  const nested = record.text ?? record.content ?? record.output ?? record.input_text;
  return nested === undefined || nested === value ? "" : previewText(nested);
}

export function stableValue(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function humanizeField(value: string): string {
  const labels: Record<string, string> = {
    cmd: "Command",
    command: "Command",
    justification: "Approval question",
    max_output_tokens: "Output limit",
    sandbox_permissions: "Sandbox",
    shell: "Shell",
    tty: "Terminal",
    workdir: "Working directory",
    yield_time_ms: "Wait for output",
  };
  return labels[value] || value.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}

export function RichText({ children }: { children: string }) {
  return <Streamdown animated={false} className="min-w-0 break-words text-sm text-ink" components={markdownComponents} dir="auto" mode="static">{escapeCapturedTags(children)}</Streamdown>;
}

export function ReadableText({ value }: { value: string }) {
  return <div className="tf-well max-h-[36rem] overflow-auto px-4 py-3"><RichText>{value}</RichText></div>;
}

/* An agent's environment block reduced to comparable facts. */
export interface EnvironmentFacts {
  entries: Array<{ access: string; escalatable: string; special: boolean; target: string }>;
  fields: Array<[string, string]>;
  fileSystem: string;
  profile: string;
  roots: string[];
}

const ENVIRONMENT_FIELDS: Record<string, string> = {
  current_date: "Date",
  cwd: "Working directory",
  network: "Network",
  shell: "Shell",
  timezone: "Time zone",
};

export function environmentPreview(facts: EnvironmentFacts): string {
  return facts.fields.map(([, item]) => item).filter(Boolean).join(" · ");
}

/* Field names whose value differs from the nearest earlier environment. */
export function environmentChanges(facts: EnvironmentFacts, earlier: EnvironmentFacts | null): string[] {
  if (!earlier) return [];
  const before = new Map(earlier.fields);
  const changed = facts.fields.filter(([key, item]) => before.has(key) && before.get(key) !== item).map(([key]) => (ENVIRONMENT_FIELDS[key] || humanizeField(key)).toLowerCase());
  if (stableValue(facts.entries) !== stableValue(earlier.entries) || stableValue(facts.roots) !== stableValue(earlier.roots)) changed.push("file system");
  return changed;
}

function accessCounts(facts: EnvironmentFacts): string {
  const counts = new Map<string, number>();
  for (const entry of facts.entries) counts.set(entry.access, (counts.get(entry.access) || 0) + 1);
  return [...counts].map(([access, count]) => `${access} ${count}`).join(" · ");
}

export function EnvironmentView({ earlier, facts }: { earlier: EnvironmentFacts | null; facts: EnvironmentFacts }) {
  const before = new Map(earlier?.fields || []);
  return <div className="space-y-3">
    <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
      {facts.fields.map(([key, item]) => {
        const old = before.get(key);
        return <div className="contents" key={key}><dt className="text-muted">{ENVIRONMENT_FIELDS[key] || humanizeField(key)}</dt><dd className="min-w-0 break-all font-mono text-xs text-ink">{old !== undefined && old !== item ? <s className="mr-2 text-muted">{old}</s> : null}{item || "Empty"}</dd></div>;
      })}
      {facts.roots.length ? <><dt className="text-muted">Workspace roots</dt><dd className="min-w-0 space-y-0.5 break-all font-mono text-xs text-ink">{facts.roots.map((root) => <div key={root}>{root}</div>)}</dd></> : null}
      {facts.entries.length ? <><dt className="text-muted">File system</dt><dd className="min-w-0 font-mono text-xs text-ink">{[facts.profile && `${facts.profile} profile`, facts.fileSystem, accessCounts(facts)].filter(Boolean).join(" · ")}</dd></> : null}
    </dl>
    {facts.entries.length ? <details className="text-xs">
      <summary className="cursor-pointer text-xs text-muted hover:text-ink">{facts.entries.length} access rules</summary>
      <div className="mt-2 overflow-hidden rounded-inset border border-line"><table className="w-full table-fixed text-left text-xs"><tbody className="divide-y divide-line">{facts.entries.map((entry, index) => <tr key={`${entry.target}-${index}`}><td className="w-20 px-3 py-1.5 align-top"><Badge mono tone={entry.access === "deny" ? "danger" : "neutral"}>{entry.access}</Badge></td><td className="break-all px-3 py-1.5 font-mono text-ink">{entry.target}{entry.special ? <span className="ml-2 font-sans text-xs text-muted">special</span> : null}{entry.escalatable === "false" ? <span className="ml-2 font-sans text-xs text-muted">not escalatable</span> : null}</td></tr>)}</tbody></table></div>
    </details> : null}
  </div>;
}
