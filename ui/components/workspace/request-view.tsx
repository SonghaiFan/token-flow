"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Streamdown, type Components } from "streamdown";
import { categoryLabelForInput } from "@/lib/token-model";
import type { TokenSelection, TraceRecord, TurnModel } from "@/lib/types";
import { RawJsonTree } from "./raw-json-tree";

type UnknownRecord = Record<string, unknown>;
type RequestMode = "structured" | "tree" | "raw";
type RequestScope = "turn" | "changes" | "conversation";

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
  pre: ({ children }) => <pre className="my-3 max-h-[32rem] overflow-auto rounded-lg border border-line bg-canvas p-3 font-mono text-[11px] leading-5">{children}</pre>,
};

const JsonTreeView = dynamic(() => import("./json-tree-view").then((module) => module.JsonTreeView), {
  loading: () => <div className="border-t border-line p-8 text-center text-xs text-muted">Loading JSON tree…</div>,
  ssr: false,
});

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
  return <span className={`inline-flex max-w-full items-center whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[9px] font-medium ${tones[tone]}`}>{children}</span>;
}

function roleTone(role: string): "neutral" | "system" | "user" | "assistant" {
  if (role === "developer" || role === "system") return "system";
  if (role === "user") return "user";
  if (role === "assistant" || role === "model") return "assistant";
  return "neutral";
}

function semanticRole(message: UnknownRecord): string {
  const role = textValue(message.role).toLowerCase();
  if (role) return role;
  const type = textValue(message.type).toLowerCase();
  if (type === "reasoning" || type === "thinking") return "reasoning";
  if (type.endsWith("_call_output") || type === "tool_result" || type === "tool_output") return "tool result";
  if (type.endsWith("_call") || type === "tool_use") return "tool call";
  return "input";
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
  return <Streamdown animated={false} className="min-w-0 break-words text-[13px] text-ink" components={markdownComponents} dir="auto" mode="static">{escapeCapturedTags(children)}</Streamdown>;
}

function JsonBlock({ value }: { value: unknown }) {
  return <pre className="max-h-[28rem] overflow-auto rounded-lg border border-line bg-canvas p-3 font-mono text-[10px] leading-5 text-ink">{JSON.stringify(value, null, 2)}</pre>;
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
  return <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
    <span className="text-xs font-medium">{warning || "Captured output metadata"}</span>
    {tokenCount ? <Pill tone="system">Original {Number(tokenCount.replaceAll(",", "")).toLocaleString()} tokens</Pill> : null}
    {lineCount ? <Pill tone="system">{Number(lineCount.replaceAll(",", "")).toLocaleString()} output {Number(lineCount.replaceAll(",", "")) === 1 ? "line" : "lines"}</Pill> : null}
  </div>;
}

