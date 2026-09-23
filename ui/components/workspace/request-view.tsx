"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Streamdown, type Components } from "streamdown";
import { formatDuration, formatNumber } from "@/lib/format";
import { classifyInput, LAYER_META, LAYER_ORDER } from "@/lib/token-model";
import type { InputClass, InputLayer, ItemState, TokenSelection, TraceRecord, TurnModel } from "@/lib/types";
import { categoryColor } from "@/lib/category-palette";
import { CategorySwatch } from "../charts/category-legend";
import { SearchIcon } from "../icons";
import { activateOnKey, Segmented, useAccordion } from "../motion";
import { RawJsonTree } from "./raw-json-tree";
import { clearCurrentMatch, clearHighlights, focusMatch, highlightMatches, MIN_QUERY, SEARCH_HIT_LIMIT, searchRecord, type JsonPathPart, type SearchHit } from "./request-search";

type UnknownRecord = Record<string, unknown>;
type RequestMode = "structured" | "raw";
type RequestScope = "turn" | "changes";

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
  code: ({ children }) => <code className="rounded bg-canvas px-1 py-0.5 font-mono text-[0.9em]">{children}</code>,
  pre: ({ children }) => <pre className="tf-code my-3 max-h-[32rem] overflow-auto rounded-lg border border-line bg-canvas p-3">{children}</pre>,
  // Captured markdown tables are evidence to read, so render a plain table without
  // Streamdown's copy, download, and fullscreen chrome. Only wide tables scroll.
  table: ({ children }) => <div className="my-3 overflow-x-auto"><table className="w-full border-collapse text-left text-[12px] leading-5">{children}</table></div>,
  thead: ({ children }) => <thead className="border-b border-line">{children}</thead>,
  tbody: ({ children }) => <tbody className="divide-y divide-line">{children}</tbody>,
  tr: ({ children }) => <tr>{children}</tr>,
  th: ({ children, style }) => <th className="whitespace-nowrap px-3 py-1.5 font-medium text-muted first:pl-0" style={style}>{children}</th>,
  td: ({ children, style }) => <td className="px-3 py-1.5 align-top first:pl-0 [&_code]:whitespace-nowrap" style={style}>{children}</td>,
};

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
}

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

function previewText(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (Array.isArray(value)) {
    for (const part of value) {
      const record = asRecord(part);
      const preview = previewText(record.text ?? record.output ?? record.input_text ?? part);
      if (preview) return preview;
    }
  }
  const record = asRecord(value);
  const nested = record.text ?? record.content ?? record.output ?? record.input_text;
  return nested === undefined || nested === value ? "" : previewText(nested);
}

function capturedText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(capturedText).filter(Boolean).join("");
  const record = asRecord(value);
  const nested = record.text ?? record.content ?? record.output ?? record.input_text ?? record.output_text;
  return nested === undefined || nested === value ? "" : capturedText(nested);
}

function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "system" | "user" | "assistant" | "danger" }) {
  const tones = {
    neutral: "border-line bg-canvas text-muted",
    system: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300",
    user: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300",
    assistant: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300",
    danger: "border-red-200 bg-red-50 text-danger dark:border-red-900 dark:bg-red-950",
  };
  return <span className={`inline-flex max-w-full items-center whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

function inputPreview(message: UnknownRecord, content: unknown, index: number): string {
  const preview = previewText(content);
  if (preview) return preview;
  const type = textValue(message.type).toLowerCase();
  const name = textValue(message.name);
  if (type === "reasoning" || type === "thinking") return "Reasoning state";
  if (type.endsWith("_call") || type === "tool_use") return name ? `Call ${name}` : "Tool call";
  if (type.endsWith("_call_output") || type === "tool_result" || type === "tool_output") return "Tool result";
  return `Input item ${index + 1}`;
}

function inputItemParts(message: UnknownRecord): unknown[] {
  const source = message.content ?? message.parts ?? message.text ?? message.output;
  if (Array.isArray(source)) return source;
  return [source === undefined ? message : source];
}

function RichText({ children }: { children: string }) {
  return <Streamdown animated={false} className="min-w-0 break-words text-sm text-ink" components={markdownComponents} dir="auto" mode="static">{escapeCapturedTags(children)}</Streamdown>;
}

function JsonBlock({ value }: { value: unknown }) {
  return <pre className="tf-code max-h-[28rem] overflow-auto rounded-lg border border-line bg-canvas p-3 text-ink">{JSON.stringify(value, null, 2)}</pre>;
}

interface ParsedStructuredText {
  prefix: string;
  recovered: boolean;
  suffix: string;
  value: unknown;
}

interface ToolResultDefinition {
  description: string;
  name: string;
  [key: string]: unknown;
}

interface ParsedToolResult {
  elapsed: string;
  output: string;
  status: string;
}

interface ParsedWrappedToolCall {
  input: UnknownRecord;
  name: string;
}

function decodeCapturedEscapes(value: string): string {
  return value
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\\"/g, "\"")
    .replace(/\\\\/g, "\\");
}

function recoverToolDefinitionArray(value: string): ToolResultDefinition[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[{"name":"') || !trimmed.endsWith("}]")) return null;
  const chunks = trimmed
    .replace(/^\[\{/, "{")
    .replace(/\]\s*$/, "")
    .split(/\},\s*\{"name":"/)
    .map((chunk, index) => index === 0 ? chunk : `{"name":"${chunk}`);
  const tools: ToolResultDefinition[] = [];
  for (let chunk of chunks) {
    chunk = chunk.replace(/^\{"name":"/, "").replace(/"\}\s*$/, "");
    const marker = '\",\"description\":\"';
    const markerIndex = chunk.indexOf(marker);
    if (markerIndex < 1) return null;
    const name = decodeCapturedEscapes(chunk.slice(0, markerIndex)).trim();
    const description = decodeCapturedEscapes(chunk.slice(markerIndex + marker.length)).trim();
    if (!name || !description) return null;
    tools.push({ description, name });
  }
  return tools.length ? tools : null;
}

function jsonValueEnd(value: string): number {
  const closing: Record<string, string> = { "{": "}", "[": "]" };
  const first = value[0];
  if (!closing[first]) return -1;
  const stack = [closing[first]];
  let quoted = false;
  let escaped = false;
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (closing[character]) stack.push(closing[character]);
    else if (character === stack.at(-1)) {
      stack.pop();
      if (!stack.length) return index + 1;
    }
  }
  return -1;
}

function recoverJsonArrayItems(value: string): unknown[] {
  if (!value.startsWith("[")) return [];
  const items: unknown[] = [];
  let itemStart = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === "{" || character === "[") {
      if (depth === 0) itemStart = index;
      depth += 1;
      continue;
    }
    if (character === "}" || character === "]") {
      if (depth === 0) break;
      depth -= 1;
      if (depth === 0 && itemStart >= 0) {
        const item = parseJsonValue(value.slice(itemStart, index + 1));
        if (item !== undefined) items.push(item);
        itemStart = -1;
      }
    }
  }
  return items;
}

