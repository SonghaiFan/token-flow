import { asObject } from "./json";

/* How a tool result should be shown, decided from the call that produced it, never
   from what the output happens to look like. The same text can be a README, a
   web page, or source code; only the call knows which. Without evidence the
   output stays plain text, the literal capture. */

export type OutputKind = "markdown" | "code" | "diff" | "web" | "text";

export interface OutputFormat {
  kind: OutputKind;
  /* Syntax language for code. */
  language?: string;
  /* The evidence, shown beside the switch: a file name, a command, a tool. */
  reason?: string;
}

/* What a call reads: the command it runs, or the file a read tool opens. */
export interface CallSource {
  name: string;
  command?: string;
  path?: string;
}

const MARKDOWN = new Set(["md", "mdx", "markdown"]);
const LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "tsx", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp", php: "php", scala: "scala",
  sh: "bash", bash: "bash", zsh: "bash", fish: "fish", ps1: "powershell",
  json: "json", jsonc: "json", yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini",
  html: "html", css: "css", scss: "scss", vue: "vue", svelte: "svelte", sql: "sql",
  xml: "xml", graphql: "graphql", lua: "lua", dart: "dart", r: "r",
};
/* Commands that print a file unchanged, and filters that keep it unchanged. */
const READERS = new Set(["cat", "bat", "head", "tail", "sed", "less", "more"]);
const FILTERS = new Set(["head", "tail", "sed"]);
const WEB_TOOL = /(?:^|[_.\-\s])(?:web|fetch|browse|browser|open_url|search_web|webfetch|websearch)(?:$|[_.\-\s])/i;

function fileKind(path: string): OutputFormat | undefined {
  const name = path.split("/").pop() || path;
  const extension = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (MARKDOWN.has(extension)) return { kind: "markdown", reason: name };
  if (extension === "diff" || extension === "patch") return { kind: "diff", reason: name };
  const language = LANGUAGES[extension];
  if (language) return { kind: "code", language, reason: name };
  return undefined;
}

/* Split a shell command into words, keeping quoted arguments together. */
function words(segment: string): string[] {
  return [...segment.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]);
}

/* The file a reader command prints, when the whole command is that one read,
   optionally narrowed by head, tail, or sed. Compound commands (`&&`, `;`, `||`)
   mix several outputs, so they have no single format. */
function readPath(command: string): string | undefined {
  if (/&&|\|\||;|\n|`|\$\(/.test(command)) return undefined;
  const stages = command.split("|").map((stage) => words(stage.trim())).filter((stage) => stage.length);
  if (!stages.length) return undefined;
  const [first, ...rest] = stages;
  if (!READERS.has(first[0]) || rest.some((stage) => !FILTERS.has(stage[0]))) return undefined;
  // sed prints its input unchanged only with -n and a print range, or no script edits.
  if (first[0] === "sed" && !first.includes("-n")) return undefined;
  const paths = first.slice(1).filter((word) => !word.startsWith("-") && /[./]/.test(word) && !/^\d+(?:,\d+)?p$/.test(word));
  return paths.length === 1 ? paths[0] : undefined;
}

/* The source a call reads, from its common argument names. Agent plugins can
   describe their own tools more precisely. */
export function callReadSource(name: string, input: unknown): CallSource {
  const args = asObject(input);
  const text = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : undefined);
  return {
    name,
    command: text("cmd") ?? text("command") ?? text("script") ?? (typeof input === "string" ? input : undefined),
    path: text("path") ?? text("file_path") ?? text("filePath") ?? text("file"),
  };
}

export function inferOutputFormat(source: CallSource): OutputFormat {
  if (WEB_TOOL.test(source.name)) return { kind: "web", reason: source.name.split(/\s+/).find((part) => WEB_TOOL.test(part)) || source.name };
  if (source.path) return fileKind(source.path) || { kind: "text", reason: source.path.split("/").pop() };
  const command = source.command?.trim();
  if (command) {
    if (/^(?:git\s+(?:-\S+\s+)*(?:diff|show)|diff\s+-\S*u)\b/.test(command) && !/&&|\|\||;/.test(command)) return { kind: "diff", reason: command.split(/\s+/).slice(0, 2).join(" ") };
    const path = readPath(command);
    if (path) return fileKind(path) || { kind: "text", reason: path.split("/").pop() };
  }
  return { kind: "text" };
}

/* Web tools mark citations with private-use delimiters (`cite…`)
   and bracketed references (`【12†source】`), and number fetched lines `L12: `,
   also mid-line where the page's own lines were joined.
   Remove them for reading; the exact capture stays in Plain and Raw. */
export function cleanWebText(value: string): string {
  return value
    .replace(/[^]*/g, "")
    .replace(/【[^】]*】/g, "")
    .replace(/(^|\s)L\d+:(?=\s|$)\s?/gm, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}