function ToolResultCatalog({ tools }: { tools: ToolResultDefinition[] }) {
  return <section className="overflow-hidden rounded-xl border border-line bg-canvas/40">
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-3 sm:px-4">
      <div className="min-w-0"><h4 className="text-sm font-semibold">Returned tool catalog</h4><p className="mt-0.5 text-[11px] text-muted">Tool definitions returned by this call, rendered as readable entries.</p></div>
      <Pill>{tools.length} tools</Pill>
    </div>
    <div className="space-y-2 p-2 sm:p-3">{tools.map((tool, index) => {
      const { declaration, summary } = splitToolDescription(tool.description);
      const metadata = Object.fromEntries(Object.entries(tool).filter(([key]) => key !== "name" && key !== "description"));
      return <div key={`${tool.name}-${index}`} style={{ containIntrinsicSize: "0 64px", contentVisibility: "auto" }}>
        <Disclosure summary={<div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><strong className="break-all font-mono text-[11px] text-ink">{tool.name}</strong><Pill>{textValue(tool.type) || "tool"}</Pill></div>{summary ? <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted">{summary}</p> : null}</div>}>
          <div className="space-y-3">
            {summary ? <RichText>{summary}</RichText> : null}
            {declaration ? <Disclosure summary={<><strong className="text-xs">Declaration</strong><span className="text-[11px] text-muted">Parameters and return type</span></>}><pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-lg bg-canvas p-3 font-mono text-[10px] leading-5 text-ink">{declaration}</pre></Disclosure> : null}
            {Object.keys(metadata).length ? <Disclosure summary={<><strong className="text-xs">Additional fields</strong><Pill>{Object.keys(metadata).length}</Pill></>}><JsonBlock value={metadata}/></Disclosure> : null}
          </div>
        </Disclosure>
      </div>;
    })}</div>
  </section>;
}

function StructuredValue({ value }: { value: unknown }) {
  if (Array.isArray(value) && value.length && value.every(isToolResultDefinition)) return <ToolResultCatalog tools={value}/>;
  if (Array.isArray(value)) return <section className="space-y-2"><div className="flex items-center gap-2"><strong className="text-xs">Structured list</strong><Pill>{value.length} items</Pill></div>{value.map((item, index) => <Disclosure key={index} summary={<><strong className="text-xs">Item {index + 1}</strong><span className="min-w-0 truncate text-[11px] text-muted">{previewText(item)}</span></>}><StructuredValue value={item}/></Disclosure>)}</section>;
  if (value && typeof value === "object") {
    const entries = Object.entries(asRecord(value));
    return <dl className="divide-y divide-line overflow-hidden rounded-xl border border-line">{entries.map(([key, item]) => <div className="grid gap-1 px-3 py-3 text-xs sm:grid-cols-[10rem_minmax(0,1fr)]" key={key}><dt className="break-all font-mono text-[10px] font-medium text-muted">{key}</dt><dd className="min-w-0 break-words text-ink">{item && typeof item === "object" ? <Disclosure summary={<><span className="text-xs">{Array.isArray(item) ? `${item.length} items` : `${Object.keys(asRecord(item)).length} fields`}</span><span className="min-w-0 truncate text-[11px] text-muted">{previewText(item)}</span></>}><StructuredValue value={item}/></Disclosure> : <span className="whitespace-pre-wrap">{textValue(item) || (item === null ? "null" : "")}</span>}</dd></div>)}</dl>;
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
    {parsed.recovered ? <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">Recovered {Array.isArray(parsed.value) ? parsed.value.length : 0} complete entries from truncated JSON. The incomplete final entry remains available in Raw.</div> : null}
    <StructuredValue value={parsed.value}/>
    {parsed.suffix ? <ResultNotice value={parsed.suffix}/> : null}
  </div>;
}

function TechnicalDetails({ message }: { message: UnknownRecord }) {
  const facts = [
    ["Protocol type", message.type],
    ["Status", message.status],
    ["Call ID", message.call_id ?? message.tool_use_id],
    ["Item ID", message.id],
  ].filter(([, value]) => value !== undefined && value !== "");
  if (!facts.length) return null;
  return <Disclosure summary={<><strong className="text-xs">Technical details</strong><span className="text-[11px] text-muted">Captured identifiers and protocol fields</span></>}>
    <dl className="grid gap-x-5 gap-y-3 text-xs sm:grid-cols-2">{facts.map(([label, value]) => <div key={String(label)}><dt className="text-muted">{String(label)}</dt><dd className="mt-1 break-all font-mono text-[10px] text-ink">{textValue(value)}</dd></div>)}</dl>
  </Disclosure>;
}

function ToolInputView({ value }: { value: unknown }) {
  if (typeof value === "string" && value.trim()) {
    return <section>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">Input</h4>
        <Pill>{value.split("\n").length} {value.includes("\n") ? "lines" : "line"}</Pill>
      </div>
      <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-canvas px-3 py-2.5 font-mono text-[11px] leading-5 text-ink"><code>{value}</code></pre>
    </section>;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return <div className="rounded-lg border border-dashed border-line px-3 py-3 text-xs text-muted">No captured input is available for this tool call. Use Tree or Raw to inspect the surrounding evidence.</div>;
  }
  const entries = Object.entries(asRecord(value));
  const commandEntry = entries.find(([key]) => key === "cmd" || key === "command");
  const details = entries.filter(([key]) => key !== commandEntry?.[0]);
  return <div className="space-y-3">
    {commandEntry ? <section><h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">Command</h4><div className="overflow-x-auto rounded-lg bg-canvas px-3 py-2.5 font-mono text-[11px] leading-5 text-ink"><code className="whitespace-pre-wrap break-words">{textValue(commandEntry[1])}</code></div></section> : null}
    {details.length ? <dl className="grid gap-3 sm:grid-cols-2">{details.map(([key, item]) => <div className="min-w-0" key={key}><dt className="text-[10px] font-medium text-muted">{humanizeField(key)}</dt><dd className="mt-1 min-w-0 break-words text-xs text-ink">{item && typeof item === "object" ? <Disclosure summary={<span className="text-xs">{Array.isArray(item) ? `${item.length} items` : `${Object.keys(asRecord(item)).length} fields`}</span>}><StructuredValue value={item}/></Disclosure> : <span className="font-mono text-[10px]">{formatToolField(key, item) || (item === null ? "null" : "Unknown")}</span>}</dd></div>)}</dl> : null}
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
  return <section className="overflow-hidden rounded-xl border border-line">
    <div className="border-b border-line bg-canvas/60 px-3 py-3 sm:px-4"><div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-semibold">{verification ? "Browser verification page" : "HTML document"}</h4><Pill>HTML</Pill></div><p className="mt-1 text-[11px] text-muted">{verification ? "The server returned a verification challenge instead of the requested data." : "The server returned a document instead of structured data."}</p></div>
    <div className="space-y-4 px-3 py-3 sm:px-4">
      {notice ? <div><div className="text-[10px] font-medium text-muted">Page notice</div><p className="mt-1 text-sm leading-5 text-ink">{notice}</p></div> : null}
      {facts.length ? <dl className="grid gap-x-5 gap-y-3 sm:grid-cols-2">{facts.map(([label, item]) => <div key={label}><dt className="text-[10px] font-medium text-muted">{label}</dt><dd className="mt-1 break-words font-mono text-[10px] text-ink">{item}</dd></div>)}</dl> : null}
    </div>
  </section>;
}

function TextOutput({ value }: { value: string }) {
  const lines = value.split("\n");
  if (!value) return <div className="rounded-lg border border-dashed border-line px-3 py-4 text-xs text-muted">The tool completed without captured output.</div>;
  if (/too many requests|rate limit/i.test(value)) return <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 dark:border-amber-900 dark:bg-amber-950"><strong className="text-xs text-amber-900 dark:text-amber-200">Rate limited</strong><p className="mt-1 text-xs text-amber-900 dark:text-amber-200">{value.trim()}</p></div>;
  return <section><div className="mb-1.5 flex items-center justify-between gap-3"><h4 className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">Output</h4><span className="font-mono text-[9px] text-muted">{lines.length} {lines.length === 1 ? "line" : "lines"}</span></div><ol className="max-h-[28rem] overflow-auto rounded-lg bg-canvas py-2 font-mono text-[10px] leading-5 text-ink">{lines.map((line, index) => <li className="grid grid-cols-[2.5rem_minmax(0,1fr)] px-3" key={index}><span className="select-none pr-3 text-right text-muted/70">{index + 1}</span><span className="whitespace-pre-wrap break-words">{line || " "}</span></li>)}</ol></section>;
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
  return <section><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><div><h4 className="text-xs font-semibold">Rendered Markdown</h4><p className="mt-0.5 text-[10px] text-muted">Exact source remains available in Raw.</p></div><Pill>{lineCount} {lineCount === 1 ? "line" : "lines"}</Pill></div><div className="max-h-[40rem] overflow-auto rounded-xl border border-line bg-canvas/50 px-4 py-3 sm:px-5 sm:py-4"><RichText>{value}</RichText></div></section>;
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

function ToolEventContent({ message, pairedToolName }: { message: UnknownRecord; pairedToolName?: string }) {
  const kind = toolEventKind(message);
  if (kind === "call") {
    const presentation = toolCallPresentation(message);
    return <div className="space-y-3 border-l-2 border-ink pl-3 sm:pl-4">
      <div><div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-semibold">{presentation.name}</h4>{presentation.wrapperName ? <><span className="text-xs text-muted">invokes</span><Pill>{presentation.wrapperName}</Pill></> : null}</div><p className="mt-1 text-[11px] text-muted">Captured tool invocation</p></div>
      <ToolInputView value={presentation.input}/>
      <TechnicalDetails message={message}/>
    </div>;
  }
  const rawOutput = capturedText(message.output ?? message.content ?? message.text);
  const result = parseToolResult(rawOutput);
  const failed = /failed|error|timed out/i.test(result.status);
  return <div className={`space-y-3 border-l-2 pl-3 sm:pl-4 ${failed ? "border-danger" : "border-success"}`}>
    <div className="flex flex-wrap items-start justify-between gap-2"><div><div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-semibold">{pairedToolName ? `${pairedToolName} result` : "Tool result"}</h4><Pill tone={failed ? "danger" : "assistant"}>{result.status || "Captured"}</Pill></div><p className="mt-1 text-[11px] text-muted">{result.elapsed ? `Finished in ${result.elapsed}` : "Execution output"}</p></div>{result.output ? <Pill>{result.output.split("\n").length} {result.output.split("\n").length === 1 ? "line" : "lines"}</Pill> : null}</div>
    <ToolOutputView value={result.output}/>
    <TechnicalDetails message={message}/>
  </div>;
}

function CategoryAnchor({ blockId, children, label, onSelectToken, selection, turnId }: { blockId?: string; children: ReactNode; label: string; onSelectToken: (selection: TokenSelection | null) => void; selection: TokenSelection | null; turnId: string }) {
  const selectedIds = selection?.blockIds || (selection ? [selection.blockId] : []);
  const active = Boolean(blockId && selection?.turnId === turnId && selectedIds.includes(blockId));
  return <div className={`scroll-m-32 rounded-xl transition ${active ? "ring-2 ring-ink ring-offset-2 ring-offset-panel" : ""}`} data-block-id={blockId} data-turn-id={turnId} tabIndex={active ? -1 : undefined}>
    <div className="mb-2 flex items-center gap-2">{blockId ? <button aria-pressed={active} className={`rounded-full border px-2 py-1 font-mono text-[9px] ${active ? "border-ink bg-ink text-panel" : "border-line bg-canvas text-muted"}`} onClick={() => onSelectToken(active ? null : { blockId, label, turnId })} type="button">{label}</button> : <span className="rounded-full border border-line bg-canvas px-2 py-1 font-mono text-[9px] text-muted">{label}</span>}{active ? <span className="text-[9px] font-semibold uppercase tracking-[0.12em] text-muted">Linked</span> : null}</div>
    {children}
  </div>;
}

function ToolEventAnchor({ children, itemId, message, onSelectToken, parts, selection, turnId }: { children: ReactNode; itemId: string; message: UnknownRecord; onSelectToken: (selection: TokenSelection | null) => void; parts: unknown[]; selection: TokenSelection | null; turnId: string }) {
  const selectedIds = selection?.blockIds || (selection ? [selection.blockId] : []);
  const blockIds = parts.map((_, index) => itemId ? `${itemId}:${index}` : "").filter(Boolean);
  const active = selection?.turnId === turnId && blockIds.some((blockId) => selectedIds.includes(blockId));
  return <div className={`relative scroll-m-32 rounded-xl transition ${active ? "ring-2 ring-ink ring-offset-2 ring-offset-panel" : ""}`}>
    {blockIds.map((blockId) => <span className="absolute left-0 top-0 size-px opacity-0" data-block-id={blockId} data-turn-id={turnId} key={blockId} tabIndex={-1}/>) }
    <div className="mb-2 flex flex-wrap items-center gap-2 text-[9px] text-muted"><span>Token category</span>{parts.map((part, index) => {
      const blockId = blockIds[index];
      const label = categoryLabelForInput(message, part);
      const selected = Boolean(blockId && selection?.turnId === turnId && selectedIds.includes(blockId));
      return blockId ? <button aria-pressed={selected} className={`rounded-full border px-2 py-1 font-mono text-[9px] ${selected ? "border-ink bg-ink text-panel" : "border-line bg-canvas text-muted"}`} key={blockId} onClick={() => onSelectToken(selected ? null : { blockId, label, turnId })} type="button">{parts.length > 1 ? `${label} ${index + 1}` : label}</button> : <span className="rounded-full border border-line bg-canvas px-2 py-1 font-mono text-[9px] text-muted" key={index}>{label}</span>;
    })}{active ? <span className="text-[9px] font-semibold uppercase tracking-[0.12em] text-muted">Linked</span> : null}</div>
    {children}
  </div>;
}

function Disclosure({ children, defaultOpen = false, summary }: { children: ReactNode; defaultOpen?: boolean; summary: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return <details className="group rounded-xl border border-line bg-panel" onToggle={(event) => setOpen(event.currentTarget.open)} open={open}>
    <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-2 hover:bg-canvas/70">{summary}<span aria-hidden="true" className="ml-auto text-xs text-muted transition group-open:rotate-90">›</span></summary>
    {open ? <div className="border-t border-line px-3 py-3 sm:px-4">{children}</div> : null}
  </details>;
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

function MessageItem({ item, index, defaultOpen, onSelectToken, pairedToolName, selection, turnId }: { item: unknown; index: number; defaultOpen: boolean; onSelectToken: (selection: TokenSelection | null) => void; pairedToolName?: string; selection: TokenSelection | null; turnId: string }) {
  const message = asRecord(item);
  const role = semanticRole(message);
  const type = textValue(message.type) || "message";
  const eventKind = toolEventKind(message);
  const parts = inputItemParts(message);
  const content = parts.length === 1 ? parts[0] : parts;
  const itemId = textValue(message.id);
  const callPresentation = eventKind === "call" ? toolCallPresentation(message) : null;
  const result = eventKind === "result" ? parseToolResult(capturedText(message.output ?? message.content ?? message.text)) : null;
  const preview = callPresentation?.preview || (result ? [result.status, result.elapsed].filter(Boolean).join(" in ") : inputPreview(message, content, index));
  const selectedIds = selection?.blockIds || (selection ? [selection.blockId] : []);
  const selectedItem = selection?.turnId === turnId && Boolean(itemId) && selectedIds.some((id) => id === itemId || id.startsWith(`${itemId}:`));
  const eventName = callPresentation?.name || pairedToolName;
  return <Disclosure defaultOpen={defaultOpen || selectedItem} summary={<><Pill tone={roleTone(role)}>{role}</Pill>{eventKind ? <strong className="text-xs text-ink">{eventName || (eventKind === "call" ? "Unknown tool" : "Tool result")}</strong> : <Pill>{type}</Pill>}{eventKind && message.status ? <Pill tone={textValue(message.status).toLowerCase() === "completed" ? "assistant" : "neutral"}>{textValue(message.status)}</Pill> : null}{result?.elapsed ? <Pill>{result.elapsed}</Pill> : null}<span className="min-w-0 truncate text-xs text-muted">{preview}</span></>}>
    {eventKind ? <ToolEventAnchor itemId={itemId} message={message} onSelectToken={onSelectToken} parts={parts} selection={selection} turnId={turnId}><ToolEventContent message={message} pairedToolName={pairedToolName}/></ToolEventAnchor> : <div className="space-y-3">{parts.map((part, partIndex) => <CategoryAnchor blockId={itemId ? `${itemId}:${partIndex}` : undefined} key={partIndex} label={categoryLabelForInput(message, part)} onSelectToken={onSelectToken} selection={selection} turnId={turnId}><ContentPart value={part}/></CategoryAnchor>)}</div>}
  </Disclosure>;
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

function ToolCatalog({ blockId, onSelectToken, selection, turnId, value }: { blockId?: string; onSelectToken: (selection: TokenSelection | null) => void; selection: TokenSelection | null; turnId: string; value: unknown }) {
  const groups = toolGroups(value);
  const total = groups.reduce((sum, group) => sum + group.tools.length, 0);
  if (!total) return null;
  return <CategoryAnchor blockId={blockId} label="Tool definitions" onSelectToken={onSelectToken} selection={selection} turnId={turnId}><Disclosure summary={<><strong className="text-sm">Tools</strong><Pill>{total} definitions</Pill><span className="text-xs text-muted">{groups.length} {groups.length === 1 ? "group" : "groups"}</span></>}>
    <div className="space-y-2">{groups.map((group) => <Disclosure key={group.name} summary={<><strong className="text-xs">{group.name}</strong><Pill>{group.tools.length}</Pill></>}>
      <div className="divide-y divide-line">{group.tools.map((tool, index) => {
        const name = textValue(tool.name) || `Tool ${index + 1}`;
        const description = textValue(tool.description);
        const schema = tool.parameters ?? tool.input_schema ?? tool.format;
        return <div className="py-3 first:pt-0 last:pb-0" key={`${name}-${index}`}>
          <div className="flex flex-wrap items-center gap-2"><strong className="font-mono text-[11px]">{name}</strong><Pill>{textValue(tool.type) || "function"}</Pill></div>
          {description ? <p className="mt-1 line-clamp-3 text-xs leading-5 text-muted">{description}</p> : null}
          {schema ? <details className="mt-2"><summary className="cursor-pointer text-[10px] font-medium text-muted hover:text-ink">Schema</summary><div className="mt-2"><JsonBlock value={schema}/></div></details> : null}
        </div>;
      })}</div>
    </Disclosure>)}</div>
  </Disclosure></CategoryAnchor>;
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

function toolNamesByCallId(items: unknown[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const item of items) {
    const message = asRecord(item);
    if (toolEventKind(message) !== "call") continue;
    const callId = textValue(message.call_id ?? message.id);
    if (!callId) continue;
    names.set(callId, toolCallPresentation(message).name);
  }
  return names;
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

  return <div className="space-y-4 p-3 sm:p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-sm font-semibold">Turn {previous.label} → Turn {current.label}</h3><p className="mt-1 text-xs text-muted">Only captured request differences are shown.</p></div><Pill>{changedFields.length} changed fields</Pill></div>
    {facts.length ? <dl className="divide-y divide-line overflow-hidden rounded-xl border border-line">{facts.map(([label, before, after]) => <div className="grid gap-1 px-3 py-3 text-xs sm:grid-cols-[8rem_minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-start" key={label}>
      <dt className="font-medium text-muted">{label}</dt><dd className="min-w-0 break-words font-mono text-[10px] text-muted">{before}</dd><span aria-hidden="true" className="hidden text-muted sm:block">→</span><dd className="min-w-0 break-words font-mono text-[10px] text-ink">{after}</dd>
    </div>)}</dl> : <div className="rounded-xl border border-dashed border-line p-6 text-center text-xs text-muted">No high-level request changes detected.</div>}
    {changedFields.length ? <Disclosure summary={<><strong className="text-xs">Changed request fields</strong><span className="text-xs text-muted">Exact top-level evidence</span></>}><div className="flex flex-wrap gap-1.5">{changedFields.map((field) => <Pill key={field}>{field}</Pill>)}</div></Disclosure> : null}
  </div>;
}

function StructuredRequest({ onSelectToken, record, selection, turnId }: { onSelectToken: (selection: TokenSelection | null) => void; record: TraceRecord; selection: TokenSelection | null; turnId: string }) {
  const request = record.request || {};
  const body = asRecord(request.body);
  const reasoning = asRecord(body.reasoning);
  const text = asRecord(body.text);
  const format = asRecord(text.format);
  const input = collectInput(body);
  const embeddedToolItems = input.filter((item) => asRecord(item).type === "additional_tools");
  const messageItems = input.filter((item) => asRecord(item).type !== "additional_tools");
  const pairedToolNames = toolNamesByCallId(messageItems);
  const topLevelTools = asArray(body.tools);
  const includes = asArray(body.include).map(textValue).filter(Boolean);
  const status = Number(record.response?.status || 0);
  let lastUserIndex = -1;
  messageItems.forEach((item, index) => { if (asRecord(item).role === "user") lastUserIndex = index; });
  return <div className="space-y-4 p-3 sm:p-4">
    <div className="flex flex-wrap gap-1.5">
      <Pill>{textValue(body.model) || "Unknown model"}</Pill>
      <Pill>{request.method || "REQUEST"} {request.path || "Unknown endpoint"}</Pill>
      {record.transport ? <Pill>{record.transport}</Pill> : null}
      {body.stream !== undefined ? <Pill>{body.stream ? "streaming" : "not streaming"}</Pill> : null}
      {reasoning.effort ? <Pill>reasoning: {textValue(reasoning.effort)}</Pill> : null}
      {body.tool_choice ? <Pill>tools: {textValue(body.tool_choice) || "configured"}</Pill> : null}
      {format.type ? <Pill>output: {textValue(format.type)}</Pill> : null}
      {status ? <Pill tone={status >= 400 ? "danger" : "neutral"}>HTTP {status}</Pill> : null}
    </div>

    {includes.length ? <section><h3 className="mb-2 text-xs font-semibold text-muted">Included output</h3><div className="flex flex-wrap gap-1.5">{includes.map((item) => <Pill key={item}>{item}</Pill>)}</div></section> : null}

    {topLevelTools.length ? <ToolCatalog onSelectToken={onSelectToken} selection={selection} turnId={turnId} value={topLevelTools}/> : null}
    {embeddedToolItems.map((item, index) => <ToolCatalog blockId={textValue(asRecord(item).id)} key={`embedded-tools-${index}`} onSelectToken={onSelectToken} selection={selection} turnId={turnId} value={asRecord(item).tools}/>)}

    <section>
      <div className="mb-2 flex items-baseline justify-between gap-3"><h3 className="text-sm font-semibold">Input</h3><span className="font-mono text-[10px] text-muted">{messageItems.length} {messageItems.length === 1 ? "item" : "items"}</span></div>
      {messageItems.length ? <div className="space-y-2">{messageItems.map((item, index) => <MessageItem defaultOpen={index === lastUserIndex} index={index} item={item} key={textValue(asRecord(item).id) || index} onSelectToken={onSelectToken} pairedToolName={pairedToolNames.get(textValue(asRecord(item).call_id ?? asRecord(item).tool_use_id))} selection={selection} turnId={turnId}/>)}</div> : <div className="rounded-xl border border-dashed border-line p-5 text-center text-xs text-muted">No message content was captured.</div>}
    </section>

    {selection?.turnId === turnId && selection.label === "Unattributed input" ? <div className="rounded-xl border border-dashed border-line p-4 text-xs text-muted"><strong className="text-ink">No exact request section</strong><p className="mt-1">This remainder was not attributed to a captured input block, so Token Flow does not guess a destination.</p></div> : null}

    <Disclosure summary={<><strong className="text-xs">Request options</strong><span className="text-xs text-muted">Cache, output format, and client metadata</span></>}>
      <dl className="grid gap-x-5 gap-y-3 text-xs sm:grid-cols-2">
        {[
          ["Store", body.store],
          ["Parallel tool calls", body.parallel_tool_calls],
          ["Prompt cache key", body.prompt_cache_key],
          ["Output format", format.name ?? format.type],
          ["Reasoning context", reasoning.context],
          ["Client session", asRecord(body.client_metadata).session_id],
        ].filter(([, value]) => value !== undefined).map(([label, value]) => <div key={String(label)}><dt className="text-muted">{String(label)}</dt><dd className="mt-0.5 break-all font-mono text-[10px] text-ink">{textValue(value) || "configured"}</dd></div>)}
      </dl>
    </Disclosure>
  </div>;
}

function RequestRecord({ label, mode, onSelectToken, record, selection, turnId, defaultOpen }: { label: string; mode: RequestMode; onSelectToken: (selection: TokenSelection | null) => void; record: TraceRecord; selection: TokenSelection | null; turnId: string; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const body = asRecord(record.request?.body);
  const treeSelectionPath = useMemo(() => selectedJsonPath(record, selection, turnId), [record, selection, turnId]);
  return <details className="overflow-hidden rounded-xl border border-line" onToggle={(event) => setOpen(event.currentTarget.open)} open={open}>
    <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 px-3 text-sm font-semibold hover:bg-canvas sm:px-4"><span>{label}</span><Pill>{textValue(body.model) || "Unknown model"}</Pill><span className="ml-auto hidden font-mono text-[10px] font-normal text-muted sm:block">{record.request?.method} {record.request?.path}</span><span aria-hidden="true" className="text-xs text-muted">›</span></summary>
    {open ? mode === "structured" ? <div className="border-t border-line"><StructuredRequest onSelectToken={onSelectToken} record={record} selection={selection} turnId={turnId}/></div> : mode === "tree" ? <JsonTreeView selectedBlockId={selection?.turnId === turnId ? selection.blockId : undefined} selectedPath={treeSelectionPath} value={record}/> : <RawJsonTree selectedBlockId={selection?.turnId === turnId ? selection.blockId : undefined} selectedPath={treeSelectionPath} turnId={turnId} value={record}/> : null}
  </details>;
}

export function RequestView({ jumpToBlock, onSelectToken, selection, turn, turns }: { jumpToBlock: (TokenSelection & { nonce: number }) | null; onSelectToken: (selection: TokenSelection | null) => void; selection: TokenSelection | null; turn: TurnModel; turns: TurnModel[] }) {
  const [scope, setScope] = useState<RequestScope>("turn");
  const [mode, setMode] = useState<RequestMode>("structured");
  const rootRef = useRef<HTMLElement>(null);
  const selectedIndex = turns.findIndex((item) => item.id === turn.id);
  const previous = selectedIndex > 0 ? turns[selectedIndex - 1] : undefined;
  const scopedTurns = scope === "turn" ? [turn] : scope === "conversation" ? turns : [];
  useEffect(() => {
    if (!jumpToBlock || scope === "changes") return;
    const frame = window.requestAnimationFrame(() => {
      const target = [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-block-id]") || [])].find((element) => element.dataset.blockId === jumpToBlock.blockId && element.dataset.turnId === jumpToBlock.turnId);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
      target?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [jumpToBlock, mode, scope]);
  return <section className="rounded-2xl border border-line bg-panel shadow-sm" ref={rootRef}>
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-4 sm:p-5">
      <div><h2 className="text-base font-semibold">Request</h2><p className="mt-1 text-xs text-muted">Read the request by structure, explore its JSON tree, compare it, or inspect the original evidence.</p></div>
      <div className="flex flex-wrap gap-2">
        {selection ? <button className="max-w-48 truncate rounded-full border border-ink bg-ink px-2 py-1 font-mono text-[9px] text-panel" onClick={() => onSelectToken(null)} type="button">{selection.label} ×</button> : null}
        {scope !== "changes" ? <div aria-label="Request format" className="grid grid-cols-3 rounded-lg bg-canvas p-1 text-[11px] font-semibold">{(["structured", "tree", "raw"] as const).map((item) => <button aria-current={mode === item ? "page" : undefined} className={`min-h-8 rounded-md px-3 ${mode === item ? "bg-panel text-ink shadow-sm" : "text-muted"}`} key={item} onClick={() => setMode(item)} type="button">{item === "structured" ? "Structured" : item === "tree" ? "Tree" : "Raw"}</button>)}</div> : null}
        <div aria-label="Request scope" className="grid grid-cols-3 rounded-lg bg-canvas p-1 text-[11px] font-semibold">{(["turn", "changes", "conversation"] as const).map((item) => <button aria-current={scope === item ? "page" : undefined} className={`min-h-8 rounded-md px-3 ${scope === item ? "bg-panel text-ink shadow-sm" : "text-muted"}`} key={item} onClick={() => setScope(item)} type="button">{item === "turn" ? "This turn" : item === "changes" ? "Changes" : "Conversation"}</button>)}</div>
      </div>
    </div>
    {scope === "changes" ? <RequestChanges current={turn} previous={previous}/> : <div className="space-y-2 p-3 sm:p-4">
      {scopedTurns.map((item, index) => <RequestRecord defaultOpen={scope === "turn"} key={`${scope}-${item.record.request_id || index}`} label={scope === "turn" ? "Captured request" : `Turn ${index + 1}`} mode={mode} onSelectToken={onSelectToken} record={item.record} selection={selection} turnId={item.id}/>)}
    </div>}
  </section>;
}
