"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatDuration, formatNumber } from "@/lib/format";
import type { SectionView } from "@/lib/agents";
import { callReadSource, cleanWebText, inferOutputFormat, type OutputFormat, type OutputKind } from "@/lib/output-format";
import { genericResultParts, scriptToolCalls, type ResultPart, type ToolCall } from "@/lib/tool-results";
import { toolDeclarations } from "@/lib/protocols";
import { classifyInput, itemStateOf, LAYER_META, LAYER_ORDER, messageParts, turnPlugins } from "@/lib/token-model";
import type { InputCategory, InputClass, InputLayer, ItemState, TokenSelection, TraceRecord, TurnModel } from "@/lib/types";
import { categoryColor } from "@/lib/category-palette";
import { CategorySwatch } from "../charts/category-legend";
import { activateOnKey, motionMs, useAccordion } from "../motion";
import { Badge, Swatch, type Tone } from "../ui/badge";
import { Button, IconButton } from "../ui/button";
import { EmptyState, Notice } from "../ui/feedback";
import { SearchField } from "../ui/field";
import { ArrowLeftIcon, BookIcon, ChatIcon, ChevronLeftIcon, ChevronRightIcon, CloseIcon, HistoryIcon, PinIcon, QuestionIcon, SearchIcon, SlidersIcon, SparkleIcon, TerminalIcon, ToolIcon, UserIcon } from "../ui/icons";
import { Segmented } from "../ui/segmented";
import { RawJsonTree } from "./raw-json-tree";
import { humanizeField, previewText, ReadableText, RichText, stableValue } from "./section-views";
import { clearCurrentMatch, clearHighlights, focusMatch, highlightMatches, MIN_QUERY, SEARCH_HIT_LIMIT, searchRecord, type JsonPathPart, type SearchHit } from "./request-search";

type UnknownRecord = Record<string, unknown>;
type RequestMode = "timeline" | "structured" | "raw";
export type RequestViewMode = RequestMode | "changes";

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
}

function capturedText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(capturedText).filter(Boolean).join("");
  const record = asRecord(value);
  const nested = record.text ?? record.content ?? record.output ?? record.input_text ?? record.output_text;
  return nested === undefined || nested === value ? "" : capturedText(nested);
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

