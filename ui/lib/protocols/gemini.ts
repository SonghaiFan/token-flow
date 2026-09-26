import { asNumber, asObject, type AnyObject } from "../json";
import type { InputClass } from "../types";
import type { ProtocolAdapter } from "./types";
import { promptUsage, responseBody, usageObject } from "./usage";

/* Gemini `generateContent`, including Code Assist's `v1internal` wrapper that
   nests the request and response under `request` / `response`. */
function geminiRequest(body: AnyObject): AnyObject {
  const nested = asObject(body.request);
  return Object.keys(nested).length ? nested : body;
}

function geminiResponse(body: AnyObject): AnyObject {
  const nested = asObject(body.response);
  return Array.isArray(nested.candidates) || nested.usageMetadata ? nested : body;
}

function partClass(part: AnyObject): InputClass | undefined {
  if (part.functionCall !== undefined) return { layer: "conversation", label: "Tool calls" };
  if (part.functionResponse !== undefined) return { layer: "conversation", label: "Tool results" };
  if (part.thought === true) return { layer: "conversation", label: "Reasoning" };
  return undefined;
}

/* A function response's readable output: the `output` or `result` field most
   tools return, or the whole response object. */
function responseOutput(response: unknown): string {
  const record = asObject(response);
  for (const key of ["output", "result", "content"]) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  return JSON.stringify(response ?? {});
}

/* One content as timeline steps. Gemini packs a turn into parts: thought text is
   reasoning, `functionCall` and `functionResponse` are a call and its result
   (joined by id, or by name when the client sends no id), and text is a message.
   A part that carries only a thought signature holds no readable content. */
function expandContent(item: unknown): unknown[] {
  const content = asObject(item);
  const parts = content.parts;
  if (!Array.isArray(parts)) return [item];
  const role = content.role === "model" ? "assistant" : String(content.role || "user");
  const steps: unknown[] = [];
  let text: unknown[] = [];
  const flush = () => {
    if (text.length) steps.push({ role, content: text });
    text = [];
  };
  for (const raw of parts) {
    const part = asObject(raw);
    if (part.thought === true) {
      flush();
      steps.push({ type: "reasoning", summary: typeof part.text === "string" && part.text ? [{ type: "summary_text", text: part.text }] : [] });
    } else if (part.functionCall !== undefined) {
      flush();
      const call = asObject(part.functionCall);
      steps.push({ type: "function_call", name: call.name, call_id: call.id ?? call.name, arguments: JSON.stringify(call.args ?? {}) });
    } else if (part.functionResponse !== undefined) {
      flush();
      const result = asObject(part.functionResponse);
      steps.push({ type: "function_call_output", call_id: result.id ?? result.name, output: responseOutput(result.response) });
    } else if (typeof part.text === "string" && part.text) text.push({ type: "text", text: part.text });
  }
  flush();
  return steps;
}

export const gemini: ProtocolAdapter = {
  id: "gemini",
  matches: (_record, path) => path.includes("generatecontent"),
  usage(record) {
    const metadata = asObject(geminiResponse(responseBody(record)).usageMetadata);
    if (!Object.keys(metadata).length) return promptUsage(usageObject(record), false);
    // Gemini counts cached content inside the prompt and bills thoughts as output.
    const input = asNumber(metadata.promptTokenCount);
    return {
      input,
      cached: Math.min(input, asNumber(metadata.cachedContentTokenCount)),
      output: asNumber(metadata.candidatesTokenCount) + asNumber(metadata.thoughtsTokenCount),
    };
  },
  expand: expandContent,
  // Gemini's reply role is "model"; timelines read it as the assistant.
  output: (record) => {
    const candidates = geminiResponse(responseBody(record)).candidates;
    const content = Array.isArray(candidates) ? asObject(asObject(candidates[0]).content) : {};
    return Object.keys(content).length ? [{ ...content, role: "assistant" }] : [];
  },
  system: (body) => {
    const request = geminiRequest(body);
    const system = request.system_instruction ?? request.systemInstruction;
    const parts = asObject(system).parts;
    return Array.isArray(parts) ? parts : system;
  },
  // Declarations come grouped as `{functionDeclarations: [...]}`; built-in tools
  // such as `{googleSearch: {...}}` are one entry named by their key.
  tools(body) {
    const tools = geminiRequest(body).tools;
    return (Array.isArray(tools) ? tools : []).flatMap((raw) => {
      const tool = asObject(raw);
      if (Array.isArray(tool.functionDeclarations)) return tool.functionDeclarations;
      return Object.entries(tool).map(([name, config]) => ({ name, ...asObject(config) }));
    });
  },
  items(body) {
    const contents = geminiRequest(body).contents;
    return Array.isArray(contents) ? contents : [];
  },
  partClass,
  isToolResultPart: (part) => part.functionResponse !== undefined,
};