function parseStructuredText(value: string): ParsedStructuredText | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const candidateOffsets = new Set<number>([value.indexOf(trimmed)]);
  for (const match of value.matchAll(/(?:^|\n)\s*(?=[{[])/g)) {
    const offset = match.index + match[0].length;
    candidateOffsets.add(offset);
  }
  const toolArrayOffset = value.indexOf('[{"name":"');
  if (toolArrayOffset >= 0) candidateOffsets.add(toolArrayOffset);

  for (const offset of [...candidateOffsets].filter((item) => item >= 0).sort((a, b) => a - b)) {
    const candidate = value.slice(offset).trim();
    if (!candidate.startsWith("{") && !candidate.startsWith("[")) continue;
    const end = jsonValueEnd(candidate);
    if (end >= 0) {
      const parsed = parseJsonValue(candidate.slice(0, end));
      if (parsed !== undefined) {
        return { prefix: value.slice(0, offset).trim(), recovered: false, suffix: candidate.slice(end).trim(), value: parsed };
      }
    }
    const tools = recoverToolDefinitionArray(candidate);
    if (tools) return { prefix: value.slice(0, offset).trim(), recovered: false, suffix: "", value: tools };
    const recovered = recoverJsonArrayItems(candidate);
    if (recovered.length) return { prefix: value.slice(0, offset).trim(), recovered: true, suffix: "", value: recovered };
  }
  return null;
}

function parseJsonValue(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function matchingBrace(value: string, start: number): number {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function parseWrappedToolCall(value: string): ParsedWrappedToolCall | null {
  const call = /tools\.([A-Za-z_$][\w$]*)\s*\(\s*\{/.exec(value);
  if (!call || call.index === undefined) return null;
  const start = value.indexOf("{", call.index + call[0].length - 1);
  const end = matchingBrace(value, start);
  if (start < 0 || end < 0) return null;
  const objectLiteral = value.slice(start, end + 1)
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3');
  const parsed = parseJsonValue(objectLiteral);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return { input: asRecord(parsed), name: call[1] };
}

function parseToolResult(value: string): ParsedToolResult {
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  const outputIndex = lines.findIndex((line) => /^Output:\s*$/i.test(line.trim()));
  const metadata = outputIndex >= 0 ? lines.slice(0, outputIndex) : [];
  const status = metadata.find((line) => /(?:completed|failed|error|timed out)/i.test(line))?.trim() || "";
  const elapsedMatch = metadata.join("\n").match(/Wall time\s+([\d.]+)\s*seconds?/i);
  return {
    elapsed: elapsedMatch ? `${elapsedMatch[1]} s` : "",
    output: (outputIndex >= 0 ? lines.slice(outputIndex + 1) : lines).join("\n").trim(),
    status,
  };
}

function toolEventKind(message: UnknownRecord): "call" | "result" | null {
  const type = textValue(message.type).toLowerCase();
  if (type.endsWith("_call_output") || type === "tool_result" || type === "tool_output") return "result";
  if (type.endsWith("_call") || type === "tool_use") return "call";
  return null;
}

function humanizeField(value: string): string {
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

function formatToolField(key: string, value: unknown): string {
  if (key === "yield_time_ms" && typeof value === "number") return `${value / 1000} s`;
  if (key === "max_output_tokens" && typeof value === "number") return `${value.toLocaleString()} tokens`;
  return textValue(value);
}

function toolCallPresentation(message: UnknownRecord): { input: unknown; name: string; preview: string; wrapperName: string } {
  const declaredName = textValue(message.name) || textValue(message.type).replace(/_call$/, "") || "Unknown tool";
  const source = message.arguments ?? message.input;
  if (typeof source === "string") {
    const wrapped = parseWrappedToolCall(source);
    if (wrapped) {
      const command = textValue(wrapped.input.cmd ?? wrapped.input.command);
      return { input: wrapped.input, name: declaredName, preview: command, wrapperName: wrapped.name };
    }
    const parsed = parseJsonValue(source);
    return { input: parsed === undefined ? source : parsed, name: declaredName, preview: previewText(parsed ?? source), wrapperName: "" };
  }
  return { input: source ?? {}, name: declaredName, preview: previewText(source), wrapperName: "" };
}

function isToolResultDefinition(value: unknown): value is ToolResultDefinition {
  const item = asRecord(value);
  return Boolean(textValue(item.name) && textValue(item.description));
}

function splitToolDescription(value: string): { declaration: string; summary: string } {
  const marker = /\n\s*exec tool declaration:\s*\n/i;
  const match = marker.exec(value);
  if (!match || match.index === undefined) return { declaration: "", summary: value.trim() };
  let declaration = value.slice(match.index + match[0].length).trim();
  declaration = declaration.replace(/^```(?:ts|typescript)?\s*/i, "").replace(/^ts\s*\n/i, "").replace(/\s*```\s*$/, "").trim();
  return { declaration, summary: value.slice(0, match.index).trim() };
}

function ResultNotice({ value }: { value: string }) {
  const tokenCount = /original token count:\s*([\d,]+)/i.exec(value)?.[1];
  const lineCount = /total output lines:\s*([\d,]+)/i.exec(value)?.[1];
  const warning = value
    .replace(/\s*\(?original token count:\s*[\d,]+\)?/i, "")
    .replace(/\s*total output lines:\s*[\d,]+/i, "")
    .trim();
  return <div className="flex flex-wrap items-center gap-2 rounded-control border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
    <span className="text-xs font-medium">{warning || "Captured output metadata"}</span>
    {tokenCount ? <Pill tone="system">Original {Number(tokenCount.replaceAll(",", "")).toLocaleString()} tokens</Pill> : null}
    {lineCount ? <Pill tone="system">{Number(lineCount.replaceAll(",", "")).toLocaleString()} output {Number(lineCount.replaceAll(",", "")) === 1 ? "line" : "lines"}</Pill> : null}
  </div>;
}

function ToolResultCatalog({ tools }: { tools: ToolResultDefinition[] }) {
  return <section className="overflow-hidden rounded-control border border-line bg-canvas/40">
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-3 sm:px-4">
      <div className="min-w-0"><h4 className="text-sm font-semibold">Returned tool catalog</h4><p className="mt-0.5 text-xs text-muted">Tool definitions returned by this call, rendered as readable entries.</p></div>
      <Pill>{tools.length} tools</Pill>
    </div>
    <div className="space-y-2 p-2 sm:p-3">{tools.map((tool, index) => {
      const { declaration, summary } = splitToolDescription(tool.description);
      const metadata = Object.fromEntries(Object.entries(tool).filter(([key]) => key !== "name" && key !== "description"));
      return <div key={`${tool.name}-${index}`} style={{ containIntrinsicSize: "0 64px", contentVisibility: "auto" }}>
        <Disclosure summary={<div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><strong className="break-all font-mono text-xs text-ink">{tool.name}</strong><Pill>{textValue(tool.type) || "tool"}</Pill></div>{summary ? <p className="mt-1 line-clamp-2 text-xs leading-4 text-muted">{summary}</p> : null}</div>}>
          <div className="space-y-3">
            {summary ? <RichText>{summary}</RichText> : null}
            {declaration ? <Disclosure summary={<><strong className="text-xs">Declaration</strong><span className="text-xs text-muted">Parameters and return type</span></>}><pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-lg bg-canvas p-3 font-mono text-xs leading-5 text-ink">{declaration}</pre></Disclosure> : null}
            {Object.keys(metadata).length ? <Disclosure summary={<><strong className="text-xs">Additional fields</strong><Pill>{Object.keys(metadata).length}</Pill></>}><JsonBlock value={metadata}/></Disclosure> : null}
          </div>
        </Disclosure>
      </div>;
    })}</div>
  </section>;
}

function StructuredValue({ value }: { value: unknown }) {
  if (Array.isArray(value) && value.length && value.every(isToolResultDefinition)) return <ToolResultCatalog tools={value}/>;
  if (Array.isArray(value)) return <section className="space-y-2"><div className="flex items-center gap-2"><strong className="text-xs">Structured list</strong><Pill>{value.length} items</Pill></div>{value.map((item, index) => <Disclosure key={index} summary={<><strong className="text-xs">Item {index + 1}</strong><span className="min-w-0 truncate text-xs text-muted">{previewText(item)}</span></>}><StructuredValue value={item}/></Disclosure>)}</section>;
  if (value && typeof value === "object") {
    const entries = Object.entries(asRecord(value));
    return <dl className="divide-y divide-line overflow-hidden rounded-control border border-line">{entries.map(([key, item]) => <div className="grid gap-1 px-3 py-3 text-xs sm:grid-cols-[10rem_minmax(0,1fr)]" key={key}><dt className="break-all font-mono text-xs font-medium text-muted">{key}</dt><dd className="min-w-0 break-words text-ink">{item && typeof item === "object" ? <Disclosure summary={<><span className="text-xs">{Array.isArray(item) ? `${item.length} items` : `${Object.keys(asRecord(item)).length} fields`}</span><span className="min-w-0 truncate text-xs text-muted">{previewText(item)}</span></>}><StructuredValue value={item}/></Disclosure> : <span className="whitespace-pre-wrap">{textValue(item) || (item === null ? "null" : "")}</span>}</dd></div>)}</dl>;
  }
  return <span className="whitespace-pre-wrap text-xs text-ink">{textValue(value) || (value === null ? "null" : "")}</span>;
}

function StructuredText({ children }: { children: string }) {
  const parsed = useMemo(() => parseStructuredText(children), [children]);
  if (!parsed) return <RichText>{children}</RichText>;
  return <StructuredOutput parsed={parsed}/>;
}

function StructuredOutput({ parsed }: { parsed: ParsedStructuredText }) {
  return <div className="space-y-3">
    {parsed.prefix ? <ResultNotice value={parsed.prefix}/> : null}
    {parsed.recovered ? <div className="rounded-control border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">Recovered {Array.isArray(parsed.value) ? parsed.value.length : 0} complete entries from truncated JSON. The incomplete final entry remains available in Raw.</div> : null}
    <StructuredValue value={parsed.value}/>
    {parsed.suffix ? <ResultNotice value={parsed.suffix}/> : null}
  </div>;
}

function htmlText(value: string): string {
  return value
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function HtmlOutput({ value }: { value: string }) {
  const title = htmlText(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(value)?.[1] || "");
  const notice = htmlText(/<noscript\b[^>]*>([\s\S]*?)<\/noscript>/i.exec(value)?.[1] || "");
  const robots = /<meta\b[^>]*name=["']robots["'][^>]*content=["']([^"']*)["']/i.exec(value)?.[1]
    || /<meta\b[^>]*content=["']([^"']*)["'][^>]*name=["']robots["']/i.exec(value)?.[1]
    || "";
  const scriptCount = (value.match(/<script\b/gi) || []).length;
  const endpoint = /fetch\(\s*["']([^"']+)["']/.exec(value)?.[1] || "";
  const challenge = /SHA-256/i.test(value) && Boolean(endpoint);
  const verification = /verify your browser/i.test(notice) || endpoint.includes("verify");
  const facts = [
    ["Document title", title],
    ["Search indexing", robots],
    ["Inline scripts", String(scriptCount)],
    ["Request endpoint", endpoint],
    ["Challenge", challenge ? "SHA-256 proof of work" : ""],
    ["Next action", /location\.reload\(\)/.test(value) ? "Reload after verification" : ""],
  ].filter(([, item]) => item);
  return <section className="overflow-hidden rounded-control border border-line">
    <div className="border-b border-line bg-canvas/60 px-3 py-3 sm:px-4"><div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-semibold">{verification ? "Browser verification page" : "HTML document"}</h4><Pill>HTML</Pill></div><p className="mt-1 text-xs text-muted">{verification ? "The server returned a verification challenge instead of the requested data." : "The server returned a document instead of structured data."}</p></div>
    <div className="space-y-4 px-3 py-3 sm:px-4">
      {notice ? <div><div className="text-xs font-medium text-muted">Page notice</div><p className="mt-1 text-sm leading-5 text-ink">{notice}</p></div> : null}
      {facts.length ? <dl className="grid gap-x-5 gap-y-3 sm:grid-cols-2">{facts.map(([label, item]) => <div key={label}><dt className="text-xs font-medium text-muted">{label}</dt><dd className="mt-1 break-words font-mono text-xs text-ink">{item}</dd></div>)}</dl> : null}
    </div>
  </section>;
}

function TextOutput({ value }: { value: string }) {
  const lines = value.split("\n");
  if (!value) return <div className="rounded-lg border border-dashed border-line px-3 py-4 text-xs text-muted">The tool completed without captured output.</div>;
  if (/too many requests|rate limit/i.test(value)) return <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 dark:border-amber-900 dark:bg-amber-950"><strong className="text-xs text-amber-900 dark:text-amber-200">Rate limited</strong><p className="mt-1 text-xs text-amber-900 dark:text-amber-200">{value.trim()}</p></div>;
  return <section><div className="mb-1.5 flex items-center justify-between gap-3"><h4 className="text-xs font-semibold uppercase tracking-[0.1em] text-muted">Output</h4><span className="font-mono text-xs text-muted">{lines.length} {lines.length === 1 ? "line" : "lines"}</span></div><ol className="max-h-[28rem] overflow-auto rounded-lg bg-canvas py-2 font-mono text-xs leading-5 text-ink">{lines.map((line, index) => <li className="grid grid-cols-[2.5rem_minmax(0,1fr)] px-3" key={index}><span className="select-none pr-3 text-right text-muted/70">{index + 1}</span><span className="whitespace-pre-wrap break-words">{line || " "}</span></li>)}</ol></section>;
}

function looksLikeMarkdown(value: string): boolean {
  const headingCount = value.match(/^#{1,6}\s+\S/gm)?.length || 0;
  if (headingCount >= 2 || /^\s*(?:```|~~~)/m.test(value)) return true;
  const signals = [
    /^\s*[-*+]\s+\S/m.test(value),
    /^\s*\d+\.\s+\S/m.test(value),
    /^\s*>\s+\S/m.test(value),
    /\[[^\]\n]+\]\([^\s)]+(?:\s+["'][^"']*["'])?\)/.test(value),
    /(?:^|[^*])\*\*[^*\n]+\*\*/m.test(value),
    /^\s*\|.+\|\s*$/m.test(value) && /^\s*\|?\s*:?-{3,}/m.test(value),
  ].filter(Boolean).length;
  return headingCount + signals >= 2;
}

function MarkdownOutput({ value }: { value: string }) {
  const lineCount = value.split("\n").length;
  return <section><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><div><h4 className="text-xs font-semibold">Rendered Markdown</h4><p className="mt-0.5 text-xs text-muted">Exact source remains available in Raw.</p></div><Pill>{lineCount} {lineCount === 1 ? "line" : "lines"}</Pill></div><div className="max-h-[40rem] overflow-auto rounded-control border border-line bg-canvas/50 px-4 py-3 sm:px-5 sm:py-4"><RichText>{value}</RichText></div></section>;
}

type DetectedToolOutput =
  | { kind: "html"; value: string }
  | { kind: "markdown"; value: string }
  | { kind: "structured"; value: ParsedStructuredText }
  | { kind: "text"; value: string };

function detectToolOutput(value: string): DetectedToolOutput {
  const trimmed = value.trim();
  if (/^<!doctype\s+html|^<html\b/i.test(trimmed)) return { kind: "html", value: trimmed };
  const structured = parseStructuredText(trimmed);
  if (structured) return { kind: "structured", value: structured };
  if (looksLikeMarkdown(trimmed)) return { kind: "markdown", value: trimmed };
  return { kind: "text", value: trimmed };
}

function ToolOutputView({ value }: { value: string }) {
  const output = detectToolOutput(value);
  if (output.kind === "html") return <HtmlOutput value={output.value}/>;
  if (output.kind === "structured") return <StructuredOutput parsed={output.value}/>;
  if (output.kind === "markdown") return <MarkdownOutput value={output.value}/>;
  return <TextOutput value={output.value}/>;
}

function Disclosure({ children, defaultOpen = false, summary }: { children: ReactNode; defaultOpen?: boolean; summary: ReactNode }) {
  // A later selection inside a closed disclosure opens it at once so the block can be scrolled to.
  const { mounted, open, toggle } = useAccordion(defaultOpen);
  return <div className="t-acc rounded-control border border-line bg-panel" data-open={open ? "true" : "false"}>
    <div aria-expanded={open} className="t-acc-head flex min-h-11 cursor-pointer items-center gap-2 rounded-control px-3 py-2 outline-none hover:bg-canvas/70 focus-visible:ring-2 focus-visible:ring-ink/30" onClick={toggle} onKeyDown={(event) => activateOnKey(event, toggle)} role="button" tabIndex={0}>{summary}<span aria-hidden="true" className="t-acc-chevron ml-auto text-xs text-muted">›</span></div>
    {mounted ? <div className="t-acc-panel"><div className="t-acc-panel-inner"><div className="border-t border-line px-3 py-3 sm:px-4">{children}</div></div></div> : null}
  </div>;
}

function ContentPart({ value }: { value: unknown }) {
  if (typeof value === "string") return <StructuredText>{value}</StructuredText>;
  const part = asRecord(value);
  const text = textValue(part.text ?? part.output ?? part.input_text ?? part.output_text);
  if (text) return <StructuredText>{text}</StructuredText>;
  const type = textValue(part.type) || "content";
  if (type.includes("image") || part.image_url || part.file_id) {
    return <div className="flex flex-wrap items-center gap-2"><Pill>{type}</Pill><span className="text-xs text-muted">Attachment metadata is available in Raw JSON.</span></div>;
  }
  return <JsonBlock value={value}/>;
}

function splitBlockId(blockId: string): { itemId: string; partIndex: number | null } {
  const match = blockId.match(/^(.*):(\d+)$/);
  return match ? { itemId: match[1], partIndex: Number(match[2]) } : { itemId: blockId, partIndex: null };
}

function selectedJsonPath(record: TraceRecord, selection: TokenSelection | null, turnId: string): Array<number | string> | null {
  if (!selection || selection.turnId !== turnId) return null;
  const body = asRecord(record.request?.body);
  if (selection.label === "Tool definitions" && Array.isArray(body.tools)) return ["trace", "request", "body", "tools"];

  const sourceKey = ["input", "messages", "contents"].find((key) => Array.isArray(body[key]));
  if (!sourceKey) return null;
  const { itemId, partIndex } = splitBlockId(selection.blockId);
  const items = asArray(body[sourceKey]);
  const itemIndex = items.findIndex((candidate) => textValue(asRecord(candidate).id) === itemId);
  if (itemIndex < 0) return null;

  const path: Array<number | string> = ["trace", "request", "body", sourceKey, itemIndex];
  if (partIndex === null) return path;
  const item = asRecord(items[itemIndex]);
  const partKey = ["content", "parts", "text", "output"].find((key) => item[key] !== undefined);
  if (!partKey) return path;
  path.push(partKey);
  if (Array.isArray(item[partKey])) path.push(partIndex);
  return path;
}

function toolGroups(value: unknown): Array<{ name: string; tools: UnknownRecord[] }> {
  const groups = new Map<string, UnknownRecord[]>();
  for (const item of asArray(value)) {
    const tool = asRecord(item);
    if (tool.type === "namespace" && Array.isArray(tool.tools)) {
      groups.set(textValue(tool.name) || "Namespace", asArray(tool.tools).map(asRecord));
      continue;
    }
    const current = groups.get("Tools") || [];
    current.push(tool);
    groups.set("Tools", current);
  }
  return [...groups].map(([name, tools]) => ({ name, tools }));
}

function collectInput(body: UnknownRecord): unknown[] {
  const items: unknown[] = [];
  const system = body.instructions ?? body.system ?? body.system_instruction;
  if (system !== undefined) items.push({ type: "instructions", role: "system", content: system });
  const source = body.input ?? body.messages ?? body.contents;
  if (Array.isArray(source)) items.push(...source);
  else if (source !== undefined) items.push({ type: "message", role: "user", content: source });
  return items;
}

function requestToolNames(body: UnknownRecord): string[] {
  const names: string[] = [];
  const addTools = (value: unknown) => {
    for (const item of asArray(value)) {
      const tool = asRecord(item);
      if (tool.type === "namespace") addTools(tool.tools);
      else {
        const name = textValue(tool.name);
        if (name) names.push(name);
      }
    }
  };
  addTools(body.tools);
  for (const item of collectInput(body)) {
    const record = asRecord(item);
    if (record.type === "additional_tools") addTools(record.tools);
  }
  return [...new Set(names)];
}

function stableValue(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

type LayerChange = "added" | "removed" | "changed";

interface LayerDiff {
  after?: number;
  before?: number;
  layer: InputLayer;
  rows: Array<{ change: LayerChange; entry: InputEntry }>;
  uncompared: number;
}

function entryDiffKey(entry: InputEntry): string {
  if (!entry.itemId) return "";
  return entry.partIndex === undefined ? entry.itemId : `${entry.itemId}:${entry.partIndex}`;
}

/* Compare the two requests block by block. Blocks are matched only by captured
   item id (and part index); blocks without an id are counted, never guessed. */
function layerDiffs(previous: TurnModel, current: TurnModel): LayerDiff[] {
  const before = inputEntries(previous, collectInput(asRecord(previous.record.request?.body)));
  const after = inputEntries(current, collectInput(asRecord(current.record.request?.body)));
  const beforeByKey = new Map(before.map((entry) => [entryDiffKey(entry), entry] as const).filter(([key]) => key));
  const afterKeys = new Set(after.map(entryDiffKey).filter(Boolean));
  return LAYER_ORDER.flatMap((layer) => {
    const beforeLayer = before.filter((entry) => entry.inputClass.layer === layer);
    const afterLayer = after.filter((entry) => entry.inputClass.layer === layer);
    if (!beforeLayer.length && !afterLayer.length) return [];
    const rows: LayerDiff["rows"] = [];
    for (const entry of afterLayer) {
      const key = entryDiffKey(entry);
      if (!key) continue;
      const earlier = beforeByKey.get(key);
      if (!earlier) rows.push({ change: "added", entry });
      else if (stableValue(earlier.part ?? earlier.item) !== stableValue(entry.part ?? entry.item)) rows.push({ change: "changed", entry });
    }
    for (const entry of beforeLayer) {
      const key = entryDiffKey(entry);
      if (key && !afterKeys.has(key)) rows.push({ change: "removed", entry });
    }
    const uncompared = [...beforeLayer, ...afterLayer].filter((entry) => !entryDiffKey(entry)).length;
    return [{ after: sumTokens(afterLayer)?.tokens, before: sumTokens(beforeLayer)?.tokens, layer, rows, uncompared }];
  });
}

function entryPreview(entry: InputEntry): string {
  if (entry.part !== undefined) return sectionPreview(entry.inputClass.label, capturedText(entry.part));
  const kind = toolEventKind(entry.item);
  if (kind === "call") return toolCallPresentation(entry.item).preview || textValue(entry.item.name);
  if (kind === "result") {
    const result = parseToolResult(capturedText(entry.item.output ?? entry.item.content ?? entry.item.text));
    return [result.status, result.elapsed].filter(Boolean).join(" in ") || previewText(result.output);
  }
  return inputPreview(entry.item, entry.item.content, 0);
}

function tokenText(value: number | undefined): string {
  return value === undefined ? "Unknown" : value.toLocaleString();
}

function LayerDiffSection({ diff }: { diff: LayerDiff }) {
  const meta = LAYER_META[diff.layer];
  const count = (change: LayerChange) => diff.rows.filter((row) => row.change === change).length;
  const delta = diff.before !== undefined && diff.after !== undefined ? diff.after - diff.before : undefined;
  const summary = <>
    <span aria-hidden="true" className="size-2.5 shrink-0 rounded-sm" style={{ background: meta.color }}/>
    <strong className="text-xs">{meta.title}</strong>
    {count("added") ? <Pill>+{count("added")} added</Pill> : null}
    {count("changed") ? <Pill tone="system">{count("changed")} changed</Pill> : null}
    {count("removed") ? <Pill>{count("removed")} removed</Pill> : null}
    {!diff.rows.length ? <span className="text-xs text-muted">{diff.uncompared ? "No matched changes" : "Unchanged"}</span> : null}
    <span className="ml-auto shrink-0 font-mono text-xs text-muted">{tokenText(diff.before)} → <span className="text-ink">{tokenText(diff.after)}</span>{delta ? ` (${delta > 0 ? "+" : ""}${delta.toLocaleString()})` : ""}</span>
  </>;
  if (!diff.rows.length && !diff.uncompared) return <div className="flex min-h-11 items-center gap-2 rounded-control border border-line px-3 py-2">{summary}</div>;
  return <Disclosure summary={summary}>
    <ul className="divide-y divide-line text-xs">
      {diff.rows.map(({ change, entry }) => <li className="flex items-center gap-2 py-2" key={`${change}-${entry.key}`}>
        <CategorySwatch label={entry.inputClass.label} layer={entry.inputClass.layer}/>
        <span className="shrink-0 font-medium">{entry.inputClass.label}</span>
        <Pill tone={change === "changed" ? "system" : "neutral"}>{change}</Pill>
        <span className="min-w-0 flex-1 truncate text-muted">{entryPreview(entry)}</span>
        {entry.tokens ? <span className="shrink-0 font-mono text-xs text-muted">{entry.tokens.tokens.toLocaleString()}</span> : null}
      </li>)}
      {diff.uncompared ? <li className="py-2 text-muted">{diff.uncompared} {diff.uncompared === 1 ? "block has" : "blocks have"} no captured id, so {diff.uncompared === 1 ? "it is" : "they are"} not compared.</li> : null}
    </ul>
  </Disclosure>;
}

function RequestChanges({ previous, current }: { previous: TurnModel | undefined; current: TurnModel }) {
  if (!previous) return <div className="p-8 text-center"><strong className="text-sm">No previous turn</strong><p className="mt-1 text-xs text-muted">Choose Turn 2 or later to compare captured requests.</p></div>;

  const previousBody = asRecord(previous.record.request?.body);
  const currentBody = asRecord(current.record.request?.body);
  const previousReasoning = asRecord(previousBody.reasoning);
  const currentReasoning = asRecord(currentBody.reasoning);
  const facts = [
    ["User input", previous.title, current.title],
    ["Model", textValue(previousBody.model) || "Unknown", textValue(currentBody.model) || "Unknown"],
    ["Endpoint", `${previous.method} ${previous.path}`.trim(), `${current.method} ${current.path}`.trim()],
    ["Input items", String(collectInput(previousBody).length), String(collectInput(currentBody).length)],
    ["Tool definitions", String(requestToolNames(previousBody).length), String(requestToolNames(currentBody).length)],
    ["Reasoning effort", textValue(previousReasoning.effort) || "Unavailable", textValue(currentReasoning.effort) || "Unavailable"],
  ].filter(([, before, after]) => before !== after);
  const keys = [...new Set([...Object.keys(previousBody), ...Object.keys(currentBody)])];
  const changedFields = keys.filter((key) => stableValue(previousBody[key]) !== stableValue(currentBody[key]));
  const diffs = layerDiffs(previous, current);

  return <div className="space-y-4 p-3 sm:p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-sm font-semibold">Turn {previous.label} → Turn {current.label}</h3><p className="mt-1 text-xs text-muted">Only captured request differences are shown.</p></div><Pill>{changedFields.length} changed fields</Pill></div>
    {facts.length ? <dl className="divide-y divide-line overflow-hidden rounded-control border border-line">{facts.map(([label, before, after]) => <div className="grid gap-1 px-3 py-3 text-xs sm:grid-cols-[8rem_minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-start" key={label}>
      <dt className="font-medium text-muted">{label}</dt><dd className="min-w-0 break-words font-mono text-xs text-muted">{before}</dd><span aria-hidden="true" className="hidden text-muted sm:block">→</span><dd className="min-w-0 break-words font-mono text-xs text-ink">{after}</dd>
    </div>)}</dl> : <div className="rounded-control border border-dashed border-line p-6 text-center text-xs text-muted">No high-level request changes detected.</div>}
    <section className="space-y-2"><h4 className="text-xs font-semibold">Input by layer</h4>{diffs.map((diff) => <LayerDiffSection diff={diff} key={diff.layer}/>)}</section>
    {changedFields.length ? <Disclosure summary={<><strong className="text-xs">Changed request fields</strong><span className="text-xs text-muted">Exact top-level evidence</span></>}><div className="flex flex-wrap gap-1.5">{changedFields.map((field) => <Pill key={field}>{field}</Pill>)}</div></Disclosure> : null}
  </div>;
}

interface EnvironmentFacts {
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

function accessCounts(facts: EnvironmentFacts): string {
  const counts = new Map<string, number>();
  for (const entry of facts.entries) counts.set(entry.access, (counts.get(entry.access) || 0) + 1);
  return [...counts].map(([access, count]) => `${access} ${count}`).join(" · ");
}

/* Field names whose value differs from the nearest earlier Environment block. */
function environmentChanges(value: string, previous: string | undefined): string[] {
  if (!previous) return [];
  const facts = parseEnvironment(value);
  const earlier = parseEnvironment(previous);
  if (!facts || !earlier) return [];
  const before = new Map(earlier.fields);
  const changed = facts.fields.filter(([key, item]) => before.has(key) && before.get(key) !== item).map(([key]) => (ENVIRONMENT_FIELDS[key] || humanizeField(key)).toLowerCase());
  if (stableValue(facts.entries) !== stableValue(earlier.entries) || stableValue(facts.roots) !== stableValue(earlier.roots)) changed.push("file system");
  return changed;
}

function EnvironmentView({ previous, value }: { previous?: string; value: string }) {
  const facts = useMemo(() => parseEnvironment(value), [value]);
  const earlier = useMemo(() => (previous ? parseEnvironment(previous) : null), [previous]);
  if (!facts) return <ContentPart value={value}/>;
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
      <div className="mt-2 overflow-hidden rounded-lg border border-line"><table className="w-full table-fixed text-left text-xs"><tbody className="divide-y divide-line">{facts.entries.map((entry, index) => <tr key={`${entry.target}-${index}`}><td className="w-20 px-3 py-1.5 align-top"><Pill tone={entry.access === "deny" ? "danger" : "neutral"}>{entry.access}</Pill></td><td className="break-all px-3 py-1.5 font-mono text-ink">{entry.target}{entry.special ? <span className="ml-2 font-sans text-xs text-muted">special</span> : null}{entry.escalatable === "false" ? <span className="ml-2 font-sans text-xs text-muted">not escalatable</span> : null}</td></tr>)}</tbody></table></div>
    </details> : null}
  </div>;
}

function parseAgentsMd(value: string): { body: string; path: string } | null {
  const heading = /^# AGENTS\.md instructions(?: for ([^\n]+))?\s*\n/i.exec(value);
  const wrapped = /<INSTRUCTIONS>([\s\S]*?)(?:<\/INSTRUCTIONS>|$)/i.exec(value)?.[1];
  if (!heading && wrapped === undefined) return null;
  return { body: (wrapped ?? value.slice(heading?.[0].length || 0)).trim(), path: heading?.[1]?.trim() || "" };
}

function ReadableText({ value }: { value: string }) {
  return <div className="max-h-[36rem] overflow-auto rounded-lg bg-canvas/60 px-4 py-3"><RichText>{value}</RichText></div>;
}

/* Harness sections arrive wrapped in one pseudo-XML tag; the section label already
   names it, so render only its body. The exact text remains in Tree and Raw. */
function unwrapSection(value: string): string {
  const match = /^\s*<([A-Za-z][\w -]*)>\s*\n?([\s\S]*?)\n?\s*<\/\1>\s*$/.exec(value);
  return match ? match[2] : value;
}

function sectionPreview(label: string, value: string): string {
  if (label === "Environment") {
    const facts = parseEnvironment(value);
    if (facts) return facts.fields.map(([, item]) => item).filter(Boolean).join(" · ");
  }
  if (label === "AGENTS.md") {
    const parsed = parseAgentsMd(value);
    if (parsed) return parsed.path || previewText(parsed.body.replace(/<!--[\s\S]*?-->/g, ""));
  }
  // Previews read as prose: drop markdown heading and emphasis markers.
  return previewText(unwrapSection(value).replace(/^\s*#{1,6}\s+/gm, "").replace(/\*\*|__/g, ""));
}

function SectionContent({ label, previous, value }: { label: string; previous?: string; value: unknown }) {
  const text = typeof value === "string" ? value : textValue(asRecord(value).text);
  if (!text) return <ContentPart value={value}/>;
  if (label === "Environment") return <EnvironmentView previous={previous} value={text}/>;
  if (label === "AGENTS.md") {
    const parsed = parseAgentsMd(text);
    if (parsed) return <ReadableText value={parsed.body}/>;
  }
  const body = unwrapSection(text);
  return parseStructuredText(body) ? <StructuredText>{body}</StructuredText> : <ReadableText value={body}/>;
}

interface InputEntry {
  blockId?: string;
  inputClass: InputClass;
  item: UnknownRecord;
  itemId: string;
  key: string;
  part?: unknown;
  partIndex?: number;
  /* The tool result answering this call, when the entry is a call. */
  result?: InputEntry;
  /* State shown on the row; omitted when every item is new so rows stay quiet. */
  rowState?: ItemState;
  state?: ItemState;
  tokens?: { cached: number; tokens: number };
}

function isMessagePartItem(message: UnknownRecord): boolean {
  return !toolEventKind(message) && Boolean(textValue(message.role)) && textValue(message.type) !== "additional_tools";
}

function tokenIndex(turn: TurnModel): Map<string, { cached: number; tokens: number }> {
  const index = new Map<string, { cached: number; tokens: number }>();
  for (const category of turn.categories) {
    if (category.layer === "unknown") continue;
    const itemId = splitBlockId(category.id).itemId;
    for (const key of new Set([category.id, `item:${itemId}`])) {
      const current = index.get(key) || { cached: 0, tokens: 0 };
      index.set(key, { cached: current.cached + category.cached, tokens: current.tokens + category.tokens });
    }
  }
  return index;
}

function inputEntries(turn: TurnModel, items: unknown[]): InputEntry[] {
  const tokens = tokenIndex(turn);
  const entries: InputEntry[] = items.flatMap((raw, itemIndex) => {
    const item = asRecord(raw);
    const itemId = textValue(item.id);
    const state = itemId ? turn.itemStates[itemId] : undefined;
    const key = itemId || `item-${itemIndex}`;
    if (!isMessagePartItem(item)) {
      return [{ blockId: itemId || undefined, inputClass: classifyInput(item), item, itemId, key, state, tokens: itemId ? tokens.get(`item:${itemId}`) : undefined }];
    }
    const parts = inputItemParts(item);
    return parts.map((part, partIndex) => {
      const blockId = itemId ? `${itemId}:${partIndex}` : undefined;
      const partTokens = blockId ? tokens.get(blockId) ?? (parts.length === 1 ? tokens.get(`item:${itemId}`) : undefined) : undefined;
      return { blockId, inputClass: classifyInput(item, part, partIndex), item, itemId, key: `${key}:${partIndex}`, part, partIndex, state, tokens: partTokens };
    });
  });
  const mixed = entries.some((entry) => entry.state && entry.state !== "new");
  return entries.map((entry) => ({ ...entry, rowState: mixed ? entry.state : undefined }));
}

function sumTokens(entries: InputEntry[]): { cached: number; tokens: number } | undefined {
  const known = entries.filter((entry) => entry.tokens);
  if (!known.length) return undefined;
  return known.reduce((sum, entry) => ({ cached: sum.cached + (entry.tokens?.cached || 0), tokens: sum.tokens + (entry.tokens?.tokens || 0) }), { cached: 0, tokens: 0 });
}

function entryBlockIds(entries: Array<InputEntry | undefined>): string[] {
  return entries.flatMap((entry) => {
    if (!entry?.itemId) return [];
    if (entry.part !== undefined) return entry.blockId ? [entry.blockId] : [];
    const parts = inputItemParts(entry.item);
    return [entry.itemId, ...parts.map((_, index) => `${entry.itemId}:${index}`)];
  });
}

/* Block ids a selection points at in this turn. A whole-layer selection returns none:
   it highlights its section instead of individual rows. */
function selectionIds(selection: TokenSelection | null, turnId: string, focusOnly = false): string[] {
  if (!selection || selection.turnId !== turnId || selection.layer) return [];
  return focusOnly ? [selection.blockId] : selection.blockIds || [selection.blockId];
}

function entryHit(entry: InputEntry | undefined, ids: string[]): boolean {
  if (!entry?.itemId || !ids.length) return false;
  if (entry.part !== undefined) return ids.some((id) => id === entry.blockId || id === entry.itemId);
  return ids.some((id) => id === entry.itemId || id.startsWith(`${entry.itemId}:`));
}

function selectionHits(entries: Array<InputEntry | undefined>, selection: TokenSelection | null, turnId: string): boolean {
  const ids = selectionIds(selection, turnId);
  return entries.some((entry) => entryHit(entry, ids));
}

/* How a row reflects the shared selection: matching rows take their category color,
   the focused block opens, and everything else in the turn steps back. */
function rowMarks(entries: Array<InputEntry | undefined>, label: string, layer: InputLayer, selection: TokenSelection | null, turnId: string): { accent?: string; dimmed: boolean; open: boolean } {
  const ids = selectionIds(selection, turnId);
  const matched = entries.some((entry) => entryHit(entry, ids));
  return {
    accent: matched ? categoryColor(label, layer) : undefined,
    dimmed: ids.length > 0 && !matched,
    open: entries.some((entry) => entryHit(entry, selectionIds(selection, turnId, true))),
  };
}

const ICON_PATHS: Record<string, string> = {
  book: "M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5zM5 19.5A1.5 1.5 0 0 0 6.5 21H19M9 7h6",
  chat: "M4 5h12v9H9l-5 4zM16 9h4v9l-3-2.5h-6V14",
  history: "M4 12a8 8 0 1 0 2.4-5.7L4 8.5M4 4v4.5h4.5M12 8v4l2.5 2",
  pin: "M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  question: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01",
  sliders: "M6 4v16M12 4v16M18 4v16M4 9h4M10 15h4M16 7h4",
  sparkle: "M12 4l1.8 4.7L18.5 10.5 13.8 12.3 12 17l-1.8-4.7L5.5 10.5l4.7-1.8zM18 16l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z",
  terminal: "M4 5h16v14H4zM8 10l2.5 2L8 14M13 14h3",
  tool: "M14.5 5.5a4 4 0 0 0 4.9 4.9L12 17.8 9.2 20.6a2 2 0 0 1-2.8-2.8L9.2 15 16.6 7.6a4 4 0 0 0-2.1-2.1z",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM5 20a7 7 0 0 1 14 0",
};

const LAYER_ICONS: Record<InputLayer, string> = {
  capabilities: "tool",
  instructions: "book",
  context: "pin",
  conversation: "chat",
  unknown: "question",
};

function Icon({ color, name }: { color?: string; name: string }) {
  return <svg aria-hidden="true" className="size-[18px] shrink-0 text-muted" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} style={color ? { color } : undefined} viewBox="0 0 24 24"><path d={ICON_PATHS[name]}/></svg>;
}

type BadgeTone = "new" | "changed" | "neutral" | "danger";

function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: BadgeTone }) {
  const tones: Record<BadgeTone, string> = {
    changed: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
    danger: "bg-red-100 text-danger dark:bg-red-950",
    neutral: "bg-canvas text-muted",
    new: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  };
  return <span className={`whitespace-nowrap rounded-md px-2 py-0.5 font-mono text-xs ${tones[tone]}`}>{children}</span>;
}

function StateBadge({ state }: { state?: ItemState }) {
  if (state === "new") return <Badge tone="new">new</Badge>;
  if (state === "changed") return <Badge tone="changed">changed</Badge>;
  return null;
}

/* Right-aligned token column shared by section headers and rows. */
function RowEnd({ badge, tokens }: { badge?: ReactNode; tokens?: { cached: number; tokens: number } }) {
  return <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
    {tokens ? <span className="font-mono text-xs tabular-nums text-ink" title={`${tokens.tokens.toLocaleString()} tokens · ${tokens.cached.toLocaleString()} cached`}>{tokens.tokens.toLocaleString()}</span> : null}
    {badge}
  </span>;
}

/* The row's one leading mark: a category swatch, or an icon tinted with the category
   color. It also links the row's blocks to Composition and Token flow. */
function LinkSwatch({ blockIds, icon, label, layer, onSelectToken, selection, turnId }: { blockIds: string[]; icon?: string; label: string; layer: InputLayer; onSelectToken: (selection: TokenSelection | null) => void; selection: TokenSelection | null; turnId: string }) {
  const selectedIds = selection?.turnId === turnId ? selection.blockIds || [selection.blockId] : [];
  const active = blockIds.some((id) => selectedIds.includes(id));
  const mark = icon ? <Icon color={categoryColor(label, layer)} name={icon}/> : <CategorySwatch label={label} layer={layer}/>;
  if (!blockIds.length) return <span className="grid size-5 shrink-0 place-items-center">{mark}</span>;
  return <button aria-label={active ? `Unlink ${label}` : `Link ${label} in the charts`} aria-pressed={active} className={`grid size-5 shrink-0 place-items-center rounded ${active ? "ring-2 ring-ink" : "hover:ring-1 hover:ring-line"}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); onSelectToken(active ? null : { blockId: blockIds[0], blockIds, label, turnId }); }} title={`${label} · link in charts`} type="button">{mark}</button>;
}

/* Invisible scroll targets for one or more captured blocks; the row carries the highlight. */
function BlockAnchor({ blockIds, children, turnId }: { blockIds: string[]; children: ReactNode; turnId: string }) {
  return <div className="relative scroll-m-32" data-block-anchor="">
    {blockIds.map((id) => <span className="absolute left-0 top-0 size-px opacity-0" data-block-id={id} data-turn-id={turnId} key={id} tabIndex={-1}/>)}
    {children}
  </div>;
}

/* Flat disclosure row: chevron on the left, summary in one line, body indented under it. */
/* Flat accordion row: chevron on the left, summary in one line, body indented under it. */
function Row({ accent, children, defaultOpen = false, dimmed = false, hint, summary }: { accent?: string; children?: ReactNode; defaultOpen?: boolean; dimmed?: boolean; hint?: string; summary: ReactNode }) {
  const { mounted, open, toggle } = useAccordion(defaultOpen);
  // A selected row carries its category color as a left bar and a light tint.
  const mark = accent ? { backgroundColor: `color-mix(in srgb, ${accent} 9%, transparent)`, boxShadow: `inset 3px 0 0 ${accent}` } : undefined;
  const fade = dimmed ? "opacity-45 hover:opacity-100" : "";
  if (children === undefined) return <div className={`t-fade flex min-h-11 items-center gap-2.5 py-2 pl-10 pr-3 text-sm sm:pr-4 ${fade}`} style={mark} title={hint}>{summary}</div>;
  return <div className="t-acc" data-open={open ? "true" : "false"}>
    <div aria-expanded={open} className={`t-acc-head t-fade flex min-h-11 cursor-pointer items-center gap-2.5 px-3 py-2 text-sm outline-none hover:bg-canvas/70 focus-visible:bg-canvas sm:px-4 ${fade}`} onClick={toggle} onKeyDown={(event) => activateOnKey(event, toggle)} role="button" style={mark} tabIndex={0} title={hint}>
      <span aria-hidden="true" className={`t-acc-chevron w-3 shrink-0 text-center text-xs ${open ? "text-muted" : "text-muted/60"}`}>›</span>
      {summary}
    </div>
    {mounted ? <div className="t-acc-panel"><div className="t-acc-panel-inner"><div className="pb-4 pl-[3.25rem] pr-3 pt-1 sm:pr-4">{children}</div></div></div> : null}
  </div>;
}

function Meta({ children, mono = false }: { children: ReactNode; mono?: boolean }) {
  return <span className={`min-w-0 flex-1 truncate text-xs text-muted ${mono ? "font-mono text-xs" : ""}`}>{children}</span>;
}

function StateSummary({ entries }: { entries: InputEntry[] }) {
  const counts = { carried: 0, changed: 0, new: 0 };
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.state || seen.has(entry.itemId)) continue;
    seen.add(entry.itemId);
    counts[entry.state] += 1;
  }
  if (!seen.size) return null;
  if (!counts.new && !counts.changed) return <Badge>unchanged</Badge>;
  return <>{counts.changed ? <Badge tone="changed">{counts.changed} changed</Badge> : null}{counts.new ? <Badge tone="new">+{counts.new} new</Badge> : null}</>;
}

function LayerSection({ badge, children, entries, layer, selection, turnId }: { badge?: ReactNode; children: ReactNode; entries: InputEntry[]; layer: InputLayer; selection: TokenSelection | null; turnId: string }) {
  const meta = LAYER_META[layer];
  const picked = selection?.turnId === turnId && selection.layer === layer;
  const dimmed = selection?.turnId === turnId && Boolean(selection.layer) && !picked;
  // A selected layer takes its own color; the other layers step back while it is selected.
  const ring = picked ? { borderColor: meta.color, boxShadow: `0 0 0 3px color-mix(in srgb, ${meta.color} 18%, transparent)` } : undefined;
  return <section aria-label={meta.title} className={`scroll-m-24 overflow-hidden rounded-control border bg-panel transition ${picked ? "" : "border-line"} ${dimmed ? "opacity-50 hover:opacity-100" : ""}`} data-layer={layer} data-turn-id={turnId} style={ring} tabIndex={-1}>
    <header className="flex min-h-12 items-center gap-2.5 bg-canvas/60 px-3 py-2 sm:px-4">
      <Icon color={meta.color} name={LAYER_ICONS[layer]}/>
      <h3 className="shrink-0 text-base font-semibold">{meta.title}</h3>
      <Meta>{meta.description}</Meta>
      <RowEnd badge={badge ?? <StateSummary entries={entries}/>} tokens={sumTokens(entries)}/>
    </header>
    <div className="divide-y divide-line border-t border-line">{children}</div>
  </section>;
}

interface RowProps {
  defaultOpen?: boolean;
  onSelectToken: (selection: TokenSelection | null) => void;
  selection: TokenSelection | null;
  turnId: string;
}

function toolSignature(tool: UnknownRecord): string {
  const format = asRecord(tool.format);
  if (format.type === "grammar") return `grammar · ${textValue(format.syntax) || "custom"}`;
  const schema = asRecord(tool.parameters ?? tool.input_schema);
  const properties = Object.keys(asRecord(schema.properties));
  const required = new Set(asArray(schema.required).map(textValue));
  if (!properties.length) return textValue(tool.type) === "custom" ? "free-form input" : "()";
  const shown = properties.slice(0, 4).map((name) => (required.has(name) ? name : `${name}?`));
  return `(${shown.join(", ")}${properties.length > 4 ? `, …${properties.length - 4}` : ""})`;
}

function ToolDefinitionRow({ entry, onSelectToken, selection, tools, turnId }: RowProps & { entry?: InputEntry; tools: unknown }) {
  const groups = toolGroups(tools);
  const total = groups.reduce((sum, group) => sum + group.tools.length, 0);
  const blockIds = entry?.blockId ? [entry.blockId] : [];
  if (!total) return null;
  const marks = rowMarks([entry], "Tool definitions", "capabilities", selection, turnId);
  return <Row accent={marks.accent} defaultOpen={marks.open} dimmed={marks.dimmed} summary={<>
    <LinkSwatch blockIds={blockIds} label="Tool definitions" layer="capabilities" onSelectToken={onSelectToken} selection={selection} turnId={turnId}/>
    <span className="min-w-0 flex-1 truncate">{groups.map((group, index) => <span key={group.name}>{index ? <span className="text-muted"> · </span> : null}<span className="font-mono text-sm text-ink">{group.name}</span> <span className="text-xs text-muted">{group.tools.length}</span></span>)}</span>
    <RowEnd badge={<StateBadge state={entry?.rowState}/>} tokens={entry?.tokens}/>
  </>}>
    <BlockAnchor blockIds={blockIds} turnId={turnId}>
      <div className="space-y-3">{groups.map((group) => <section key={group.name}>
        {groups.length > 1 ? <h4 className="mb-1 font-mono text-xs text-muted">{group.name}</h4> : null}
        <ul>{group.tools.map((tool, index) => {
          const name = textValue(tool.name) || `Tool ${index + 1}`;
          const description = textValue(tool.description);
          const schema = tool.parameters ?? tool.input_schema ?? tool.format;
          return <li key={`${name}-${index}`} style={{ containIntrinsicSize: "0 28px", contentVisibility: "auto" }}><details>
            <summary className="grid cursor-pointer list-none grid-cols-[minmax(6rem,12rem)_minmax(0,1fr)] gap-3 rounded px-1 py-1 font-mono text-xs hover:bg-canvas/70 [&::-webkit-details-marker]:hidden"><span className="truncate text-ink">{name}</span><span className="truncate text-muted">{toolSignature(tool)}</span></summary>
            <div className="mb-2 ml-1 mt-1 space-y-2 border-l-2 border-line pl-3">
              {description ? <p className="whitespace-pre-wrap text-xs leading-5 text-muted">{description}</p> : null}
              {schema ? <details><summary className="cursor-pointer text-xs font-medium text-muted hover:text-ink">Schema</summary><div className="mt-2"><JsonBlock value={schema}/></div></details> : null}
            </div>
          </details></li>;
        })}</ul>
      </section>)}</div>
    </BlockAnchor>
  </Row>;
}

function contentKind(entry: InputEntry): string {
  const kinds = asRecord(entry.item.internal_chat_message_metadata_passthrough).content_item_kinds;
  return Array.isArray(kinds) && entry.partIndex !== undefined ? textValue(kinds[entry.partIndex]) : "";
}

/* A short identifying fact for a row, never a prose preview: the declared content
   kind, the wrapper tag, or a heading that says more than the label. */
function sectionFact(entry: InputEntry, text: string): { mono: boolean; value: string } {
  const label = entry.inputClass.label;
  if (label === "Environment" || label === "AGENTS.md") return { mono: false, value: sectionPreview(label, text) };
  if (label === "Assistant messages") return { mono: false, value: [textValue(entry.item.phase).replaceAll("_", " "), previewText(text)].filter(Boolean).join(" · ") };
  const kind = contentKind(entry);
  if (kind) return { mono: true, value: kind };
  const tag = /^\s*<([A-Za-z][\w -]*)>/.exec(text)?.[1];
  if (tag && unwrapSection(text) !== text) return { mono: true, value: tag };
  const heading = /^\s*#{1,6}\s+([^\n]+)/.exec(text)?.[1]?.trim();
  if (heading && heading.toLowerCase() !== label.toLowerCase()) return { mono: false, value: heading };
  return { mono: false, value: "" };
}

function PartRow({ defaultOpen = false, entry, onSelectToken, previous, selection, turnId }: RowProps & { entry: InputEntry; previous?: string }) {
  const label = entry.inputClass.label;
  const text = capturedText(entry.part);
  const isPrompt = label === "User prompt";
  const fact = sectionFact(entry, text);
  const blockIds = entry.blockId ? [entry.blockId] : [];
  const changes = label === "Environment" ? environmentChanges(text, previous) : [];
  const badge = changes.length ? <Badge tone="changed">{changes.length === 1 ? `${changes[0]} changed` : `${changes.length} fields changed`}</Badge> : <StateBadge state={entry.rowState}/>;
  const marks = rowMarks([entry], label, entry.inputClass.layer, selection, turnId);
  return <Row accent={marks.accent} defaultOpen={defaultOpen || marks.open} dimmed={marks.dimmed} hint={isPrompt ? undefined : sectionPreview(label, text)} summary={<>
    <LinkSwatch blockIds={blockIds} icon={isPrompt ? "user" : label === "Assistant messages" ? "chat" : undefined} label={label} layer={entry.inputClass.layer} onSelectToken={onSelectToken} selection={selection} turnId={turnId}/>
    {isPrompt ? <span className="min-w-0 flex-1 truncate font-medium text-ink">{previewText(entry.part) || "Empty prompt"}</span> : <>
      <span className="shrink-0 text-ink">{label === "Assistant messages" ? "Assistant" : label}</span>
      <Meta mono={fact.mono}>{fact.value}</Meta>
    </>}
    <RowEnd badge={badge} tokens={entry.tokens}/>
  </>}>
    <BlockAnchor blockIds={blockIds} turnId={turnId}><SectionContent label={label} previous={previous} value={entry.part}/></BlockAnchor>
  </Row>;
}

function reasoningSummary(item: UnknownRecord): string {
  return asArray(item.summary).map((part) => textValue(asRecord(part).text) || textValue(part)).filter(Boolean).join("\n\n");
}

function ReasoningRow({ entry, onSelectToken, selection, turnId }: RowProps & { entry: InputEntry }) {
  const summary = reasoningSummary(entry.item);
  const encrypted = Boolean(textValue(entry.item.encrypted_content));
  const blockIds = entryBlockIds([entry]);
  const detail = [encrypted ? "encrypted" : "", summary ? previewText(summary) : "no summary"].filter(Boolean).join(" · ");
  const marks = rowMarks([entry], "Reasoning", "conversation", selection, turnId);
  return <Row accent={marks.accent} defaultOpen={marks.open} dimmed={marks.dimmed} summary={<>
    <LinkSwatch blockIds={blockIds} icon="sparkle" label="Reasoning" layer="conversation" onSelectToken={onSelectToken} selection={selection} turnId={turnId}/>
    <span className="shrink-0 text-ink">Reasoning</span>
    <Meta>{detail}</Meta>
    <RowEnd badge={<StateBadge state={entry.rowState}/>} tokens={entry.tokens}/>
  </>}>
    <BlockAnchor blockIds={blockIds} turnId={turnId}>{summary ? <ReadableText value={summary}/> : <p className="text-xs text-muted">{encrypted ? "The model's reasoning was sent back encrypted. No readable summary was captured." : "No readable reasoning was captured."}</p>}</BlockAnchor>
  </Row>;
}

const CALL_SOURCE_KEYS = ["code", "cmd", "command", "source", "script", "query", "input"];

function CallInput({ value }: { value: unknown }) {
  if (typeof value === "string") return <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-canvas px-3 py-2 font-mono text-xs leading-5 text-ink">{value}</pre>;
  const record = asRecord(value);
  const sourceKey = CALL_SOURCE_KEYS.find((key) => typeof record[key] === "string");
  const rest = Object.entries(record).filter(([key]) => key !== sourceKey);
  if (!sourceKey && !rest.length) return <p className="text-xs text-muted">No captured input.</p>;
  return <div className="space-y-2">
    {sourceKey ? <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-canvas px-3 py-2 font-mono text-xs leading-5 text-ink">{textValue(record[sourceKey])}</pre> : null}
    {rest.length ? <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">{rest.map(([key, item]) => <div className="contents" key={key}><dt className="text-muted">{humanizeField(key)}</dt><dd className="min-w-0 break-words font-mono text-xs text-ink">{item && typeof item === "object" ? <StructuredValue value={item}/> : formatToolField(key, item) || (item === null ? "null" : "Unknown")}</dd></div>)}</dl> : null}
  </div>;
}

function callSource(message: UnknownRecord, input: unknown): string {
  const field = message.arguments !== undefined ? "arguments" : "input";
  const key = CALL_SOURCE_KEYS.find((candidate) => typeof asRecord(input)[candidate] === "string");
  return key ? `${field}.${key}` : field;
}

function BlockHeading({ children, tokens }: { children: ReactNode; tokens?: { cached: number; tokens: number } }) {
  return <div className="mb-1.5 flex items-baseline justify-between gap-3 text-xs text-muted"><span className="min-w-0 truncate">{children}</span>{tokens ? <span className="shrink-0 font-mono">{tokens.tokens.toLocaleString()} tok</span> : null}</div>;
}

function ToolExchangeRow({ call, onSelectToken, result, selection, turnId }: RowProps & { call?: InputEntry; result?: InputEntry }) {
  const callItem = call?.item;
  const resultItem = result?.item;
  const presentation = callItem ? toolCallPresentation(callItem) : null;
  const outcome = resultItem ? parseToolResult(capturedText(resultItem.output ?? resultItem.content ?? resultItem.text)) : null;
  const failed = Boolean(outcome && /failed|error|timed out/i.test(outcome.status));
  const namespace = textValue(callItem?.namespace);
  const title = textValue(asRecord(presentation?.input).title) || presentation?.preview || outcome?.status || "";
  const tokens = sumTokens([call, result].filter((entry): entry is InputEntry => Boolean(entry)));
  const blockIds = entryBlockIds([call, result]);
  const state = result?.rowState ?? call?.rowState;
  const resultParts = resultItem ? inputItemParts(resultItem).length : 0;
  const marks = rowMarks([call, result], result && selectionHits([result], selection, turnId) ? "Tool results" : "Tool calls", "conversation", selection, turnId);
  return <Row accent={marks.accent} defaultOpen={marks.open} dimmed={marks.dimmed} summary={<>
    <LinkSwatch blockIds={blockIds} icon="terminal" label={call ? "Tool calls" : "Tool results"} layer="conversation" onSelectToken={onSelectToken} selection={selection} turnId={turnId}/>
    <span className="shrink-0 font-mono text-sm text-ink">{namespace ? <span className="text-muted">{namespace}.</span> : null}{presentation?.name || "Tool result"}</span>
    <Meta>{title}</Meta>
    <RowEnd badge={failed ? <Badge tone="danger">failed</Badge> : <StateBadge state={state}/>} tokens={tokens}/>
  </>}>
    <div className="space-y-4">
      {call && callItem && presentation ? <BlockAnchor blockIds={entryBlockIds([call])} turnId={turnId}>
        <BlockHeading tokens={call.tokens}>Call · {callSource(callItem, presentation.input)}{presentation.wrapperName ? ` · ${presentation.wrapperName}` : ""}</BlockHeading>
        <CallInput value={presentation.input}/>
      </BlockAnchor> : null}
      {result && resultItem && outcome ? <BlockAnchor blockIds={entryBlockIds([result])} turnId={turnId}>
        <BlockHeading tokens={result.tokens}>{["Result", outcome.status, outcome.elapsed && `wall ${outcome.elapsed}`, resultParts > 1 ? `${resultParts} parts` : ""].filter(Boolean).join(" · ")}</BlockHeading>
        <ToolOutputView value={outcome.output}/>
      </BlockAnchor> : <p className="text-xs text-muted">The result is not part of this request.</p>}
    </div>
  </Row>;
}

function GenericRow({ entry, onSelectToken, selection, turnId }: RowProps & { entry: InputEntry }) {
  const blockIds = entryBlockIds([entry]);
  const marks = rowMarks([entry], entry.inputClass.label, entry.inputClass.layer, selection, turnId);
  return <Row accent={marks.accent} defaultOpen={marks.open} dimmed={marks.dimmed} summary={<>
    <LinkSwatch blockIds={blockIds} label={entry.inputClass.label} layer={entry.inputClass.layer} onSelectToken={onSelectToken} selection={selection} turnId={turnId}/>
    <span className="shrink-0 text-ink">{entry.inputClass.label}</span>
    <Meta mono>{textValue(entry.item.type) || "input"}</Meta>
    <RowEnd badge={<StateBadge state={entry.rowState}/>} tokens={entry.tokens}/>
  </>}>
    <BlockAnchor blockIds={blockIds} turnId={turnId}>{inputItemParts(entry.item).map((part, index) => <ContentPart key={index} value={part}/>)}</BlockAnchor>
  </Row>;
}

/* Join each tool call with the result carrying its call_id so the pair reads as one
   exchange. Only a result that follows its call is joined; anything else stays a row. */
function pairToolExchanges(entries: InputEntry[]): InputEntry[] {
  const results = new Map<string, InputEntry>();
  for (const entry of entries) {
    const callId = textValue(entry.item.call_id ?? entry.item.tool_use_id);
    if (entry.part === undefined && toolEventKind(entry.item) === "result" && callId && !results.has(callId)) results.set(callId, entry);
  }
  const placed = new Set<InputEntry>();
  const paired: InputEntry[] = [];
  for (const entry of entries) {
    if (placed.has(entry)) continue;
    placed.add(entry);
    const callId = textValue(entry.item.call_id ?? entry.item.id);
    const result = entry.part === undefined && toolEventKind(entry.item) === "call" && callId ? results.get(callId) : undefined;
    if (result && !placed.has(result)) {
      placed.add(result);
      paired.push({ ...entry, result });
    } else paired.push(entry);
  }
  return paired;
}

function EntryRow({ entry, previous, ...props }: RowProps & { entry: InputEntry; previous?: string }) {
  if (entry.part !== undefined) return <PartRow entry={entry} previous={previous} {...props}/>;
  const kind = toolEventKind(entry.item);
  if (kind === "call") return <ToolExchangeRow call={entry} result={entry.result} {...props}/>;
  if (kind === "result") return <ToolExchangeRow result={entry} {...props}/>;
  if (entry.inputClass.label === "Reasoning") return <ReasoningRow entry={entry} {...props}/>;
  return <GenericRow entry={entry} {...props}/>;
}

/* Describe carried rows the way they read: tool exchanges by tool name, then the rest. */
function carriedSummary(rows: InputEntry[]): string {
  const counts = new Map<string, number>();
  for (const entry of rows) {
    const kind = entry.part === undefined ? toolEventKind(entry.item) : null;
    const name = kind === "call" ? toolCallPresentation(entry.item).name
      : kind === "result" ? "tool result"
        : entry.inputClass.label === "Assistant messages" ? "assistant message"
          : entry.inputClass.label.toLowerCase();
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts].map(([name, count]) => `${count} ${name}`).join(", ");
}

function ConversationRows({ entries, lastPromptKey, ...props }: RowProps & { entries: InputEntry[]; lastPromptKey: string }) {
  const carried = entries.filter((entry) => entry.state === "carried" && entry.key !== lastPromptKey);
  const current = entries.filter((entry) => !carried.includes(entry));
  const carriedTokens = sumTokens(carried);
  const carriedItems = new Set(carried.map((entry) => entry.itemId || entry.key)).size;
  const fullyCached = carriedTokens && carriedTokens.tokens > 0 && carriedTokens.cached >= carriedTokens.tokens;
  const cacheBadge = carriedTokens && carriedTokens.tokens > 0 ? <Badge>{fullyCached ? "cached" : `${Math.round((carriedTokens.cached / carriedTokens.tokens) * 100)}% cached`}</Badge> : null;
  const carriedRows = pairToolExchanges(carried);
  // Keep the prompt that started this query first, even when it was carried over.
  const prompt = current.filter((entry) => entry.key === lastPromptKey);
  const rest = current.filter((entry) => entry.key !== lastPromptKey);
  return <>
    {prompt.map((entry) => <EntryRow entry={entry} key={entry.key} {...props}/>)}
    {carried.length ? <Row defaultOpen={selectionHits(carried, props.selection, props.turnId)} dimmed={selectionIds(props.selection, props.turnId).length > 0 && !selectionHits(carried, props.selection, props.turnId)} summary={<>
      <span className="grid size-5 shrink-0 place-items-center"><Icon name="history"/></span>
      <span className="shrink-0 text-ink">Carried over</span>
      <Meta>{carriedItems} {carriedItems === 1 ? "item" : "items"} · {carriedSummary(carriedRows)}</Meta>
      <RowEnd badge={cacheBadge} tokens={carriedTokens}/>
    </>}><NestedRows>{carriedRows.map((entry) => <EntryRow entry={entry} key={entry.key} {...props}/>)}</NestedRows></Row> : null}
    {pairToolExchanges(rest).map((entry) => <EntryRow entry={entry} key={entry.key} {...props}/>)}
  </>;
}

function NestedRows({ children }: { children: ReactNode }) {
  return <div className="-ml-7 divide-y divide-line overflow-hidden rounded-lg border border-line">{children}</div>;
}

/* Rows below 5% of their section's tokens collapse into one line when there are at
   least three of them. Changed rows and the Environment stay visible on their own. */
function groupMinorRows(entries: InputEntry[]): Array<InputEntry | InputEntry[]> {
  const total = sumTokens(entries)?.tokens || 0;
  const minor = (entry: InputEntry) => Boolean(entry.tokens && total && entry.tokens.tokens < total * 0.05 && entry.state !== "changed" && entry.inputClass.label !== "Environment");
  const group = entries.filter(minor);
  if (group.length < 3) return entries;
  const rows: Array<InputEntry | InputEntry[]> = [];
  for (const entry of entries) {
    if (!minor(entry)) rows.push(entry);
    else if (entry === group[0]) rows.push(group);
  }
  return rows;
}

function MinorRowsGroup({ entries, ...props }: RowProps & { entries: InputEntry[] }) {
  const labels = [...new Set(entries.map((entry) => entry.inputClass.label))];
  const matched = entries.find((entry) => selectionHits([entry], props.selection, props.turnId));
  return <Row accent={matched ? categoryColor(matched.inputClass.label, matched.inputClass.layer) : undefined} defaultOpen={Boolean(matched)} dimmed={selectionIds(props.selection, props.turnId).length > 0 && !matched} summary={<>
    <span className="flex shrink-0 -space-x-1">{labels.slice(0, 4).map((label) => <span className="rounded-[4px] ring-2 ring-panel" key={label}><CategorySwatch label={label} layer={entries[0].inputClass.layer}/></span>)}</span>
    <span className="min-w-0 flex-1 truncate text-ink">{labels.join(" · ")}</span>
    <RowEnd badge={<StateBadge state={entries.find((entry) => entry.rowState)?.rowState}/>} tokens={sumTokens(entries)}/>
  </>}><NestedRows>{entries.map((entry) => <EntryRow entry={entry} key={entry.key} {...props}/>)}</NestedRows></Row>;
}

function shortId(value: unknown): string {
  const text = textValue(value);
  return text.length > 14 ? `${text.slice(0, 10)}…` : text;
}

function RequestSettings({ body, record }: { body: UnknownRecord; record: TraceRecord }) {
  const reasoning = asRecord(body.reasoning);
  const text = asRecord(body.text);
  const format = asRecord(text.format);
  const metadata = asRecord(body.client_metadata);
  const includes = asArray(body.include).map(textValue).filter(Boolean);
  const chips = [
    reasoning.effort ? `reasoning ${[reasoning.effort, reasoning.context].filter(Boolean).map(textValue).join(" · ")}` : "",
    text.verbosity ? `verbosity ${textValue(text.verbosity)}` : "",
    body.tool_choice ? `tools ${textValue(body.tool_choice)}${body.parallel_tool_calls ? " · parallel" : ""}` : "",
    format.type ? `output ${textValue(format.name ?? format.type)}` : "",
    body.prompt_cache_key ? `cache key ${shortId(body.prompt_cache_key)}` : "",
    body.previous_response_id ? `previous ${shortId(body.previous_response_id)}` : "",
    metadata["x-openai-subagent"] ? `subagent ${textValue(metadata["x-openai-subagent"])}` : "",
  ].filter(Boolean);
  const groups: Array<[string, Array<[string, unknown]>]> = [
    ["Generation", [
      ["Reasoning effort", reasoning.effort],
      ["Reasoning context", reasoning.context],
      ["Reasoning summary", reasoning.summary],
      ["Verbosity", text.verbosity],
      ["Output format", format.name ?? format.type],
      ["Tool choice", body.tool_choice],
      ["Parallel tool calls", body.parallel_tool_calls],
      ["Streaming", body.stream],
      ["Included output", includes.join(", ") || undefined],
    ]],
    ["Cache and chaining", [
      ["Store", body.store],
      ["Prompt cache key", body.prompt_cache_key],
      ["Previous response", body.previous_response_id],
    ]],
    ["Identity", [
      ["Thread", metadata.thread_id],
      ["Session", metadata.session_id],
      ["Turn", metadata.turn_id],
      ["Parent thread", metadata["x-codex-parent-thread-id"]],
      ["Subagent", metadata["x-openai-subagent"]],
      ["Transport", record.transport],
    ]],
  ];
  const visible = groups.map(([title, facts]) => [title, facts.filter(([, value]) => value !== undefined && value !== null && value !== "")] as const).filter(([, facts]) => facts.length);
  if (!visible.length) return null;
  return <section aria-label="Request settings" className="overflow-hidden rounded-control border border-line bg-panel">
    <header className="flex min-h-12 items-center gap-2.5 bg-canvas/60 px-3 py-2 sm:px-4">
      <Icon name="sliders"/>
      <h3 className="shrink-0 text-base font-semibold">Request settings</h3>
      <Meta>No input tokens</Meta>
    </header>
    <div className="divide-y divide-line border-t border-line">
      {chips.length ? <div className="flex flex-wrap gap-1.5 px-3 py-2.5 sm:px-4">{chips.map((chip) => <Badge key={chip}>{chip}</Badge>)}</div> : null}
      <Row summary={<span className="text-muted">All settings</span>}>
        <div className="space-y-4">{visible.map(([title, facts]) => <section key={title}><h4 className="mb-1.5 text-xs font-medium text-muted">{title}</h4><dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">{facts.map(([label, value]) => <div className="contents" key={label}><dt className="text-muted">{label}</dt><dd className="min-w-0 break-all font-mono text-xs text-ink">{typeof value === "boolean" ? (value ? "on" : "off") : textValue(value) || "configured"}</dd></div>)}</dl></section>)}</div>
      </Row>
    </div>
  </section>;
}

/* Text of the nearest earlier Environment block, for field-level comparison. */
function earlierEnvironment(earlierTurns: TurnModel[]): string | undefined {
  for (let index = earlierTurns.length - 1; index >= 0; index -= 1) {
    for (const raw of collectInput(asRecord(earlierTurns[index].record.request?.body))) {
      const item = asRecord(raw);
      if (!isMessagePartItem(item)) continue;
      const parts = inputItemParts(item);
      for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
        if (classifyInput(item, parts[partIndex], partIndex).label === "Environment") return capturedText(parts[partIndex]);
      }
    }
  }
  return undefined;
}

function RequestHeader({ turn }: { turn: TurnModel }) {
  const record = turn.record;
  const status = Number(record.response?.status || 0);
  const route = record.transport || `${record.request?.method || ""} ${record.request?.path || ""}`.trim();
  const facts = [`Turn ${turn.label}`, turn.model, route, status ? String(status) : "", turn.durationMs ? formatDuration(turn.durationMs) : ""].filter(Boolean);
  return <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1 pb-1">
    <h3 className="min-w-0 max-w-full truncate text-lg font-semibold tracking-[-0.01em]">{turn.queryText || turn.title}</h3>
    <span className={`text-xs ${status >= 400 ? "text-danger" : "text-muted"}`}>{facts.join(" · ")}</span>
    <span className="ml-auto font-mono text-xs text-muted">{turn.input ? <>{formatNumber(turn.input)} in · {formatNumber(turn.cached)} cached · <span className="text-ink">{formatNumber(turn.fresh)} new</span></> : "Token usage unknown"}</span>
  </div>;
}

function StructuredRequest({ earlierTurns, onSelectToken, selection, turn }: { earlierTurns: TurnModel[]; onSelectToken: (selection: TokenSelection | null) => void; selection: TokenSelection | null; turn: TurnModel }) {
  const record = turn.record;
  const turnId = turn.id;
  const body = asRecord(record.request?.body);
  const input = useMemo(() => collectInput(body), [body]);
  const entries = useMemo(() => inputEntries(turn, input), [turn, input]);
  const previousEnvironment = useMemo(() => earlierEnvironment(earlierTurns), [earlierTurns]);
  const topLevelTools = asArray(body.tools);
  const byLayer = new Map<InputLayer, InputEntry[]>();
  for (const entry of entries) byLayer.set(entry.inputClass.layer, [...(byLayer.get(entry.inputClass.layer) || []), entry]);
  const lastPromptKey = [...entries].reverse().find((entry) => entry.inputClass.label === "User prompt")?.key || "";
  const hasContent = entries.length > 0 || topLevelTools.length > 0;
  const rowProps = { onSelectToken, selection, turnId };
  const contextChanges = (byLayer.get("context") || []).filter((entry) => entry.inputClass.label === "Environment" && environmentChanges(capturedText(entry.part), previousEnvironment).length).length;

  return <div className="space-y-4 p-3 sm:p-4">

    {LAYER_ORDER.map((layer) => {
      const layerEntries = byLayer.get(layer) || [];
      if (layer === "capabilities") {
        if (!layerEntries.length && !topLevelTools.length) return null;
        return <LayerSection entries={layerEntries} key={layer} layer={layer} selection={selection} turnId={turnId}>
          {topLevelTools.length ? <ToolDefinitionRow tools={topLevelTools} {...rowProps}/> : null}
          {layerEntries.map((entry) => <ToolDefinitionRow entry={entry} key={entry.key} tools={entry.item.tools} {...rowProps}/>)}
        </LayerSection>;
      }
      if (!layerEntries.length) return null;
      const badge = layer === "context" && contextChanges ? <Badge tone="changed">{contextChanges} changed</Badge> : undefined;
      return <LayerSection badge={badge} entries={layerEntries} key={layer} layer={layer} selection={selection} turnId={turnId}>
        {layer === "conversation"
          ? <ConversationRows entries={layerEntries} lastPromptKey={lastPromptKey} {...rowProps}/>
          : groupMinorRows(layerEntries).map((row) => Array.isArray(row)
            ? <MinorRowsGroup entries={row} key={`minor-${layer}`} {...rowProps}/>
            : <EntryRow entry={row} key={row.key} previous={previousEnvironment} {...rowProps}/>)}
      </LayerSection>;
    })}

    {!hasContent ? <div className="rounded-control border border-dashed border-line p-5 text-center text-xs text-muted">No message content was captured.</div> : null}

    {selection?.turnId === turnId && selection.label === "Unattributed input" ? <div className="rounded-control border border-dashed border-line p-4 text-xs text-muted"><strong className="text-ink">No exact request section</strong><p className="mt-1">This remainder was not attributed to a captured input block, so Token Flow does not guess a destination.</p></div> : null}

    <RequestSettings body={body} record={record}/>
  </div>;
}

function RequestBody({ earlierTurns, focusPath, mode, onSelectToken, selection, turn }: { earlierTurns: TurnModel[]; focusPath?: JsonPathPart[] | null; mode: RequestMode; onSelectToken: (selection: TokenSelection | null) => void; selection: TokenSelection | null; turn: TurnModel }) {
  const record = turn.record;
  const turnId = turn.id;
  const selectedPath = useMemo(() => focusPath || selectedJsonPath(record, selection, turnId), [focusPath, record, selection, turnId]);
  if (mode === "structured") return <StructuredRequest earlierTurns={earlierTurns} onSelectToken={onSelectToken} selection={selection} turn={turn}/>;
  return <div className="p-3 sm:p-4"><div className="overflow-hidden rounded-control border border-line"><RawJsonTree selectedBlockId={selection?.turnId === turnId ? selection.blockId : undefined} selectedPath={selectedPath} turnId={turnId} value={record}/></div></div>;
}


type InspectorJump = TokenSelection & { nonce: number; path?: JsonPathPart[]; query?: string };

/* The shared selection, named in its category color. A category that spans several
   blocks can be stepped through here; each step opens and scrolls to that block. */
function SelectionChip({ onJump, onSelectToken, selection }: { onJump: (selection: TokenSelection) => void; onSelectToken: (selection: TokenSelection | null) => void; selection: TokenSelection }) {
  // Step by captured item, not by attribution part: one tool result can span several parts.
  const ids: string[] = [];
  for (const id of selection.layer ? [] : selection.blockIds || [selection.blockId]) {
    if (!ids.some((known) => splitBlockId(known).itemId === splitBlockId(id).itemId)) ids.push(id);
  }
  const position = Math.max(0, ids.findIndex((id) => splitBlockId(id).itemId === splitBlockId(selection.blockId).itemId));
  const move = (delta: number) => {
    const next = { ...selection, blockId: ids[(position + delta + ids.length) % ids.length] };
    onSelectToken(next);
    onJump(next);
  };
  return <span className="tf-control inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-canvas pl-2.5 pr-1 text-xs">
    <CategorySwatch label={selection.label} layer={selection.layer}/>
    <span className="max-w-40 truncate font-medium text-ink">{selection.label}{selection.layer ? " layer" : ""}</span>
    {ids.length > 1 ? <span className="flex items-center font-mono text-xs text-muted">
      <button aria-label="Previous matching block" className="grid size-11 place-items-center rounded-full hover:bg-panel hover:text-ink" onClick={() => move(-1)} type="button">‹</button>
      {position + 1}/{ids.length}
      <button aria-label="Next matching block" className="grid size-11 place-items-center rounded-full hover:bg-panel hover:text-ink" onClick={() => move(1)} type="button">›</button>
    </span> : null}
    <button aria-label="Clear selection" className="grid size-11 place-items-center rounded-full text-muted hover:bg-panel hover:text-ink" onClick={() => onSelectToken(null)} type="button">×</button>
  </span>;
}

function SearchResults({ current, hits, onPick, query }: { current: number; hits: SearchHit[]; onPick: (index: number) => void; query: string }) {
  return <div className="t-dropdown-enter border-t border-line">
    <div className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs text-muted sm:px-4">
      <span>{hits.length >= SEARCH_HIT_LIMIT ? `${SEARCH_HIT_LIMIT}+` : hits.length} {hits.length === 1 ? "match" : "matches"}{current >= 0 ? ` · ${current + 1} of ${hits.length}` : ""}</span>
      <span className="hidden sm:inline">Enter next · Shift+Enter previous · Esc clears</span>
    </div>
    {hits.length ? <ol className="max-h-64 overflow-y-auto border-t border-line">{hits.map((hit, index) => <li key={hit.key}>
      <button aria-current={index === current ? "true" : undefined} className={`grid w-full gap-0.5 px-3 py-2 text-left hover:bg-canvas/70 sm:px-4 ${index === current ? "bg-canvas" : ""}`} onClick={() => onPick(index)} type="button">
        <span className="flex min-w-0 items-center gap-2 text-xs">
          <i className="size-2.5 shrink-0 rounded-[3px]" style={{ background: hit.color || "var(--line)" }}/>
          <span className="truncate font-medium text-ink">{hit.location}</span>
          <code className="ml-auto hidden max-w-[45%] truncate font-mono text-xs text-muted sm:block">{hit.pathText.replace(/^trace\.?/, "")}</code>
        </span>
        <span className="truncate pl-[18px] text-xs text-muted">{hit.before}<mark className="rounded-sm bg-warning/40 px-0.5 text-ink">{hit.match}</mark>{hit.after}</span>
      </button>
    </li>)}</ol> : <p className="border-t border-line px-4 py-3 text-xs text-muted">Nothing in this turn&apos;s captured request or response contains “{query}”.</p>}
  </div>;
}

/* The turn level of the workspace: one selected turn's request, beside the flow. */
export function RequestView({ jumpToBlock, onNavigate, onSelectToken, selection, turn, turns }: { jumpToBlock: (TokenSelection & { nonce: number }) | null; onNavigate: (index: number | null) => void; onSelectToken: (selection: TokenSelection | null) => void; selection: TokenSelection | null; turn: TurnModel; turns: TurnModel[] }) {
  const [scope, setScope] = useState<RequestScope>("turn");
  const [mode, setMode] = useState<RequestMode>("structured");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState({ index: -1, query: "" });
  const [listOpen, setListOpen] = useState(true);
  const [localJump, setLocalJump] = useState<InspectorJump | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const rangesRef = useRef<Range[]>([]);
  const selectedIndex = turns.findIndex((item) => item.id === turn.id);
  const previous = selectedIndex > 0 ? turns[selectedIndex - 1] : undefined;
  // Page side-by-side: a later turn slides in from the right, an earlier one from the left.
  const [shownIndex, setShownIndex] = useState(selectedIndex);
  const [direction, setDirection] = useState(1);
  if (selectedIndex !== shownIndex) {
    setDirection(selectedIndex > shownIndex ? 1 : -1);
    setShownIndex(selectedIndex);
  }
  const searching = scope === "turn" && query.trim().length >= MIN_QUERY;
  const hits = useMemo(() => (searching ? searchRecord(turn.record, query) : []), [query, searching, turn.record]);
  const current = cursor.query === query ? cursor.index : -1;
  // The newest request to reveal something wins, whether it came from the flow or from here.
  const jump = [jumpToBlock as InspectorJump | null, localJump]
    .filter((item): item is InspectorJump => Boolean(item && item.turnId === turn.id))
    .sort((left, right) => right.nonce - left.nonce)[0] || null;

  // Mark every visible occurrence, and keep marking as rows open and close.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !searching) {
      clearHighlights();
      rangesRef.current = [];
      return;
    }
    // A new query drops the previous jump's emphasis; reapplying after DOM changes keeps it.
    clearCurrentMatch();
    let timer = 0;
    const run = () => { rangesRef.current = highlightMatches(body, query); };
    run();
    const observer = new MutationObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(run, 120);
    });
    observer.observe(body, { characterData: true, childList: true, subtree: true });
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [mode, query, searching, turn.id]);
  useEffect(() => () => clearHighlights(), []);

  useEffect(() => {
    if (!jump || scope === "changes") return;
    const frame = window.requestAnimationFrame(() => {
      const body = bodyRef.current;
      if (!body) return;
      const target = jump.path
        ? body.querySelector<HTMLElement>('[data-json-selected="true"]')
        : [...body.querySelectorAll<HTMLElement>(jump.layer ? "[data-layer]" : "[data-block-id]")].find((element) => element.dataset.turnId === jump.turnId && (jump.layer ? element.dataset.layer === jump.layer : element.dataset.blockId === jump.blockId));
      if (!target) return;
      if (jump.query) {
        rangesRef.current = highlightMatches(body, jump.query);
        focusMatch(jump.path ? target : target.closest("[data-block-anchor]") ?? target, rangesRef.current);
      } else target.scrollIntoView({ behavior: "smooth", block: jump.layer ? "start" : "center" });
      target.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [jump, mode, scope]);

  const step = (delta: number) => {
    const next = selectedIndex + delta;
    if (next >= 0 && next < turns.length) onNavigate(next);
  };
  // A match inside a structured block opens that block; anything else opens in Raw at its path.
  const goTo = (index: number) => {
    const hit = hits[index];
    if (!hit) return;
    setCursor({ index, query });
    // On narrow screens the result list would cover the match, so fold it after a jump.
    if (window.matchMedia("(max-width: 1023px)").matches) setListOpen(false);
    const reveal = { nonce: Date.now(), query, turnId: turn.id };
    if (mode === "structured" && hit.blockId) {
      const next: TokenSelection = { blockId: hit.blockId, blockIds: [hit.blockId], label: hit.label, turnId: turn.id };
      onSelectToken(next);
      setLocalJump({ ...next, ...reveal });
    } else {
      // Raw locations have no node in the flow, so the flow selection is cleared.
      onSelectToken(null);
      setMode("raw");
      setLocalJump({ blockId: "", label: hit.label, path: hit.path, ...reveal });
    }
  };
  const onSearchKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setQuery("");
    } else if (event.key === "Enter" && hits.length) {
      event.preventDefault();
      goTo((current + (event.shiftKey ? -1 : 1) + hits.length) % hits.length);
    }
  };

  return <section aria-label={`Turn ${turn.label}`} className="rounded-panel border border-line bg-panel shadow-sm">
    <div className="sticky top-0 z-20 rounded-t-2xl border-b border-line bg-panel lg:top-14" data-search-ignore="">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 sm:px-4">
        <button className="tf-control inline-flex items-center gap-1.5 rounded-control px-2 text-sm font-medium text-muted hover:bg-canvas hover:text-ink" onClick={() => onNavigate(null)} type="button">← Overview</button>
        <div className="flex items-center gap-1">
          <button aria-label="Previous turn" className="tf-icon-control grid place-items-center rounded-control text-muted hover:bg-canvas hover:text-ink disabled:opacity-30" disabled={selectedIndex <= 0} onClick={() => step(-1)} type="button">‹</button>
          <span className="font-mono text-xs text-muted">{selectedIndex + 1} / {turns.length}</span>
          <button aria-label="Next turn" className="tf-icon-control grid place-items-center rounded-control text-muted hover:bg-canvas hover:text-ink disabled:opacity-30" disabled={selectedIndex >= turns.length - 1} onClick={() => step(1)} type="button">›</button>
        </div>
        {selection?.turnId === turn.id ? <SelectionChip onJump={(next) => setLocalJump({ ...next, nonce: Date.now() })} onSelectToken={onSelectToken} selection={selection}/> : null}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {scope === "turn" ? <Segmented label="Request format" onChange={setMode} options={[["structured", "Structured"], ["raw", "Raw"]]} value={mode}/> : null}
          <Segmented label="Request scope" onChange={setScope} options={[["turn", "This turn"], ["changes", "Changes"]]} value={scope}/>
        </div>
      </div>
      {scope === "turn" ? <div className="flex items-center gap-2 px-3 pb-2.5 sm:px-4">
        <label className="relative block min-w-0 flex-1">
          <span className="sr-only">Search this turn</span>
          <SearchIcon className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted"/>
          <input className="tf-control w-full rounded-control border border-line bg-canvas pl-8 pr-8 text-sm outline-none placeholder:text-muted focus:border-muted" onChange={(event) => { setQuery(event.target.value); setListOpen(true); }} onKeyDown={onSearchKey} placeholder="Search this turn's request and response" type="search" value={query}/>
          {query ? <button aria-label="Clear search" className="absolute right-0.5 top-0 grid size-11 place-items-center text-sm text-muted hover:text-ink" onClick={() => setQuery("")} type="button">×</button> : null}
        </label>
        {searching && hits.length ? <button aria-expanded={listOpen} className="tf-control shrink-0 rounded-control px-2 text-sm font-medium text-muted hover:bg-canvas hover:text-ink" onClick={() => setListOpen(!listOpen)} type="button">{listOpen ? "Hide list" : `Show ${hits.length}`}</button> : null}
      </div> : null}
      {searching && listOpen ? <SearchResults current={current} hits={hits} onPick={goTo} query={query}/> : null}
    </div>
    <div className="t-page-enter" key={turn.id} ref={bodyRef} style={{ "--t-page-dir": direction } as React.CSSProperties}>
      <div className="px-3 pt-3 sm:px-4 sm:pt-4"><RequestHeader turn={turn}/></div>
      {scope === "changes" ? <RequestChanges current={turn} previous={previous}/> : <RequestBody earlierTurns={turns.slice(0, Math.max(0, selectedIndex))} focusPath={mode === "raw" ? jump?.path : null} mode={mode} onSelectToken={onSelectToken} selection={selection} turn={turn}/>}
    </div>
  </section>;
}