function JsonBlock({ value }: { value: unknown }) {
  return <pre className="tf-code tf-well max-h-[28rem] overflow-auto border border-line p-3 text-ink">{JSON.stringify(value, null, 2)}</pre>;
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

function parseWrappedToolCall(value: string): ParsedWrappedToolCall | null {
  const call = scriptToolCalls(value)[0];
  return call?.input ? { input: asRecord(call.input), name: call.name } : null;
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
  return <Notice compact tone="warning"><div className="flex flex-wrap items-center gap-2">
    <span className="font-medium">{warning || "Captured output metadata"}</span>
    {tokenCount ? <Badge mono tone="warning">Original {Number(tokenCount.replaceAll(",", "")).toLocaleString()} tokens</Badge> : null}
    {lineCount ? <Badge mono tone="warning">{Number(lineCount.replaceAll(",", "")).toLocaleString()} output {Number(lineCount.replaceAll(",", "")) === 1 ? "line" : "lines"}</Badge> : null}
  </div></Notice>;
}

function ToolResultCatalog({ tools }: { tools: ToolResultDefinition[] }) {
  return <section className="tf-card overflow-hidden">
    <div className="tf-inset flex flex-wrap items-center gap-2 border-b border-line py-3">
      <div className="min-w-0"><h4 className="tf-heading">Returned tool catalog</h4><p className="mt-0.5 text-xs text-muted">Tool definitions returned by this call, rendered as readable entries.</p></div>
      <Badge mono>{tools.length} tools</Badge>
    </div>
    <div className="space-y-2 p-2 sm:p-3">{tools.map((tool, index) => {
      const { declaration, summary } = splitToolDescription(tool.description);
      const metadata = Object.fromEntries(Object.entries(tool).filter(([key]) => key !== "name" && key !== "description"));
      return <div key={`${tool.name}-${index}`} style={{ containIntrinsicSize: "0 64px", contentVisibility: "auto" }}>
        <Disclosure summary={<div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><strong className="break-all font-mono text-xs text-ink">{tool.name}</strong><Badge mono>{textValue(tool.type) || "tool"}</Badge></div>{summary ? <p className="mt-1 line-clamp-2 text-xs leading-4 text-muted">{summary}</p> : null}</div>}>
          <div className="space-y-3">
            {summary ? <RichText>{summary}</RichText> : null}
            {declaration ? <Disclosure summary={<><strong className="text-xs">Declaration</strong><span className="text-xs text-muted">Parameters and return type</span></>}><pre className="tf-code tf-well max-h-[32rem] overflow-auto whitespace-pre-wrap p-3 text-ink">{declaration}</pre></Disclosure> : null}
            {Object.keys(metadata).length ? <Disclosure summary={<><strong className="text-xs">Additional fields</strong><Badge mono>{Object.keys(metadata).length}</Badge></>}><JsonBlock value={metadata}/></Disclosure> : null}
          </div>
        </Disclosure>
      </div>;
    })}</div>
  </section>;
}

/* Structured values render by size, not by shape, so nothing small hides behind
   a disclosure: a single-field object is its value, short items sit on one line,
   short lists are numbered rows, and objects are a plain key/value grid. Only a
   large or deeply nested element folds, and its summary previews its content. */
const INLINE_CHARS = 140;
const FOLD_CHARS = 600;

function isScalar(value: unknown): boolean {
  return value === null || typeof value !== "object";
}

/* The value an object stands for when it has one field, followed through nesting. */
function soleValue(value: unknown): unknown {
  let current = value;
  while (current && typeof current === "object" && !Array.isArray(current)) {
    const entries = Object.entries(current as UnknownRecord);
    if (entries.length !== 1) break;
    current = entries[0][1];
  }
  return current;
}

/* One line for a value that fits on one: a scalar, or an object of scalars. */
function inlineText(value: unknown): string | null {
  const sole = soleValue(value);
  if (isScalar(sole)) {
    const text = sole === null ? "null" : textValue(sole);
    return text.length <= INLINE_CHARS && !text.includes("\n") ? text : null;
  }
  if (Array.isArray(sole)) return null;
  const entries = Object.entries(sole as UnknownRecord);
  if (!entries.every(([, item]) => isScalar(item))) return null;
  const text = entries.map(([key, item]) => `${key}: ${item === null ? "null" : textValue(item)}`).join(" · ");
  return text.length <= INLINE_CHARS ? text : null;
}

function ScalarView({ value }: { value: unknown }) {
  const text = value === null ? "null" : textValue(value);
  if (/^https?:\/\/\S+$/.test(text)) {
    return <a className="break-all underline decoration-line underline-offset-4 hover:decoration-ink" href={text} rel="noreferrer" target="_blank" title={text}>{text.replace(/^https?:\/\//, "")}</a>;
  }
  return <span className="whitespace-pre-wrap break-words">{text}</span>;
}

function InlineValue({ value }: { value: unknown }) {
  const sole = soleValue(value);
  if (isScalar(sole)) return <span title={sole === value ? undefined : Object.keys(asRecord(value)).join(" › ")}><ScalarView value={sole}/></span>;
  const entries = Object.entries(asRecord(sole));
  return <span>{entries.map(([key, item], index) => <span key={key}>{index ? <span className="text-muted"> · </span> : null}<span className="text-muted">{key}</span> <ScalarView value={item}/></span>)}</span>;
}

function StructuredValue({ depth = 0, value }: { depth?: number; value: unknown }) {
  if (Array.isArray(value) && value.length && value.every(isToolResultDefinition)) return <ToolResultCatalog tools={value}/>;
  const sole = soleValue(value);
  if (isScalar(sole)) return <span className="text-xs text-ink"><ScalarView value={sole}/></span>;
  if (Array.isArray(sole)) {
    if (!sole.length) return <span className="text-xs text-muted">Empty list</span>;
    return <ol className="space-y-1 text-xs text-ink">{sole.map((item, index) => {
      const inline = inlineText(item);
      const size = stableValue(item).length;
      return <li className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-2" key={index}>
        <span className="select-none text-right font-mono text-muted">{index + 1}</span>
        <div className="min-w-0">{inline !== null ? <InlineValue value={item}/>
          : size > FOLD_CHARS || depth >= 2 ? <Disclosure summary={<span className="min-w-0 truncate text-xs text-muted">{previewText(item) || `${size.toLocaleString()} characters`}</span>}><StructuredValue depth={depth + 1} value={item}/></Disclosure>
            : <StructuredValue depth={depth + 1} value={item}/>}</div>
      </li>;
    })}</ol>;
  }
  const entries = Object.entries(asRecord(sole));
  return <dl className="grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">{entries.map(([key, item]) => {
    const inline = inlineText(item);
    const size = stableValue(item).length;
    return <div className="contents" key={key}>
      <dt className="truncate font-mono text-muted" title={key}>{key}</dt>
      <dd className="min-w-0 text-ink">{inline !== null ? <InlineValue value={item}/>
        : size > FOLD_CHARS || depth >= 2 ? <Disclosure summary={<span className="min-w-0 truncate text-xs text-muted">{previewText(item) || `${size.toLocaleString()} characters`}</span>}><StructuredValue depth={depth + 1} value={item}/></Disclosure>
          : <StructuredValue depth={depth + 1} value={item}/>}</dd>
    </div>;
  })}</dl>;
}

function StructuredText({ children }: { children: string }) {
  const parsed = useMemo(() => parseStructuredText(children), [children]);
  if (!parsed) return <RichText>{children}</RichText>;
  return <StructuredOutput parsed={parsed}/>;
}

function StructuredOutput({ parsed }: { parsed: ParsedStructuredText }) {
  return <div className="space-y-3">
    {parsed.prefix ? <ResultNotice value={parsed.prefix}/> : null}
    {parsed.recovered ? <Notice compact tone="warning">Recovered {Array.isArray(parsed.value) ? parsed.value.length : 0} complete entries from truncated JSON. The incomplete final entry remains available in Raw.</Notice> : null}
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
  return <section className="tf-card overflow-hidden">
    <div className="tf-inset border-b border-line bg-canvas py-3"><div className="flex flex-wrap items-center gap-2"><h4 className="tf-heading">{verification ? "Browser verification page" : "HTML document"}</h4><Badge mono>HTML</Badge></div><p className="mt-1 text-xs text-muted">{verification ? "The server returned a verification challenge instead of the requested data." : "The server returned a document instead of structured data."}</p></div>
    <div className="tf-inset space-y-4 py-3">
      {notice ? <div><div className="text-xs font-medium text-muted">Page notice</div><p className="mt-1 text-sm leading-5 text-ink">{notice}</p></div> : null}
      {facts.length ? <dl className="grid gap-x-5 gap-y-3 sm:grid-cols-2">{facts.map(([label, item]) => <div key={label}><dt className="text-xs font-medium text-muted">{label}</dt><dd className="mt-1 break-words font-mono text-xs text-ink">{item}</dd></div>)}</dl> : null}
    </div>
  </section>;
}

function lineCount(value: string): string {
  const count = value.split("\n").length;
  return `${count} ${count === 1 ? "line" : "lines"}`;
}

function TextOutput({ label = "Output", value }: { label?: string; value: string }) {
  const lines = value.split("\n");
  if (!value) return <EmptyState framed>The tool completed without captured output.</EmptyState>;
  // A rate-limit reply is short; a long output that mentions rate limits is output.
  if (value.length < 400 && /too many requests|rate limit/i.test(value)) return <Notice compact title="Rate limited" tone="warning">{value.trim()}</Notice>;
  return <section><BlockHeading aside={lineCount(value)}>{label}</BlockHeading><ol className="tf-code tf-well max-h-[28rem] overflow-auto py-2 text-ink">{lines.map((line, index) => <li className="grid grid-cols-[2.5rem_minmax(0,1fr)] px-3" key={index}><span className="select-none pr-3 text-right text-muted/70">{index + 1}</span><span className="whitespace-pre-wrap break-words">{line || " "}</span></li>)}</ol></section>;
}

function MarkdownOutput({ value }: { value: string }) {
  return <section><BlockHeading aside={lineCount(value)}>Rendered Markdown</BlockHeading><div className="tf-well max-h-[40rem] overflow-auto px-4 py-3"><RichText>{value}</RichText></div></section>;
}

function DiffOutput({ value }: { value: string }) {
  const tone = (line: string) => line.startsWith("+++") || line.startsWith("---") || /^(?:diff |index |commit |Author:|Date:)/.test(line) ? "font-semibold text-ink"
    : line.startsWith("@@") ? "text-muted"
      : line.startsWith("+") ? "bg-success-soft text-success-ink"
        : line.startsWith("-") ? "bg-danger-soft text-danger-ink" : "text-ink";
  return <section><BlockHeading aside={lineCount(value)}>Diff</BlockHeading><pre className="tf-code tf-well max-h-[32rem] overflow-auto py-2">{value.split("\n").map((line, index) => <div className={`whitespace-pre-wrap break-words px-3 ${tone(line)}`} key={index}>{line || " "}</div>)}</pre></section>;
}

/* A fetched web page reads as prose once citation markers are removed. */
function WebOutput({ value }: { value: string }) {
  const text = cleanWebText(value).trim();
  return <section><BlockHeading aside={lineCount(text)}>Web page · citation markers removed</BlockHeading><div className="tf-well max-h-[32rem] overflow-auto whitespace-pre-wrap break-words px-4 py-3 text-sm leading-6 text-ink">{text}</div></section>;
}

type OutputView = OutputKind | "structured" | "html";

const VIEW_LABELS: Record<OutputView, string> = {
  code: "Code",
  diff: "Diff",
  html: "Document",
  markdown: "Markdown",
  structured: "Structured",
  text: "Plain",
  web: "Web page",
};

/* A tool result, shown the way the call that produced it says it should be: a
   Markdown file renders, source reads as code, a diff is colored, a web page is
   cleaned. Without that evidence it stays plain text; only JSON that parses and
   complete HTML documents are recognized from content. The reader can always
   switch between the inferred view, Plain, and Markdown. */
/* `title` names this output when it is one part of a result; it replaces the
   format evidence on the switch line. */
function ToolOutputView({ format, title, value }: { format: OutputFormat; title?: ReactNode; value: string }) {
  const trimmed = value.trim();
  // Only output that is JSON from its first character reads as structured; JSON
  // printed partway through (a `cat package.json` after other commands) is text.
  const structured = useMemo(() => {
    const parsed = format.kind === "text" ? parseStructuredText(trimmed) : null;
    return parsed && !parsed.prefix ? parsed : null;
  }, [format.kind, trimmed]);
  const auto: OutputView = /^<!doctype\s+html|^<html\b/i.test(trimmed) ? "html" : format.kind !== "text" ? format.kind : structured ? "structured" : "text";
  const [chosen, setChosen] = useState<OutputView | null>(null);
  const view = chosen ?? auto;
  const options = [...new Set<OutputView>([auto, "text", "markdown"])];
  const language = format.kind === "code" ? format.language : undefined;
  return <div className="space-y-2">
    {trimmed || title ? <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
      {title ?? <span className="min-w-0 truncate">{format.reason ? <>From <code className="font-mono text-ink">{format.reason}</code></> : "No format declared by the call"}</span>}
      {trimmed ? <span aria-label="Output view" className="ml-auto inline-flex rounded-md border border-line p-0.5" role="group" title={title && format.reason ? `Format from ${format.reason}` : undefined}>
        {options.map((option) => <button aria-pressed={view === option} className={`rounded px-2 py-0.5 ${view === option ? "bg-canvas font-medium text-ink" : "hover:text-ink"}`} key={option} onClick={() => setChosen(option)} type="button">{option === "code" && language ? language : VIEW_LABELS[option]}</button>)}
      </span> : null}
    </div> : null}
    {view === "html" ? <HtmlOutput value={trimmed}/>
      : view === "structured" && structured ? <StructuredOutput parsed={structured}/>
        : view === "markdown" ? <MarkdownOutput value={trimmed}/>
          : view === "diff" ? <DiffOutput value={trimmed}/>
            : view === "web" ? <WebOutput value={trimmed}/>
              : view === "code" ? <TextOutput label={language || "Code"} value={trimmed}/>
                : <TextOutput value={trimmed}/>}
  </div>;
}

function Disclosure({ children, defaultOpen = false, summary }: { children: ReactNode; defaultOpen?: boolean; summary: ReactNode }) {
  // A later selection inside a closed disclosure opens it at once so the block can be scrolled to.
  const { mounted, open, toggle } = useAccordion(defaultOpen);
  return <div className="t-acc tf-card" data-open={open ? "true" : "false"}>
    <div aria-expanded={open} className="t-acc-head tf-focus-inset flex min-h-11 cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 rounded-control px-3 py-2 hover:bg-fill-hover" onClick={toggle} onKeyDown={(event) => activateOnKey(event, toggle)} role="button" tabIndex={0}><Chevron open={open}/>{summary}</div>
    {mounted ? <div className="t-acc-panel"><div className="t-acc-panel-inner"><div className="tf-inset border-t border-line py-3">{children}</div></div></div> : null}
  </div>;
}

function ContentPart({ value }: { value: unknown }) {
  if (typeof value === "string") return <StructuredText>{value}</StructuredText>;
  const part = asRecord(value);
  const text = textValue(part.text ?? part.output ?? part.input_text ?? part.output_text);
  if (text) return <StructuredText>{text}</StructuredText>;
  const type = textValue(part.type) || "content";
  if (type.includes("image") || part.image_url || part.file_id) {
    return <div className="flex flex-wrap items-center gap-2"><Badge mono>{type}</Badge><span className="text-xs text-muted">Attachment metadata is available in Raw JSON.</span></div>;
  }
  return <JsonBlock value={value}/>;
}

function splitBlockId(blockId: string): { itemId: string; partIndex: number | null } {
  const match = blockId.match(/^(.*):(\d+)$/);
  return match ? { itemId: match[1], partIndex: Number(match[2]) } : { itemId: blockId, partIndex: null };
}

function selectedJsonPath(turn: TurnModel, selection: TokenSelection | null, turnId: string): Array<number | string> | null {
  if (!selection || selection.turnId !== turnId) return null;
  const source = turn.blocks.find((block) => block.id === selection.blockId);
  return source?.rawPath ?? null;
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

/* The request body as the model received it: for a chained request, `input` holds
   the context rebuilt from the previous captured turn. Raw keeps the exact capture. */
function contextBody(turn: TurnModel): UnknownRecord {
  const body = asRecord(turn.record.request?.body);
  return turn.context.chainedItems ? { ...body, input: turn.context.input } : body;
}

function requestToolNames(turn: TurnModel): string[] {
  const body = contextBody(turn);
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
  addTools(toolDeclarations(turnPlugins(turn).protocol, body));
  for (const block of turn.blocks) {
    const record = block.item;
    if (record.type === "additional_tools") addTools(record.tools);
  }
  return [...new Set(names)];
}

type LayerChange = "added" | "removed" | "changed";

const CHANGE_TONES: Record<LayerChange, Tone> = { added: "success", changed: "warning", removed: "neutral" };

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
  const before = inputEntries(previous);
  const after = inputEntries(current);
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
  if (entry.part !== undefined) return sectionPreview(entry.section, capturedText(entry.part));
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

function LayerDiffSection({ diff, onSelectToken, selection, turnId }: { diff: LayerDiff; onSelectToken: (selection: TokenSelection | null) => void; selection: TokenSelection | null; turnId: string }) {
  const meta = LAYER_META[diff.layer];
  const count = (change: LayerChange) => diff.rows.filter((row) => row.change === change).length;
  const delta = diff.before !== undefined && diff.after !== undefined ? diff.after - diff.before : undefined;
  const selectedLayer = selection?.turnId === turnId && selection.layer === diff.layer;
  const selectedBlocks = selectionIds(selection, turnId);
  const layerDimmed = selection?.turnId === turnId && Boolean(selection.layer) && !selectedLayer;
  const summary = <>
    <Swatch color={meta.color}/>
    <strong className="text-xs">{meta.title}</strong>
    {count("added") ? <Badge tone={CHANGE_TONES.added}>+{count("added")} added</Badge> : null}
    {count("changed") ? <Badge tone={CHANGE_TONES.changed}>{count("changed")} changed</Badge> : null}
    {count("removed") ? <Badge tone={CHANGE_TONES.removed}>{count("removed")} removed</Badge> : null}
    {!diff.rows.length ? <span className="text-xs text-muted">{diff.uncompared ? "No matched changes" : "Unchanged"}</span> : null}
    <span className="ml-auto shrink-0 font-mono text-xs text-muted">{tokenText(diff.before)} → <span className="text-ink">{tokenText(diff.after)}</span>{delta ? ` (${delta > 0 ? "+" : ""}${delta.toLocaleString()})` : ""}</span>
  </>;
  const style = selectedLayer ? { borderColor: meta.color, boxShadow: `0 0 0 3px color-mix(in srgb, ${meta.color} 18%, transparent)` } : undefined;
  if (!diff.rows.length && !diff.uncompared) return <div className={`tf-card flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 py-2 pl-9 pr-3 transition ${layerDimmed ? "tf-dimmed" : ""}`} style={style}>{summary}</div>;
  return <div className={`transition ${layerDimmed ? "tf-dimmed" : ""}`} style={style}><Disclosure defaultOpen={selectedLayer || diff.rows.some(({ change, entry }) => change !== "removed" && selectionHits([entry], selection, turnId))} summary={summary}>
    <ul className="divide-y divide-line text-xs">
      {diff.rows.map(({ change, entry }) => {
        const blockIds = change === "removed" ? [] : entryBlockIds([entry]);
        const active = selectionHits([entry], selection, turnId);
        return <li className={`flex items-center gap-2 py-2 transition ${selectedBlocks.length && !active ? "tf-dimmed" : ""}`} key={`${change}-${entry.key}`}>
        <LinkSwatch blockIds={blockIds} category={entry.inputClass.category} label={entry.inputClass.label} onSelectToken={onSelectToken} selection={selection} turnId={turnId}/>
        <span className="shrink-0 font-medium">{entry.inputClass.label}</span>
        <Badge tone={CHANGE_TONES[change]}>{change}</Badge>
        <span className="min-w-0 flex-1 truncate text-muted">{entryPreview(entry)}</span>
        {entry.tokens ? <span className="shrink-0 font-mono text-xs text-muted">{entry.tokens.tokens.toLocaleString()}</span> : null}
      </li>;
      })}
      {diff.uncompared ? <li className="py-2 text-muted">{diff.uncompared} {diff.uncompared === 1 ? "block has" : "blocks have"} no captured id, so {diff.uncompared === 1 ? "it is" : "they are"} not compared.</li> : null}
    </ul>
  </Disclosure></div>;
}

function RequestChanges({ previous, current, onSelectToken, selection }: { previous: TurnModel | undefined; current: TurnModel; onSelectToken: (selection: TokenSelection | null) => void; selection: TokenSelection | null }) {
  if (!previous) return <div className="tf-pad"><EmptyState framed title="No previous turn">Choose Turn 2 or later to compare captured requests.</EmptyState></div>;

  const previousBody = asRecord(previous.record.request?.body);
  const currentBody = asRecord(current.record.request?.body);
  const previousReasoning = asRecord(previousBody.reasoning);
  const currentReasoning = asRecord(currentBody.reasoning);
  const facts = [
    ["User input", previous.title, current.title],
    ["Model", textValue(previousBody.model) || "Unknown", textValue(currentBody.model) || "Unknown"],
    ["Endpoint", `${previous.method} ${previous.path}`.trim(), `${current.method} ${current.path}`.trim()],
    ["Input items", String(previous.context.input.length), String(current.context.input.length)],
    ["Tool definitions", String(requestToolNames(previous).length), String(requestToolNames(current).length)],
    ["Reasoning effort", textValue(previousReasoning.effort) || "Unavailable", textValue(currentReasoning.effort) || "Unavailable"],
  ].filter(([, before, after]) => before !== after);
  const keys = [...new Set([...Object.keys(previousBody), ...Object.keys(currentBody)])];
  const changedFields = keys.filter((key) => stableValue(previousBody[key]) !== stableValue(currentBody[key]));
  const diffs = layerDiffs(previous, current);

  return <div className="tf-pad space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="tf-heading">Turn {previous.label} → Turn {current.label}</h3><p className="mt-1 text-xs text-muted">Only captured request differences are shown.</p></div><Badge mono>{changedFields.length} changed fields</Badge></div>
    {facts.length ? <dl className="tf-card divide-y divide-line overflow-hidden">{facts.map(([label, before, after]) => <div className="tf-inset grid gap-1 py-3 text-xs sm:grid-cols-[8rem_minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-start" key={label}>
      <dt className="font-medium text-muted">{label}</dt><dd className="min-w-0 break-words font-mono text-xs text-muted">{before}</dd><span aria-hidden="true" className="hidden text-muted sm:block">→</span><dd className="min-w-0 break-words font-mono text-xs text-ink">{after}</dd>
    </div>)}</dl> : <EmptyState framed>No high-level request changes detected.</EmptyState>}
    <section className="space-y-2"><h4 className="tf-eyebrow">Input by layer</h4>{diffs.map((diff) => <LayerDiffSection diff={diff} key={diff.layer} onSelectToken={onSelectToken} selection={selection} turnId={current.id}/>)}</section>
    {changedFields.length ? <Disclosure summary={<><strong className="text-xs">Changed request fields</strong><span className="text-xs text-muted">Exact top-level evidence</span></>}><div className="flex flex-wrap gap-1.5">{changedFields.map((field) => <Badge key={field} mono>{field}</Badge>)}</div></Disclosure> : null}
  </div>;
}

/* Harness sections arrive wrapped in one pseudo-XML tag; the section label already
   names it, so render only its body. The exact text remains in Tree and Raw. */
function unwrapSection(value: string): string {
  const match = /^\s*<([A-Za-z][\w -]*)>\s*\n?([\s\S]*?)\n?\s*<\/\1>\s*$/.exec(value);
  return match ? match[2] : value;
}

function sectionPreview(section: SectionView | undefined, value: string): string {
  const own = section?.preview?.(value);
  if (own !== undefined) return own;
  // Previews read as prose: drop markdown heading and emphasis markers.
  return previewText(unwrapSection(value).replace(/^\s*#{1,6}\s+/gm, "").replace(/\*\*|__/g, ""));
}

function SectionContent({ previous, section, value }: { previous?: string; section?: SectionView; value: unknown }) {
  const text = typeof value === "string" ? value : textValue(asRecord(value).text);
  if (!text) return <ContentPart value={value}/>;
  const own = section?.render?.(text, previous);
  if (own !== undefined) return <>{own}</>;
  const body = unwrapSection(text);
  return parseStructuredText(body) ? <StructuredText>{body}</StructuredText> : <ReadableText value={body}/>;
}

interface InputEntry {
  sourceId?: string;
  sourceIndex?: number;
  blockId?: string;
  inputClass: InputClass;
  /* The kind the client declared for this part, if any. */
  declaredKind?: string;
  item: UnknownRecord;
  itemId: string;
  key: string;
  part?: unknown;
  partIndex?: number;
  /* The tool result answering this call, when the entry is a call. */
  result?: InputEntry;
  /* State shown on the row; omitted when every item is new so rows stay quiet. */
  rowState?: ItemState;
  /* How the tool result of this call (or answering this result's call) is shown. */
  outputFormat?: OutputFormat;
  /* A tool result captured as parts, read part by part. */
  readout?: ResultReadout;
  /* The agent's view for this section label, when it has one. */
  section?: SectionView;
  state?: ItemState;
  tokens?: { cached: number; tokens: number };
}

type TokenCount = { cached: number; tokens: number };

/* A multi-part tool result: the header part's status, then each output part with
   the format of the call that produced it. */
interface ResultReadout {
  elapsed: string;
  parts: Array<ResultPart & { format: OutputFormat; tokens?: TokenCount }>;
  status: string;
}

const TEXT_FORMAT: OutputFormat = { kind: "text" };

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

function inputEntries(turn: TurnModel, responseItems?: unknown[]): InputEntry[] {
  const tokens = tokenIndex(turn);
  const { agent } = turnPlugins(turn);
  const withView = (entry: InputEntry): InputEntry => ({ ...entry, section: agent.sections?.[entry.inputClass.label] });
  // A result's format comes from the call that produced it: its command or the file it reads.
  const formatForCall = (call: ToolCall): OutputFormat => {
    const source = callReadSource(call.name, call.input);
    return agent.outputFormat?.(source) ?? inferOutputFormat(source);
  };
  const formatFor = (item: UnknownRecord): OutputFormat => {
    const presentation = toolCallPresentation(item);
    return formatForCall({ input: presentation.input, name: [presentation.name, presentation.wrapperName].filter(Boolean).join(" ") });
  };
  const entries: InputEntry[] = responseItems ? responseItems.flatMap((raw, itemIndex) => {
    const item = asRecord(raw);
    const itemId = textValue(item.id);
    const state = itemStateOf(turn, raw);
    const key = itemId || `item-${itemIndex}`;
    if (!isMessagePartItem(item)) {
      return [withView({ blockId: itemId || undefined, inputClass: classifyInput(turn.record, item), item, itemId, key, outputFormat: toolEventKind(item) === "call" ? formatFor(item) : undefined, state, tokens: itemId ? tokens.get(`item:${itemId}`) : undefined })];
    }
    const parts = messageParts(agent, item) ?? inputItemParts(item);
    return parts.map((part, partIndex) => {
      const blockId = itemId ? `${itemId}:${partIndex}` : undefined;
      const partTokens = blockId ? tokens.get(blockId) ?? (parts.length === 1 ? tokens.get(`item:${itemId}`) : undefined) : undefined;
      return withView({ blockId, declaredKind: agent.declaredKind?.(item, partIndex) || undefined, inputClass: classifyInput(turn.record, item, part, partIndex), item, itemId, key: `${key}:${partIndex}`, part, partIndex, state, tokens: partTokens });
    });
  }) : turn.blocks.map((block) => {
    const state = block.itemIndex >= 0 ? turn.itemStates[block.itemId || `@${block.itemIndex}`] : undefined;
    return withView({ sourceId: block.id, sourceIndex: block.itemIndex, blockId: block.id, itemId: block.itemId, key: block.id, item: block.item, part: block.part, partIndex: block.partIndex, inputClass: block.inputClass, state,
      tokens: tokens.get(block.id) ?? (block.partIndex === undefined && block.itemId ? tokens.get(`item:${block.itemId}`) : undefined),
      outputFormat: toolEventKind(block.item) === "call" ? formatFor(block.item) : undefined,
      declaredKind: agent.declaredKind?.(block.item, block.partIndex || 0) || undefined });
  });
  const mixed = entries.some((entry) => entry.state && entry.state !== "new");
  const callFormats = new Map(entries.filter((entry) => entry.outputFormat).map((entry) => [textValue(entry.item.call_id), entry.outputFormat as OutputFormat] as const));
  const callItems = new Map(entries.filter((entry) => toolEventKind(entry.item) === "call").map((entry) => [textValue(entry.item.call_id), entry.item] as const));
  // A result captured as parts reads part by part; the first part can be a header
  // (status and wall time) before the output parts.
  const readout = (entry: InputEntry, outer: OutputFormat | undefined): ResultReadout | undefined => {
    const captured = entry.item.output ?? entry.item.content;
    // A single text result is read by part only when the agent says how.
    const list = Array.isArray(captured) ? captured : typeof captured === "string" && agent.resultParts ? [captured] : undefined;
    if (!list) return undefined;
    const parts = list.map((part, partIndex) => ({ part, partIndex }));
    const first = capturedText(list[0]);
    const head = parseToolResult(first);
    // Metadata lines before an `Output:` line are the header, not output.
    if (/^Output:\s*$/im.test(first)) {
      if (head.output) parts[0] = { part: head.output, partIndex: 0 };
      else parts.shift();
    }
    const callItem = callItems.get(textValue(entry.item.call_id));
    const call = callItem ? { input: callItem.arguments ?? callItem.input, name: textValue(callItem.name) } : undefined;
    const declared = agent.resultParts?.(call, parts);
    if (!declared && !Array.isArray(captured)) return undefined;
    const read = declared ?? genericResultParts(parts);
    return {
      elapsed: head.elapsed,
      parts: read.map((part) => ({
        ...part,
        format: part.call ? formatForCall(part.call) : read.length === 1 && outer ? outer : TEXT_FORMAT,
        tokens: entry.itemId ? tokens.get(`${entry.itemId}:${part.partIndex}`) : undefined,
      })),
      status: head.status,
    };
  };
  return entries.map((entry) => {
    const result = toolEventKind(entry.item) === "result";
    const outputFormat = entry.outputFormat ?? (result ? callFormats.get(textValue(entry.item.call_id)) : undefined);
    return { ...entry, outputFormat, readout: result ? readout(entry, outputFormat) : undefined, rowState: mixed ? entry.state : undefined };
  });
}

function sumTokens(entries: InputEntry[]): { cached: number; tokens: number } | undefined {
  const known = entries.filter((entry) => entry.tokens);
  if (!known.length) return undefined;
  return known.reduce((sum, entry) => ({ cached: sum.cached + (entry.tokens?.cached || 0), tokens: sum.tokens + (entry.tokens?.tokens || 0) }), { cached: 0, tokens: 0 });
}

function entryBlockIds(entries: Array<InputEntry | undefined>): string[] {
  return entries.flatMap((entry) => {
    if (entry?.sourceId) return [entry.sourceId];
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
  if (!entry || !ids.length) return false;
  if (entry.sourceId && ids.includes(entry.sourceId)) return true;
  if (!entry.itemId) return false;
  if (entry.part !== undefined) return ids.some((id) => id === entry.blockId || id === entry.itemId);
  return ids.some((id) => id === entry.itemId || id.startsWith(`${entry.itemId}:`));
}

function selectionHits(entries: Array<InputEntry | undefined>, selection: TokenSelection | null, turnId: string): boolean {
  if (selection?.turnId === turnId && selection.layer) return entries.some((entry) => entry?.inputClass.layer === selection.layer);
  const ids = selectionIds(selection, turnId);
  return entries.some((entry) => entryHit(entry, ids));
}

/* How a row reflects the shared selection: matching rows take their category color,
   the focused block opens, and everything else in the turn steps back. */
function rowMarks(entries: Array<InputEntry | undefined>, category: InputCategory, selection: TokenSelection | null, turnId: string): { accent?: string; dimmed: boolean; open: boolean } {
  const ids = selectionIds(selection, turnId);
  const matched = selectionHits(entries, selection, turnId);
  return {
    accent: matched ? categoryColor(category) : undefined,
    dimmed: (ids.length > 0 || Boolean(selection?.turnId === turnId && selection.layer)) && !matched,
    open: Boolean(selection?.turnId === turnId && selection.layer && matched) || entries.some((entry) => entryHit(entry, selectionIds(selection, turnId, true))),
  };
}

type IconComponent = typeof ToolIcon;

const LAYER_ICONS: Record<InputLayer, IconComponent> = {
  capabilities: ToolIcon,
  instructions: BookIcon,
  context: PinIcon,
  conversation: ChatIcon,
  unknown: QuestionIcon,
};

/* A row or section's leading icon, tinted with its category or layer color. */
function RowIcon({ color, icon: Icon }: { color?: string; icon: IconComponent }) {
  return <Icon className="shrink-0 text-muted" style={color ? { color } : undefined}/>;
}

/* The accordion chevron; it turns when the row opens (Accordion expand). */
function Chevron({ open }: { open: boolean }) {
  return <span aria-hidden="true" className={`t-acc-chevron grid w-4 shrink-0 place-items-center ${open ? "text-muted" : "text-muted/60"}`}><ChevronRightIcon className="size-4"/></span>;
}

function StateBadge({ state }: { state?: ItemState }) {
  if (state === "new") return <Badge tone="success">new</Badge>;
  if (state === "changed") return <Badge tone="warning">changed</Badge>;
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
function LinkSwatch({ blockIds, category, icon, label, onSelectToken, selection, turnId }: { blockIds: string[]; category: InputCategory; icon?: IconComponent; label: string; onSelectToken: (selection: TokenSelection | null) => void; selection: TokenSelection | null; turnId: string }) {
  const selectedIds = selection?.turnId === turnId ? selection.blockIds || [selection.blockId] : [];
  const active = blockIds.some((id) => selectedIds.includes(id));
  const mark = icon ? <RowIcon color={categoryColor(category)} icon={icon}/> : <CategorySwatch category={category}/>;
  if (!blockIds.length) return <span className="grid size-5 shrink-0 place-items-center">{mark}</span>;
  return <button aria-label={active ? `Unlink ${label}` : `Link ${label} in the charts`} aria-pressed={active} className={`grid size-5 shrink-0 place-items-center rounded-tag ${active ? "ring-2 ring-ink" : "hover:ring-1 hover:ring-line"}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); onSelectToken(active ? null : { blockId: blockIds[0], blockIds, category, label, turnId }); }} title={`${label} · link in charts`} type="button">{mark}</button>;
}

/* Invisible scroll targets for one or more captured blocks; the row carries the highlight. */
function BlockAnchor({ blockIds, children, turnId }: { blockIds: string[]; children: ReactNode; turnId: string }) {
  return <div className="relative scroll-m-32" data-block-anchor="">
    {blockIds.map((id) => <span className="absolute left-0 top-0 size-px opacity-0" data-block-id={id} data-turn-id={turnId} key={id} tabIndex={-1}/>)}
    {children}
  </div>;
}

/* A row this turn added or changed while carrying earlier items. It opens by
   default, so stepping through turns shows what each one brought in. */
function isFresh(...entries: Array<InputEntry | undefined>): boolean {
  return entries.some((entry) => entry?.rowState === "new" || entry?.rowState === "changed");
}

/* Flat accordion row: chevron on the left, summary in one line, body aligned with
   the summary. A row without a body keeps the chevron's space so summaries align. */
function Row({ accent, children, defaultOpen = false, dimmed = false, hint, summary }: { accent?: string; children?: ReactNode; defaultOpen?: boolean; dimmed?: boolean; hint?: string; summary: ReactNode }) {
  const { mounted, open, toggle } = useAccordion(defaultOpen);
  // A selected row carries its category color as a left bar and a light tint.
  const mark = accent ? { backgroundColor: `color-mix(in srgb, ${accent} 9%, transparent)`, boxShadow: `inset 3px 0 0 ${accent}` } : undefined;
  const fade = dimmed ? "tf-dimmed" : "";
  if (children === undefined) return <div className={`t-row t-fade tf-inset flex min-h-11 items-center gap-2.5 py-2 text-sm ${fade}`} style={mark} title={hint}><span aria-hidden="true" className="w-4 shrink-0"/>{summary}</div>;
  return <div className="t-row t-acc" data-open={open ? "true" : "false"}>
    <div aria-expanded={open} className={`t-acc-head t-fade tf-inset tf-focus-inset flex min-h-11 cursor-pointer items-center gap-2.5 py-2 text-sm hover:bg-fill-hover ${fade}`} onClick={toggle} onKeyDown={(event) => activateOnKey(event, toggle)} role="button" style={mark} tabIndex={0} title={hint}>
      <Chevron open={open}/>
      {summary}
    </div>
    {mounted ? <div className="t-acc-panel"><div className="t-acc-panel-inner"><div className="tf-inset pb-4 pt-1"><div className="pl-[1.625rem]">{children}</div></div></div></div> : null}
  </div>;
}

function Meta({ children, mono = false }: { children: ReactNode; mono?: boolean }) {
  return <span className={`min-w-0 flex-1 truncate text-xs text-muted ${mono ? "font-mono text-xs" : ""}`}>{children}</span>;
}

function StateSummary({ entries }: { entries: InputEntry[] }) {
  const counts = { carried: 0, changed: 0, new: 0 };
  const seen = new Set<string>();
  for (const entry of entries) {
    const identity = entry.itemId || `@${entry.sourceIndex}`;
    if (!entry.state || seen.has(identity)) continue;
    seen.add(identity);
    counts[entry.state] += 1;
  }
  if (!seen.size) return null;
  if (!counts.new && !counts.changed) return <Badge>unchanged</Badge>;
  return <>{counts.changed ? <Badge tone="warning">{counts.changed} changed</Badge> : null}{counts.new ? <Badge tone="success">+{counts.new} new</Badge> : null}</>;
}

function LayerSection({ badge, children, entries, layer, selection, turnId }: { badge?: ReactNode; children: ReactNode; entries: InputEntry[]; layer: InputLayer; selection: TokenSelection | null; turnId: string }) {
  const meta = LAYER_META[layer];
  const picked = selection?.turnId === turnId && selection.layer === layer;
  const dimmed = selection?.turnId === turnId && Boolean(selection.layer) && !picked;
  // A selected layer takes its own color; the other layers step back while it is selected.
  const ring = picked ? { borderColor: meta.color, boxShadow: `0 0 0 3px color-mix(in srgb, ${meta.color} 18%, transparent)` } : undefined;
  return <section aria-label={meta.title} className={`tf-card scroll-m-24 overflow-hidden transition ${dimmed ? "tf-dimmed" : ""}`} data-layer={layer} data-turn-id={turnId} style={ring} tabIndex={-1}>
    <header className="tf-inset flex min-h-11 items-center gap-2.5 py-1.5">
      <RowIcon color={meta.color} icon={LAYER_ICONS[layer]}/>
      <h3 className="tf-heading shrink-0">{meta.title}</h3>
      <RowEnd badge={badge ?? <StateSummary entries={entries}/>} tokens={sumTokens(entries)}/>
    </header>
    <div className="divide-y divide-line border-t border-line">{children}</div>
  </section>;
}

interface RowProps {
  defaultOpen?: boolean;
  /* The row is part of this turn's response, so a call's result comes next turn. */
  inResponse?: boolean;
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
  const marks = rowMarks([entry], "tools", selection, turnId);
  return <Row accent={marks.accent} defaultOpen={marks.open} dimmed={marks.dimmed} summary={<>
    <LinkSwatch blockIds={blockIds} category="tools" label="Tool definitions" onSelectToken={onSelectToken} selection={selection} turnId={turnId}/>
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
            <summary className="grid cursor-pointer list-none grid-cols-[minmax(6rem,12rem)_minmax(0,1fr)] gap-3 rounded-tag px-1 py-1 font-mono text-xs hover:bg-fill-hover [&::-webkit-details-marker]:hidden"><span className="truncate text-ink">{name}</span><span className="truncate text-muted">{toolSignature(tool)}</span></summary>
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

/* A short identifying fact for a row, never a prose preview: the declared content
   kind, the wrapper tag, or a heading that says more than the label. */
function sectionFact(entry: InputEntry, text: string): { mono: boolean; value: string } {
  const label = entry.inputClass.label;
  const own = entry.section?.fact?.(text);
  if (own) return own;
  const preview = entry.section?.preview?.(text);
  if (preview !== undefined) return { mono: false, value: preview };
  if (label === "Assistant messages") return { mono: false, value: [textValue(entry.item.phase).replaceAll("_", " "), previewText(text)].filter(Boolean).join(" · ") };
  if (entry.declaredKind) return { mono: true, value: entry.declaredKind };
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
  const changes = entry.section?.changes?.(text, previous) || [];
  const badge = changes.length ? <Badge tone="warning">{changes.length === 1 ? `${changes[0]} changed` : `${changes.length} fields changed`}</Badge> : <StateBadge state={entry.rowState}/>;
  const marks = rowMarks([entry], entry.inputClass.category, selection, turnId);
  return <Row accent={marks.accent} defaultOpen={defaultOpen || marks.open || isFresh(entry)} dimmed={marks.dimmed} hint={isPrompt ? undefined : sectionPreview(entry.section, text)} summary={<>
    <LinkSwatch blockIds={blockIds} category={entry.inputClass.category} icon={isPrompt ? UserIcon : label === "Assistant messages" ? ChatIcon : undefined} label={label} onSelectToken={onSelectToken} selection={selection} turnId={turnId}/>
    {isPrompt ? <span className="min-w-0 flex-1 truncate font-medium text-ink">{entry.section?.preview?.(text) || previewText(entry.part) || "Empty prompt"}</span> : <>
      <span className="shrink-0 text-ink">{label === "Assistant messages" ? "Assistant" : label}</span>
      <Meta mono={fact.mono}>{fact.value}</Meta>
    </>}
    <RowEnd badge={badge} tokens={entry.tokens}/>
  </>}>
    <BlockAnchor blockIds={blockIds} turnId={turnId}><SectionContent previous={previous} section={entry.section} value={entry.part}/></BlockAnchor>
  </Row>;
}

function reasoningSummary(item: UnknownRecord): string {
  return asArray(item.summary).map((part) => textValue(asRecord(part).text) || textValue(part)).filter(Boolean).join("\n\n");
}

function ReasoningRow({ defaultOpen = false, entry, onSelectToken, selection, turnId }: RowProps & { entry: InputEntry }) {
  const summary = reasoningSummary(entry.item);
  const encrypted = Boolean(textValue(entry.item.encrypted_content));
  const blockIds = entryBlockIds([entry]);
  const detail = [encrypted ? "encrypted" : "", summary ? previewText(summary) : "no summary"].filter(Boolean).join(" · ");
  const marks = rowMarks([entry], "model", selection, turnId);
  return <Row accent={marks.accent} defaultOpen={defaultOpen || marks.open || isFresh(entry)} dimmed={marks.dimmed} summary={<>
    <LinkSwatch blockIds={blockIds} category="model" icon={SparkleIcon} label="Reasoning" onSelectToken={onSelectToken} selection={selection} turnId={turnId}/>
    <span className="shrink-0 text-ink">Reasoning</span>
    <Meta>{detail}</Meta>
    <RowEnd badge={<StateBadge state={entry.rowState}/>} tokens={entry.tokens}/>
  </>}>
    <BlockAnchor blockIds={blockIds} turnId={turnId}>{summary ? <ReadableText value={summary}/> : <p className="text-xs text-muted">{encrypted ? "The model's reasoning was sent back encrypted. No readable summary was captured." : "No readable reasoning was captured."}</p>}</BlockAnchor>
  </Row>;
}

const CALL_SOURCE_KEYS = ["code", "cmd", "command", "source", "script", "query", "input"];

function CallInput({ value }: { value: unknown }) {
  if (typeof value === "string") return <pre className="tf-code tf-well max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 py-2 text-ink">{value}</pre>;
  const record = asRecord(value);
  const sourceKey = CALL_SOURCE_KEYS.find((key) => typeof record[key] === "string");
  const rest = Object.entries(record).filter(([key]) => key !== sourceKey);
  if (!sourceKey && !rest.length) return <p className="text-xs text-muted">No captured input.</p>;
  return <div className="space-y-2">
    {sourceKey ? <pre className="tf-code tf-well max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 py-2 text-ink">{textValue(record[sourceKey])}</pre> : null}
    {rest.length ? <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">{rest.map(([key, item]) => <div className="contents" key={key}><dt className="text-muted">{humanizeField(key)}</dt><dd className="min-w-0 break-words font-mono text-xs text-ink">{item && typeof item === "object" ? <StructuredValue value={item}/> : formatToolField(key, item) || (item === null ? "null" : "Unknown")}</dd></div>)}</dl> : null}
  </div>;
}

function callSource(message: UnknownRecord, input: unknown): string {
  const field = message.arguments !== undefined ? "arguments" : "input";
  const key = CALL_SOURCE_KEYS.find((candidate) => typeof asRecord(input)[candidate] === "string");
  return key ? `${field}.${key}` : field;
}

/* The label above one captured block inside a row: what it is, and a measure. */
function BlockHeading({ aside, children }: { aside?: string; children: ReactNode }) {
  return <div className="mb-1.5 flex items-baseline justify-between gap-3 text-xs text-muted"><span className="min-w-0 truncate">{children}</span>{aside ? <span className="shrink-0 font-mono">{aside}</span> : null}</div>;
}

function tokenAside(tokens: { cached: number; tokens: number } | undefined): string | undefined {
  return tokens ? `${tokens.tokens.toLocaleString()} tok` : undefined;
}

function ToolExchangeRow({ call, defaultOpen = false, inResponse = false, onSelectToken, result, selection, turnId }: RowProps & { call?: InputEntry; result?: InputEntry }) {
  const callItem = call?.item;
  const resultItem = result?.item;
  const presentation = callItem ? toolCallPresentation(callItem) : null;
  const readout = result?.readout;
  const plain = resultItem && !readout ? parseToolResult(capturedText(resultItem.output ?? resultItem.content ?? resultItem.text)) : null;
  const outcome = readout ?? plain;
  const failed = Boolean(outcome && /failed|error|timed out/i.test(outcome.status));
  const failedParts = readout?.parts.filter((part) => part.failure).length ?? 0;
  const namespace = textValue(callItem?.namespace);
  // Some clients have the model label its own call (Antigravity's `toolSummary`).
  const title = textValue(asRecord(presentation?.input).title) || textValue(asRecord(presentation?.input).toolSummary) || presentation?.preview || outcome?.status || "";
  const tokens = sumTokens([call, result].filter((entry): entry is InputEntry => Boolean(entry)));
  const blockIds = entryBlockIds([call, result]);
  const state = result?.rowState ?? call?.rowState;
  const marks = rowMarks([call, result], result && selectionHits([result], selection, turnId) ? "results" : "model", selection, turnId);
  return <Row accent={marks.accent} defaultOpen={defaultOpen || marks.open || isFresh(call, result)} dimmed={marks.dimmed} summary={<>
    <LinkSwatch blockIds={blockIds} category={call ? "model" : "results"} icon={TerminalIcon} label={call ? "Tool calls" : "Tool results"} onSelectToken={onSelectToken} selection={selection} turnId={turnId}/>
    <span className="shrink-0 font-mono text-sm text-ink">{namespace ? <span className="text-muted">{namespace}.</span> : null}{presentation?.name || "Tool result"}</span>
    <Meta>{title}</Meta>
    <RowEnd badge={failed ? <Badge tone="danger">failed</Badge> : failedParts ? <Badge tone="danger">{readout && readout.parts.length > 1 ? `${failedParts} failed` : "failed"}</Badge> : <StateBadge state={state}/>} tokens={tokens}/>
  </>}>
    <div className="space-y-4">
      {call && callItem && presentation ? <BlockAnchor blockIds={entryBlockIds([call])} turnId={turnId}>
        <BlockHeading aside={tokenAside(call.tokens)}>Call · {callSource(callItem, presentation.input)}{presentation.wrapperName ? ` · ${presentation.wrapperName}` : ""}</BlockHeading>
        <CallInput value={presentation.input}/>
      </BlockAnchor> : null}
      {result && resultItem && outcome ? <BlockAnchor blockIds={entryBlockIds([result])} turnId={turnId}>
        <BlockHeading aside={tokenAside(result.tokens)}>{["Result", outcome.status, outcome.elapsed && `wall ${outcome.elapsed}`, readout && readout.parts.length > 1 ? `${readout.parts.length} outputs` : ""].filter(Boolean).join(" · ")}</BlockHeading>
        {readout ? <ResultPartsView parts={readout.parts}/>
          : <ToolOutputView format={call?.outputFormat ?? result.outputFormat ?? TEXT_FORMAT} key={plain?.output.length} value={plain?.output ?? ""}/>}
      </BlockAnchor> : <p className="text-xs text-muted">{inResponse ? "The model called this tool in its response; the result is part of the next turn." : "The result is not part of this request."}</p>}
    </div>
  </Row>;
}

/* The command a nested call runs, as its first line. */
function callCommand(call: ToolCall): string {
  const input = asRecord(call.input);
  const source = CALL_SOURCE_KEYS.map((key) => input[key]).find((value): value is string => typeof value === "string") ?? "";
  const lines = source.trim().split("\n");
  return lines.length > 1 ? `${lines[0]} …` : lines[0];
}

/* Each output of a multi-part result under its own line: the nested call that
   produced it, its command, and only the facts worth a glance. */
function ResultPartsView({ parts }: { parts: ResultReadout["parts"] }) {
  if (!parts.length) return <EmptyState framed>The tool completed without captured output.</EmptyState>;
  const numbered = parts.length > 1;
  return <div className="space-y-4">{parts.map((part, position) => {
    const command = part.call ? callCommand(part.call) : "";
    const fullCommand = part.call ? textValue(CALL_SOURCE_KEYS.map((key) => asRecord(part.call?.input)[key]).find((value) => typeof value === "string")) : "";
    const headed = numbered || part.call || part.failure || part.facts.length || part.truncated;
    const title = headed ? <span className="flex min-w-0 flex-1 items-center gap-2">
      {numbered ? <span className="w-4 shrink-0 text-right font-mono">{position + 1}</span> : null}
      {part.call ? <span className="shrink-0 font-mono text-ink">{part.call.name}</span> : null}
      {command ? <span className="min-w-0 truncate font-mono" title={fullCommand}>{command}</span> : null}
      {part.failure ? <Badge tone="danger">{part.failure}</Badge> : null}
      {part.truncated ? <span className="shrink-0" title={[part.truncated.tokens && `Original ${part.truncated.tokens.toLocaleString()} tokens`, part.truncated.lines && `${part.truncated.lines.toLocaleString()} lines`].filter(Boolean).join(" · ")}><Badge tone="warning">truncated</Badge></span> : null}
      {part.facts.length ? <span className="shrink-0">{part.facts.join(" · ")}</span> : null}
      {part.tokens ? <span className="ml-auto shrink-0 font-mono">{part.tokens.tokens.toLocaleString()} tok</span> : null}
    </span> : undefined;
    const body = part.body;
    return <div className={position ? "border-t border-line pt-4" : undefined} key={part.partIndex}>
      {body.kind === "text" ? <ToolOutputView format={part.format} key={body.text.length} title={title} value={body.text}/>
        : <div className="space-y-2">
          {title ? <div className="flex items-center text-xs text-muted">{title}</div> : null}
          {body.kind === "value" ? <StructuredValue value={body.value}/>
            : <div className="flex flex-wrap items-center gap-2"><Badge mono>{body.type}</Badge><span className="text-xs text-muted">Attachment metadata is available in Raw JSON.</span></div>}
        </div>}
    </div>;
  })}</div>;
}

function GenericRow({ defaultOpen = false, entry, onSelectToken, selection, turnId }: RowProps & { entry: InputEntry }) {
  const blockIds = entryBlockIds([entry]);
  const marks = rowMarks([entry], entry.inputClass.category, selection, turnId);
  return <Row accent={marks.accent} defaultOpen={defaultOpen || marks.open || isFresh(entry)} dimmed={marks.dimmed} summary={<>
    <LinkSwatch blockIds={blockIds} category={entry.inputClass.category} label={entry.inputClass.label} onSelectToken={onSelectToken} selection={selection} turnId={turnId}/>
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
  if (Array.isArray(entry.item.tools)) return <ToolDefinitionRow entry={entry} tools={entry.item.tools} {...props}/>;
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
      <span className="grid size-5 shrink-0 place-items-center"><RowIcon icon={HistoryIcon}/></span>
      <span className="shrink-0 text-ink">Carried over</span>
      <Meta>{carriedItems} {carriedItems === 1 ? "item" : "items"} · {carriedSummary(carriedRows)}</Meta>
      <RowEnd badge={cacheBadge} tokens={carriedTokens}/>
    </>}><NestedRows>{carriedRows.map((entry) => <EntryRow entry={entry} key={entry.key} {...props}/>)}</NestedRows></Row> : null}
    {pairToolExchanges(rest).map((entry) => <EntryRow entry={entry} key={entry.key} {...props}/>)}
  </>;
}

function NestedRows({ children }: { children: ReactNode }) {
  return <div className="-ml-[1.625rem] divide-y divide-line overflow-hidden rounded-inset border border-line">{children}</div>;
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
  const swatches = [...new Map(entries.map((entry) => [entry.inputClass.label, entry.inputClass.category])).entries()];
  const matched = entries.find((entry) => selectionHits([entry], props.selection, props.turnId));
  return <Row accent={matched ? categoryColor(matched.inputClass.category) : undefined} defaultOpen={Boolean(matched)} dimmed={selectionIds(props.selection, props.turnId).length > 0 && !matched} summary={<>
    <span className="flex shrink-0 -space-x-1">{swatches.slice(0, 4).map(([label, category]) => <span className="rounded-mark ring-2 ring-panel" key={label}><CategorySwatch category={category}/></span>)}</span>
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
  return <section aria-label="Request settings" className="tf-card overflow-hidden">
    <header className="tf-inset flex min-h-11 items-center gap-2.5 py-1.5">
      <RowIcon icon={SlidersIcon}/>
      <h3 className="tf-heading shrink-0">Request settings</h3>
    </header>
    <div className="divide-y divide-line border-t border-line">
      {chips.length ? <div className="tf-inset flex flex-wrap gap-1.5 py-2.5">{chips.map((chip) => <Badge key={chip} mono>{chip}</Badge>)}</div> : null}
      <Row summary={<span className="text-muted">All settings</span>}>
        <div className="space-y-4">{visible.map(([title, facts]) => <section key={title}><h4 className="mb-1.5 text-xs font-medium text-muted">{title}</h4><dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">{facts.map(([label, value]) => <div className="contents" key={label}><dt className="text-muted">{label}</dt><dd className="min-w-0 break-all font-mono text-xs text-ink">{typeof value === "boolean" ? (value ? "on" : "off") : textValue(value) || "configured"}</dd></div>)}</dl></section>)}</div>
      </Row>
    </div>
  </section>;
}

/* Text of the nearest earlier Environment block, for field-level comparison. */
function earlierEnvironment(earlierTurns: TurnModel[]): string | undefined {
  for (let index = earlierTurns.length - 1; index >= 0; index -= 1) {
    const block = earlierTurns[index].blocks.find((candidate) => candidate.inputClass.label === "Environment");
    if (block) return block.text;
  }
  return undefined;
}

function RequestHeader({ turn }: { turn: TurnModel }) {
  const record = turn.record;
  const status = Number(record.response?.status || 0);
  const route = record.transport || `${record.request?.method || ""} ${record.request?.path || ""}`.trim();
  const facts = [turn.model, route, status ? String(status) : "", turn.durationMs ? formatDuration(turn.durationMs) : ""].filter(Boolean);
  return <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1 pb-1">
    <h3 className="tf-title min-w-0 max-w-full truncate">{turn.queryText || turn.title}</h3>
    <span className={`text-xs ${status >= 400 ? "text-danger" : "text-muted"}`}>{facts.join(" · ")}</span>
    <span className="ml-auto font-mono text-xs text-muted">{turn.input ? <>{formatNumber(turn.input)} in · {formatNumber(turn.cached)} cached · <span className="text-ink">{formatNumber(turn.fresh)} new</span></> : "Token usage unknown"}</span>
  </div>;
}

/* A chained request sends only new items. Say where the rest of its context came
   from, and say so plainly when the previous response was not captured. */
function ChainNote({ turn }: { turn: TurnModel }) {
  const { chainBroken, chainedFromTurn, chainedItems } = turn.context;
  const estimated = turn.categories.some((category) => category.estimated);
  const estimateNote = estimated ? " Within those measured totals, blocks are sized with a local tokenizer (≈)." : "";
  if (turn.cacheChain) return <p className="flex items-center gap-2 px-1 text-xs text-muted">
    <RowIcon icon={HistoryIcon}/>
    <span>From prompt-cache counts: {formatNumber(turn.cacheChain.carried)} tokens are Turn {turn.cacheChain.fromTurn}&apos;s prompt read from cache, and {formatNumber(turn.cacheChain.added)} tokens are the items added since.{estimateNote}</span>
  </p>;
  if (estimated) return <p className="flex items-center gap-2 px-1 text-xs text-muted">
    <RowIcon icon={HistoryIcon}/>
    <span>The provider reported only a total for this request. Categories size each block with a local tokenizer (≈), scaled to the measured {formatNumber(turn.input)} input tokens.</span>
  </p>;
  if (chainedFromTurn && chainedItems) return <p className="flex items-center gap-2 px-1 text-xs text-muted">
    <RowIcon icon={HistoryIcon}/>
    <span>Continues Turn {chainedFromTurn}: {formatNumber(chainedItems)} earlier {chainedItems === 1 ? "item comes" : "items come"} from that turn&apos;s captured request and output. Raw shows only the new items this request sent.</span>
  </p>;
  if (chainBroken) return <p className="flex items-center gap-2 px-1 text-xs text-muted">
    <RowIcon icon={HistoryIcon}/>
    <span>This request continues a response that was not captured, so only the new items it sent are shown.</span>
  </p>;
  return null;
}

function StructuredRequest({ earlierTurns, onSelectToken, selection, turn }: { earlierTurns: TurnModel[]; onSelectToken: (selection: TokenSelection | null) => void; selection: TokenSelection | null; turn: TurnModel }) {
  const record = turn.record;
  const turnId = turn.id;
  const body = asRecord(record.request?.body);
  const entries = useMemo(() => inputEntries(turn), [turn]);
  const previousEnvironment = useMemo(() => earlierEnvironment(earlierTurns), [earlierTurns]);
  const byLayer = new Map<InputLayer, InputEntry[]>();
  for (const entry of entries) byLayer.set(entry.inputClass.layer, [...(byLayer.get(entry.inputClass.layer) || []), entry]);
  const lastPromptKey = [...entries].reverse().find((entry) => entry.inputClass.label === "User prompt")?.key || "";
  const hasContent = entries.length > 0;
  const rowProps = { onSelectToken, selection, turnId };
  const contextChanges = (byLayer.get("context") || []).filter((entry) => entry.inputClass.label === "Environment" && (entry.section?.changes?.(capturedText(entry.part), previousEnvironment) || []).length).length;

  return <div className="tf-pad space-y-4">
    <ChainNote turn={turn}/>

    {LAYER_ORDER.map((layer) => {
      const layerEntries = byLayer.get(layer) || [];
      if (layer === "capabilities") {
        if (!layerEntries.length) return null;
        // Tool declarations read as a tool list; catalogs (skills, MCP servers, …)
        // are sections of text like any other.
        return <LayerSection entries={layerEntries} key={layer} layer={layer} selection={selection} turnId={turnId}>
          {layerEntries.map((entry) => <EntryRow entry={entry} key={entry.key} {...rowProps}/>)}
        </LayerSection>;
      }
      if (!layerEntries.length) return null;
      const badge = layer === "context" && contextChanges ? <Badge tone="warning">{contextChanges} changed</Badge> : undefined;
      return <LayerSection badge={badge} entries={layerEntries} key={layer} layer={layer} selection={selection} turnId={turnId}>
        {layer === "conversation"
          ? <ConversationRows entries={layerEntries} lastPromptKey={lastPromptKey} {...rowProps}/>
          : layer === "instructions"
            ? <InstructionRows entries={layerEntries} {...rowProps}/>
          : groupMinorRows(layerEntries).map((row) => Array.isArray(row)
            ? <MinorRowsGroup entries={row} key={`minor-${layer}`} {...rowProps}/>
            : <EntryRow entry={row} key={row.key} previous={previousEnvironment} {...rowProps}/>)}
      </LayerSection>;
    })}

    {!hasContent ? <EmptyState framed title="No message content">This request was captured without message content. Raw shows exactly what was recorded.</EmptyState> : null}

    {selection?.turnId === turnId && selection.label === "Unattributed input" ? <EmptyState framed title="No exact request section">This remainder was not attributed to a captured input block, so Token Flow does not guess a destination.</EmptyState> : null}

    <RequestSettings body={body} record={record}/>
  </div>;
}

/* ── Timeline ────────────────────────────────────────────────────────────────
   A turn is the moment the model is called; the conversation is the trajectory
   before it. The timeline reads that trajectory in order as steps by role: the
   user's prompt, the model's reasoning, messages, and tool calls (each with its
   result), results without a captured call, and context the harness injected.
   Capabilities and instructions precede the trajectory as request context;
   every input block remains inspectable in this projection.
   Steps the previous turn already had fold into "Earlier"; what this turn adds
   stays open, and the turn's own response closes the timeline. */

type StepRole = "user" | "model" | "tool" | "context" | "capabilities" | "instructions";

interface TimelineStep {
  entries: InputEntry[];
  fresh: boolean;
  key: string;
  role: StepRole;
}

const STEP_META: Record<StepRole, { icon: IconComponent; label: string }> = {
  capabilities: { icon: ToolIcon, label: "Capabilities" },
  instructions: { icon: BookIcon, label: "Instructions" },
  context: { icon: PinIcon, label: "Context" },
  model: { icon: SparkleIcon, label: "Model" },
  tool: { icon: TerminalIcon, label: "Tool" },
  user: { icon: UserIcon, label: "User" },
};

function stepRole(entry: InputEntry): StepRole {
  if (entry.inputClass.layer === "capabilities" || entry.inputClass.layer === "instructions") return entry.inputClass.layer;
  const kind = entry.part === undefined ? toolEventKind(entry.item) : null;
  if (kind === "result") return "tool";
  if (kind === "call") return "model";
  const label = entry.inputClass.label;
  if (label === "Tool results") return "tool";
  if (label === "Reasoning" || label === "Assistant messages" || label === "Tool calls") return "model";
  if (label === "User prompt") return "user";
  if (entry.inputClass.layer === "context") return "context";
  const role = textValue(entry.item.role).toLowerCase();
  return role === "assistant" || role === "model" ? "model" : role === "user" ? "user" : "context";
}

/* The turn's items as timeline steps; protocols that pack several steps into one
   message split them (see ProtocolAdapter.expand). */
function timelineItems(turn: TurnModel, items: unknown[]): unknown[] {
  const expand = turnPlugins(turn).protocol?.expand;
  return expand ? items.flatMap((item) => expand(item)) : items;
}

function previousInThread(turn: TurnModel, earlierTurns: TurnModel[]): TurnModel | undefined {
  return [...earlierTurns].reverse().find((candidate) => candidate.thread.id === turn.thread.id && candidate.protocol === turn.protocol);
}

/* Item ids the previous turn in this thread returned. The model's own steps first
   appear in the next request's input, so by input alone they would read as new. */
function previousOutputIds(turn: TurnModel, earlierTurns: TurnModel[]): Set<string> {
  const previous = previousInThread(turn, earlierTurns);
  const output = previous ? turnPlugins(previous).protocol?.output?.(previous.record) || [] : [];
  return new Set(output.map((item) => textValue(asRecord(item).id)).filter(Boolean));
}

function carriedBlockIds(turn: TurnModel, earlierTurns: TurnModel[]): Set<string> {
  const previous = previousInThread(turn, earlierTurns);
  if (!previous) return new Set();
  // Compare what a step says, not how it was serialized: a response and the next
  // request carry the same step with different envelopes (thinking signatures,
  // cache breakpoints, extra metadata fields).
  const signature = (entry: InputEntry) => {
    const item = entry.item;
    return stableValue({ arguments: item.arguments, call: item.call_id, name: item.name, output: item.output, category: entry.inputClass.category, text: capturedText(entry.part ?? item.content ?? item.summary ?? item.text), type: item.type });
  };
  const before = [...inputEntries(previous), ...inputEntries(previous, timelineItems(previous, turnPlugins(previous).protocol?.output?.(previous.record) || []))].map(signature);
  const entries = inputEntries(turn);
  const current = entries.map(signature);
  let shared = 0;
  while (shared < current.length && shared < before.length && current[shared] === before[shared]) shared += 1;
  return new Set(entries.slice(0, shared).map((entry) => entry.key));
}

function groupSteps(entries: InputEntry[], isFreshEntry: (entry: InputEntry) => boolean, prefix: string): TimelineStep[] {
  const steps: TimelineStep[] = [];
  for (const entry of pairToolExchanges(entries)) {
    const resultOnly = Boolean(entry.result && !isFreshEntry(entry) && isFreshEntry(entry.result));
    // A call from an earlier turn whose result arrives now is this turn's tool step.
    const role = resultOnly ? "tool" : stepRole(entry);
    const fresh = isFreshEntry(entry) || resultOnly;
    const last = steps[steps.length - 1];
    if (last && last.role === role && last.fresh === fresh) last.entries.push(entry);
    else steps.push({ entries: [entry], fresh, key: `${prefix}${entry.key}`, role });
  }
  return steps;
}

function stepSummary(step: TimelineStep): string {
  if (step.role === "user") return "";
  const calls = step.entries.filter((entry) => entry.part === undefined && toolEventKind(entry.item) === "call").length
    + step.entries.filter((entry) => entry.inputClass.label === "Tool calls" && entry.part !== undefined).length;
  const reasoning = step.entries.some((entry) => entry.inputClass.label === "Reasoning");
  const message = step.entries.some((entry) => entry.inputClass.label === "Assistant messages");
  if (step.role === "model") return [reasoning ? "reasoning" : "", message ? "message" : "", calls ? `${calls} ${calls === 1 ? "call" : "calls"}` : ""].filter(Boolean).join(" · ");
  return `${step.entries.length} ${step.entries.length === 1 ? "item" : "items"}`;
}

/* Claude Code often sends one long Guidelines document split into heading-sized
   blocks. Keep those blocks for search and raw provenance, while reading the
   document as one instruction in the inspector. */
function InstructionRows({ entries, ...props }: RowProps & { entries: InputEntry[] }) {
  const groups: InputEntry[][] = [];
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    if (last && last[0].inputClass.category === entry.inputClass.category && last[0].inputClass.label === entry.inputClass.label) last.push(entry);
    else groups.push([entry]);
  }
  return <>{groups.map((group) => group.length === 1
    ? <EntryRow entry={group[0]} key={group[0].key} {...props}/>
    : <InstructionGroupRow entries={group} key={group[0].key} {...props}/>)}</>;
}

function InstructionGroupRow({ entries, previous, ...props }: RowProps & { entries: InputEntry[]; previous?: string }) {
  const marks = rowMarks(entries, entries[0].inputClass.category, props.selection, props.turnId);
  const { category, label } = entries[0].inputClass;
  const blockIds = entryBlockIds(entries);
  return <Row accent={marks.accent} defaultOpen={marks.open || isFresh(...entries)} dimmed={marks.dimmed} summary={<>
    <LinkSwatch blockIds={blockIds} category={category} label={label} onSelectToken={props.onSelectToken} selection={props.selection} turnId={props.turnId}/>
    <span className="truncate text-ink">{label}</span>
    <RowEnd badge={<StateSummary entries={entries}/>} tokens={sumTokens(entries)}/>
  </>}><div className="space-y-3">{entries.map((entry) => <BlockAnchor blockIds={entryBlockIds([entry])} key={entry.key} turnId={props.turnId}><SectionContent previous={previous} section={entry.section} value={entry.part}/></BlockAnchor>)}</div></Row>;
}

function TimelineStepView({ open, outputTokens, rowProps, step, tone }: { open: boolean; outputTokens?: number; rowProps: RowProps; step: TimelineStep; tone?: "carried" | "response" }) {
  const meta = STEP_META[step.role];
  // Output has no per-item counts; the response shows the turn's measured output tokens.
  const tokens = tone === "response" ? (outputTokens ? { cached: 0, tokens: outputTokens } : undefined) : sumTokens(step.entries.flatMap((entry) => entry.result ? [entry, entry.result] : [entry]));
  const summary = stepSummary(step);
  return <li className={`t-row relative pl-8 ${tone === "carried" ? "opacity-70" : ""}`} data-layer={step.role === "capabilities" || step.role === "instructions" ? step.role : undefined} data-turn-id={rowProps.turnId}>
    <span aria-hidden="true" className={`absolute left-0 top-0.5 grid size-6 place-items-center rounded-full border bg-panel ${tone === "response" ? "border-ink text-ink" : "border-line text-muted"}`}><meta.icon className="size-3.5"/></span>
    <div className="mb-1.5 flex min-h-6 items-center gap-2 text-xs">
      <span className="font-semibold text-ink">{tone === "response" ? "Response" : meta.label}</span>
      {summary ? <span className="truncate text-muted">{summary}</span> : null}
      {step.fresh && tone !== "response" ? <Badge tone="success">new</Badge> : null}
      {tokens ? <span className="ml-auto font-mono tabular-nums text-muted">{tokens.tokens.toLocaleString()}</span> : null}
    </div>
    <div className="divide-y divide-line overflow-hidden rounded-inset border border-line">
      {step.role === "instructions" ? <InstructionRows entries={step.entries} {...rowProps}/> : step.entries.map((entry) => <EntryRow entry={entry} key={entry.key} {...rowProps} defaultOpen={open && step.role !== "context"} inResponse={tone === "response"}/>)}
    </div>
  </li>;
}

/* A run of steps this request carries from before, folded to one line. */
function CarriedSteps({ label, note, rowProps, steps }: { label: string; note: string; rowProps: RowProps; steps: TimelineStep[] }) {
  const selected = steps.some((step) => step.entries.some((entry) => selectionHits([entry, entry.result], rowProps.selection, rowProps.turnId)));
  const { open, toggle } = useAccordion(selected);
  if (!steps.length) return null;
  return <li className="relative pl-8">
    <span aria-hidden="true" className="absolute left-0 top-0 grid size-6 place-items-center rounded-full border border-line bg-panel text-muted"><HistoryIcon className="size-3.5"/></span>
    <button aria-expanded={open} className="flex min-h-6 items-center gap-2 text-xs text-muted hover:text-ink" onClick={toggle} type="button">
      <ChevronRightIcon className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`}/>
      <span className="font-semibold">{label}</span>
      <span>{steps.length} {steps.length === 1 ? "step" : "steps"} {note}</span>
    </button>
    {open ? <ol className="mt-3 space-y-5">{steps.map((step) => <TimelineStepView key={step.key} open={false} rowProps={rowProps} step={step} tone="carried"/>)}</ol> : null}
  </li>;
}

function TimelineRequest({ earlierTurns, onSelectToken, selection, turn }: { earlierTurns: TurnModel[]; onSelectToken: (selection: TokenSelection | null) => void; selection: TokenSelection | null; turn: TurnModel }) {
  const entries = useMemo(() => inputEntries(turn), [turn]);
  const carried = useMemo(() => carriedBlockIds(turn, earlierTurns), [earlierTurns, turn]);
  const returned = useMemo(() => previousOutputIds(turn, earlierTurns), [earlierTurns, turn]);
  const isFreshEntry = (entry: InputEntry) => entry.state !== "carried" && !carried.has(entry.key) && !returned.has(entry.itemId);
  const requestContext = (entry: InputEntry) => entry.inputClass.layer === "capabilities" || entry.inputClass.layer === "instructions";
  const contextSteps = groupSteps(entries.filter(requestContext), () => false, "context:");
  const steps = groupSteps(entries.filter((entry) => !requestContext(entry)), isFreshEntry, "in:");
  const output = useMemo(() => timelineItems(turn, turnPlugins(turn).protocol?.output?.(turn.record) || []), [turn]);
  const response = useMemo(() => groupSteps(inputEntries(turn, output), () => true, "out:"), [output, turn]);
  const rowProps: RowProps = { onSelectToken, selection, turnId: turn.id };

  // Steps stay in order. Carried steps fold in two runs around the prompt that
  // started this query, which stays visible so the new steps have their context.
  const firstFresh = steps.findIndex((step) => step.fresh);
  const splitAt = firstFresh < 0 ? steps.length : firstFresh;
  const promptIndex = steps.slice(0, splitAt).map((step) => step.role).lastIndexOf("user");
  const beforePrompt = promptIndex >= 0 ? steps.slice(0, promptIndex) : steps.slice(0, splitAt);
  const prompt = promptIndex >= 0 ? steps[promptIndex] : undefined;
  const sincePrompt = promptIndex >= 0 ? steps.slice(promptIndex + 1, splitAt) : [];
  const current = steps.slice(splitAt);

  return <div className="space-y-4 tf-pad">
    <ChainNote turn={turn}/>
    <ol className="relative space-y-5 before:absolute before:bottom-3 before:left-3 before:top-3 before:w-px before:bg-line">
      {contextSteps.map((step) => <TimelineStepView key={step.key} open={false} rowProps={rowProps} step={step}/>)}
      <CarriedSteps label="Earlier" note="before this query" rowProps={rowProps} steps={beforePrompt}/>
      {prompt ? <TimelineStepView key={prompt.key} open rowProps={rowProps} step={prompt}/> : null}
      <CarriedSteps label="So far" note="in this query, before this turn" rowProps={rowProps} steps={sincePrompt}/>
      {current.map((step) => <TimelineStepView key={step.key} open rowProps={rowProps} step={step}/>)}
      {response.map((step, index) => <TimelineStepView key={step.key} open outputTokens={index === 0 ? turn.output : undefined} rowProps={{ ...rowProps, selection: null }} step={step} tone="response"/>)}
    </ol>
    {!entries.length && !response.length ? <EmptyState framed>No conversation items were captured for this turn.</EmptyState> : null}
  </div>;
}

function RequestBody({ earlierTurns, focusPath, mode, onSelectToken, selection, turn }: { earlierTurns: TurnModel[]; focusPath?: JsonPathPart[] | null; mode: RequestMode; onSelectToken: (selection: TokenSelection | null) => void; selection: TokenSelection | null; turn: TurnModel }) {
  const record = turn.record;
  const turnId = turn.id;
  const selectedPath = useMemo(() => focusPath || selectedJsonPath(turn, selection, turnId), [focusPath, turn, selection, turnId]);
  const source = selection?.turnId === turnId ? turn.blocks.find((block) => block.id === selection.blockId) : undefined;
  const selectedRange = source?.rawPath && selectedPath && source.rawPath.length === selectedPath.length && source.rawPath.every((part, index) => part === selectedPath[index]) ? source.rawRange : undefined;
  if (mode === "timeline") return <TimelineRequest earlierTurns={earlierTurns} onSelectToken={onSelectToken} selection={selection} turn={turn}/>;
  if (mode === "structured") return <StructuredRequest earlierTurns={earlierTurns} onSelectToken={onSelectToken} selection={selection} turn={turn}/>;
  return <div className="tf-pad">{selection?.turnId === turnId && !selectedPath ? <p className="mb-3 text-xs text-muted">No exact raw location is available for this selection in the current request.</p> : null}<div className="tf-card overflow-hidden"><RawJsonTree selectedBlockId={selection?.turnId === turnId ? selection.blockId : undefined} selectedPath={selectedPath} selectedRange={selectedRange} turnId={turnId} value={record}/></div></div>;
}


type InspectorJump = TokenSelection & { nonce: number; path?: JsonPathPart[]; query?: string };

/* The shared selection, named in its category color. A category that spans several
   blocks can be stepped through here; each step opens and scrolls to that block. */
function SelectionChip({ onJump, onSelectToken, selection }: { onJump: (selection: TokenSelection) => void; onSelectToken: (selection: TokenSelection | null) => void; selection: TokenSelection }) {
  // Canonical blocks, not their carrier: one system field can contain many
  // independently classified instructions, and every one must be reachable.
  const ids = [...new Set(selection.layer ? [] : selection.blockIds || [selection.blockId])];
  const position = Math.max(0, ids.indexOf(selection.blockId));
  const move = (delta: number) => {
    const next = { ...selection, blockId: ids[(position + delta + ids.length) % ids.length] };
    onSelectToken(next);
    onJump(next);
  };
  return <span className="tf-control inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-canvas pl-2.5 pr-1 text-xs">
    <CategorySwatch category={selection.category} layer={selection.layer}/>
    <span className="max-w-40 truncate font-medium text-ink">{selection.label}{selection.layer ? " layer" : ""}</span>
    {ids.length > 1 ? <span className="flex items-center font-mono text-xs text-muted">
      <button aria-label="Previous matching block" className="grid size-11 place-items-center rounded-full hover:bg-fill-hover hover:text-ink" onClick={() => move(-1)} type="button"><ChevronLeftIcon className="size-4"/></button>
      {position + 1}/{ids.length}
      <button aria-label="Next matching block" className="grid size-11 place-items-center rounded-full hover:bg-fill-hover hover:text-ink" onClick={() => move(1)} type="button"><ChevronRightIcon className="size-4"/></button>
    </span> : null}
    <button aria-label="Clear selection" className="grid size-11 place-items-center rounded-full text-muted hover:bg-fill-hover hover:text-ink" onClick={() => onSelectToken(null)} type="button"><CloseIcon className="size-4"/></button>
  </span>;
}

function SearchResults({ current, hits, onPick, query }: { current: number; hits: SearchHit[]; onPick: (index: number) => void; query: string }) {
  return <div className="t-dropdown-enter border-t border-line">
    <div className="tf-inset flex items-center justify-between gap-3 py-1.5 text-xs text-muted">
      <span>{hits.length >= SEARCH_HIT_LIMIT ? `${SEARCH_HIT_LIMIT}+` : hits.length} {hits.length === 1 ? "match" : "matches"}{current >= 0 ? ` · ${current + 1} of ${hits.length}` : ""}</span>
      <span className="hidden sm:inline">Enter next · Shift+Enter previous · Esc clears</span>
    </div>
    {hits.length ? <ol className="max-h-64 overflow-y-auto border-t border-line">{hits.map((hit, index) => <li key={hit.key}>
      <button aria-current={index === current ? "true" : undefined} className={`tf-inset tf-focus-inset grid w-full gap-0.5 py-2 text-left ${index === current ? "bg-fill-selected" : "hover:bg-fill-hover"}`} onClick={() => onPick(index)} type="button">
        <span className="flex min-w-0 items-center gap-2 text-xs">
          <Swatch color={hit.color || "var(--line)"}/>
          <span className="truncate font-medium text-ink">{hit.location}</span>
          <code className="ml-auto hidden max-w-[45%] truncate font-mono text-xs text-muted sm:block">{hit.pathText.replace(/^trace\.?/, "")}</code>
        </span>
        <span className="truncate pl-[18px] text-xs text-muted">{hit.before}<mark className="rounded-mark bg-highlight-soft px-0.5 text-ink">{hit.match}</mark>{hit.after}</span>
      </button>
    </li>)}</ol> : <p className="tf-inset border-t border-line py-3 text-xs text-muted">Nothing in this turn&apos;s captured request or response contains “{query}”.</p>}
  </div>;
}

/* The turn level of the workspace: one selected turn's request, beside the flow. */
export function RequestView({ jumpToBlock, onNavigate, onSelectToken, onViewChange, selection, turn, turns, view }: { jumpToBlock: (TokenSelection & { nonce: number }) | null; onNavigate: (index: number | null) => void; onSelectToken: (selection: TokenSelection | null) => void; onViewChange: (view: RequestViewMode) => void; selection: TokenSelection | null; turn: TurnModel; turns: TurnModel[]; view: RequestViewMode }) {
  const scope = view === "changes" ? "changes" : "turn";
  const mode: RequestMode = view === "changes" ? "timeline" : view;
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState({ index: -1, query: "" });
  const [listOpen, setListOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [localJump, setLocalJump] = useState<InspectorJump | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const rangesRef = useRef<Range[]>([]);
  const selectedIndex = turns.findIndex((item) => item.id === turn.id);
  const previous = previousInThread(turn, turns.slice(0, Math.max(0, selectedIndex)));
  // Turn changes update the request in place instead of replacing it: rows that
  // persist keep their place and open state, and only the rows this turn brings in
  // enter (Row enter). The flag is set in the same render as the new turn, so the
  // entering rows commit with it and start from their entry style.
  const [shownTurn, setShownTurn] = useState(turn.id);
  const [rowMotion, setRowMotion] = useState(false);
  if (turn.id !== shownTurn) {
    setShownTurn(turn.id);
    setRowMotion(true);
  }
  useEffect(() => {
    if (!rowMotion) return;
    const timer = window.setTimeout(() => setRowMotion(false), motionMs("--row-enter-dur", 900));
    return () => window.clearTimeout(timer);
  }, [rowMotion, shownTurn]);
  const searching = scope === "turn" && query.trim().length >= MIN_QUERY;
  const hits = useMemo(() => (searching ? searchRecord(turn.record, query, turn.blocks) : []), [query, searching, turn]);
  const current = cursor.query === query ? cursor.index : -1;
  // The newest request to reveal something wins, whether it came from the flow or from here.
  const jump = [jumpToBlock as InspectorJump | null, localJump]
    .filter((item): item is InspectorJump => Boolean(item && item.turnId === turn.id && (item.blockId ? selection?.blockId === item.blockId : !selection)))
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
      const target = jump.path && mode === "raw"
        ? body.querySelector<HTMLElement>('[data-json-selected="true"] [data-source-range]') ?? body.querySelector<HTMLElement>('[data-json-selected="true"]')
        : [...body.querySelectorAll<HTMLElement>(jump.layer ? "[data-layer]" : "[data-block-id]")].find((element) => element.dataset.turnId === jump.turnId && (jump.layer ? element.dataset.layer === jump.layer : element.dataset.blockId === jump.blockId));
      if (!target) return;
      if (jump.query) {
        rangesRef.current = highlightMatches(body, jump.query);
        focusMatch(jump.path && mode === "raw" ? target : target.closest("[data-block-anchor]") ?? target, rangesRef.current);
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
    if (hit.blockId) {
      const next: TokenSelection = { blockId: hit.blockId, blockIds: [hit.blockId], category: hit.category, label: hit.label, turnId: turn.id };
      onSelectToken(next);
      setLocalJump({ ...next, ...reveal, path: hit.path });
    } else {
      // Raw locations have no node in the flow, so the flow selection is cleared.
      onSelectToken(null);
      onViewChange("raw");
      setLocalJump({ blockId: "", label: hit.label, path: hit.path, ...reveal });
    }
  };
  const openSearch = () => {
    if (view === "changes") onViewChange("timeline");
    setSearchOpen(true);
    window.requestAnimationFrame(() => searchRef.current?.focus());
  };
  const onSearchKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
      setSearchOpen(false);
    } else if (event.key === "Enter" && hits.length) {
      event.preventDefault();
      goTo((current + (event.shiftKey ? -1 : 1) + hits.length) % hits.length);
    }
  };

  return <section aria-label={`Turn ${turn.label}`} className="tf-panel">
    <div className="sticky top-0 z-(--z-sticky) rounded-t-panel border-b border-line bg-panel lg:top-(--tf-toolbar-height)" data-search-ignore="">
      <div className="tf-inset flex flex-wrap items-center gap-1 py-2">
        <IconButton className="-ml-2" label="Back to overview" onClick={() => onNavigate(null)} title="Overview (Esc)"><ArrowLeftIcon/></IconButton>
        <div className="flex items-center">
          <IconButton disabled={selectedIndex <= 0} label="Previous turn" onClick={() => step(-1)} title="Previous turn (↑)"><ChevronLeftIcon/></IconButton>
          <span className="whitespace-nowrap px-1 text-sm"><span className="font-medium">Turn {turn.label}</span><span className="text-muted"> of {turns.length}</span></span>
          <IconButton disabled={selectedIndex >= turns.length - 1} label="Next turn" onClick={() => step(1)} title="Next turn (↓)"><ChevronRightIcon/></IconButton>
        </div>
        {selection?.turnId === turn.id ? <SelectionChip onJump={(next) => setLocalJump({ ...next, nonce: Date.now() })} onSelectToken={onSelectToken} selection={selection}/> : null}
        <div className="ml-auto flex items-center gap-1">
          <Segmented label="Request view" onChange={onViewChange} options={[["timeline", "Timeline"], ["structured", "Tokens"], ["raw", "Raw"], ["changes", "Changes"]]} value={view}/>
          <IconButton active={searchOpen || Boolean(query)} aria-expanded={searchOpen || Boolean(query)} className="-mr-2" label="Search this turn" onClick={() => { if (searchOpen || query) { setSearchOpen(false); setQuery(""); } else openSearch(); }}><SearchIcon/></IconButton>
        </div>
      </div>
      {scope === "turn" && (searchOpen || query) ? <div className="tf-inset flex items-center gap-2 pb-2">
        <SearchField autoFocus inputRef={searchRef} label="Search this turn" onChange={(value) => { setQuery(value); setListOpen(true); }} onKeyDown={onSearchKey} placeholder="Search this turn's request and response" value={query}/>
        {searching && hits.length ? <Button aria-expanded={listOpen} className="-mr-2" compact onClick={() => setListOpen(!listOpen)} variant="ghost">{listOpen ? "Hide list" : `Show ${hits.length}`}</Button> : null}
      </div> : null}
      {searching && listOpen ? <SearchResults current={current} hits={hits} onPick={goTo} query={query}/> : null}
    </div>
    <div data-row-motion={rowMotion ? "enter" : undefined} ref={bodyRef}>
      <div className="tf-inset pt-3 sm:pt-4"><RequestHeader turn={turn}/></div>
      {scope === "changes" ? <RequestChanges current={turn} onSelectToken={onSelectToken} previous={previous} selection={selection}/> : <RequestBody earlierTurns={turns.slice(0, Math.max(0, selectedIndex))} focusPath={mode === "raw" ? jump?.path : null} mode={mode} onSelectToken={onSelectToken} selection={selection} turn={turn}/>}
    </div>
  </section>;
}
