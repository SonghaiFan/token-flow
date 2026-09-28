import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RequestView } from "../components/workspace/request-view";
import { RawJsonTree } from "../components/workspace/raw-json-tree";
import { nodesFor } from "../components/workspace/turn-flow";
import { searchRecord } from "../components/workspace/request-search";
import { buildTurns, classifyInput, estimateTexts } from "./token-model";
import { claude } from "./agents/claude";
import type { TraceRecord } from "./types";
import { turnScopes } from "./conversation-scope";
import { fullyCachedBlockIds, selectedBlocks } from "./cross-link";

// Synthetic evidence only: no local conversation data belongs in fixtures.
const capturedRequest = (text: string, turn: number): TraceRecord => ({
  turn, ...{ capture: { client: "codex" } },
  request: { path: "/v1/responses", body: {
    client_metadata: { thread_id: "shared-thread", turn_id: `turn-${turn}` },
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }],
  } },
  response: { body: { usage: { input_tokens: 100, output_tokens: 10 } } },
});
const rolloutText = 'Analyze this rollout and produce JSON\n\n- rollout_path: /synthetic/history.jsonl\nrendered conversation (pre-rendered from rollout `.jsonl`; filtered response items):\n[{"type":"message","role":"user","content":[]}]';
const scopedTurns = buildTurns([capturedRequest("Hello", 1), capturedRequest(rolloutText, 2), capturedRequest(rolloutText, 3), capturedRequest("Hello", 4)]);
assert.deepEqual(turnScopes(scopedTurns), ["conversation", "background", "background", "conversation"]);
assert(scopedTurns.every((turn) => turn.thread.id === "shared-thread"), "Preserve captured thread identity");
assert.notEqual(scopedTurns[1].thread.scopeId, scopedTurns[2].thread.scopeId, "Do not invent continuity between summary requests");
assert.equal(Boolean(scopedTurns[3].change?.rewritten), false);
assert.deepEqual(turnScopes(buildTurns([capturedRequest("Analyze this rollout and produce JSON", 1)])), ["conversation"], "A phrase alone is not rollout evidence");

const fixtures: TraceRecord[] = [
  { request: { path: "/v1/messages", body: { system: "Instructions", messages: [
    { role: "user", content: [{ type: "text", text: "Hello" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "Consider" }, { type: "tool_use", id: "call-a", name: "lookup", input: { q: "hello" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call-a", content: "Found" }] },
  ] } }, response: { body: { usage: { input_tokens: 100, output_tokens: 10 } } } },
  { request: { path: "/v1/models/example:generateContent", body: { contents: [
    { role: "user", parts: [{ text: "Hello" }] },
    { role: "model", parts: [{ text: "Consider", thought: true }, { functionCall: { id: "call-a", name: "lookup", args: { q: "hello" } } }] },
    { role: "user", parts: [{ functionResponse: { id: "call-a", name: "lookup", response: { output: "Found" } } }] },
  ] } }, response: { body: { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 } } } },
  { request: { path: "/v1/responses", body: { input: [
    { id: "msg-a", type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] },
    { id: "call-a", type: "function_call", call_id: "call-a", name: "lookup", arguments: "{}" },
    { id: "result-a", type: "function_call_output", call_id: "call-a", output: "Found" },
  ] } }, response: { body: { usage: { input_tokens: 100, output_tokens: 10, attribution: { items: {
    "msg-a": { input_tokens: 20 }, "call-a": { input_tokens: 30 }, "result-a": { input_tokens: 50 },
  } } } } } },
];

for (const fixture of fixtures) {
  const initial = buildTurns([fixture]);
  const estimates = new Map(estimateTexts(initial).map((text) => [text, Math.max(1, text.length)]));
  const [turn] = buildTurns([fixture], estimates);
  assert.equal(turn.input, 100);
  assert.equal(turn.categories.reduce((sum, category) => sum + category.tokens, 0), 100);
  assert.equal(new Set(turn.blocks.map((block) => block.id)).size, turn.blocks.length);
  assert.deepEqual(turn.blocks.map((block) => block.id), initial[0].blocks.map((block) => block.id));
  assert(turn.blocks.some((block) => block.item.type === "function_call"));
  assert(turn.blocks.some((block) => block.item.type === "function_call_output"));
  for (const category of turn.categories) {
    for (const id of category.memberIds ?? []) assert(turn.blocks.some((block) => block.id === id));
  }
  for (const block of turn.blocks.filter((block) => block.itemIndex >= 0)) assert(block.rawPath, "Input block must locate its captured source");
}

const [responses] = buildTurns([fixtures[2]]);
assert.deepEqual(responses.categories.find((category) => category.id === "msg-a")?.memberIds, ["msg-a:0"]);
const [anthropic] = buildTurns([fixtures[0]], new Map(estimateTexts(buildTurns([fixtures[0]])).map((text) => [text, 1])));
assert(anthropic.categories.some((category) => category.memberIds?.includes("@input.1:1")));
assert.equal(anthropic.blocks.find((block) => block.id === "@input.1:1")?.itemId, "", "Local identity is not a captured item id");

const chain: TraceRecord[] = [
  { ...fixtures[2], turn: 1, response: { body: { id: "response-a", output: [{ id: "reply-a", type: "message", role: "assistant", content: [{ type: "output_text", text: "Reply" }] }], usage: { input_tokens: 100 } } } },
  { turn: 2, request: { path: "/v1/responses", body: { previous_response_id: "response-a", input: [{ id: "msg-b", role: "user", content: "Next" }] } }, response: { body: { usage: { input_tokens: 110 } } } },
];
const chained = buildTurns(chain)[1];
assert(chained.blocks.find((block) => block.itemId === "reply-a"));
assert.equal(chained.blocks.find((block) => block.itemId === "reply-a")?.rawPath, undefined, "Inherited context has no location in this request");
assert.deepEqual(chained.blocks.find((block) => block.itemId === "msg-b")?.rawPath, ["trace", "request", "body", "input", 0, "content"]);

const [chat] = buildTurns([{ request: { path: "/v1/chat/completions", body: { messages: [{ role: "assistant", content: "Text", reasoning_content: "Thought", tool_calls: [{ id: "call-a", type: "function", function: { name: "lookup", arguments: "{}" } }] }] } }, response: { body: { usage: { prompt_tokens: 30 } } } }]);
assert.equal(chat.blocks.length, 3, "Text, reasoning and sibling calls each occur once");
assert.equal(chat.blocks.filter((block) => block.item.type === "function_call").length, 1);
console.log("Token model: four protocols, stable identity, source paths, chained context, membership and conserved totals passed.");

// Regression: a tool-heavy Claude request must still expose small categories,
// and every input category must have real content in Timeline, not a redirect.
const claudeFixture: TraceRecord = {
  ...{ capture: { client: "claude" } },
  request: { path: "/v1/messages", body: {
    tools: [{ name: "lookup", description: "Tool description. ".repeat(1000), input_schema: { type: "object" } }],
    system: [{ type: "text", text: "You are Claude Code.\n# MCP Server Instructions\nUse tools safely." }],
    messages: [{ role: "user", content: [
      { type: "text", text: "<system-reminder>Codebase and user instructions: synthetic project rules</system-reminder>" },
      { type: "text", text: "<system-reminder>As you answer the user's questions, you can use the following context: synthetic date</system-reminder>" },
      { type: "text", text: "Hello fixture" },
    ] }],
  } },
  response: { body: { usage: { input_tokens: 10000, output_tokens: 1 } } },
};
const claudeEstimates = new Map(estimateTexts(buildTurns([claudeFixture])).map((text) => [text, text.length]));
const [claudeTurn] = buildTurns([claudeFixture], claudeEstimates);
assert(claudeTurn.categories.find((category) => category.category === "tools")!.tokens > 9700);
assert.equal(claudeTurn.blocks.find((block) => block.text.startsWith("# MCP"))?.inputClass.category, "harness");
assert.deepEqual(nodesFor(claudeTurn, "categories").map((node) => node.category), ["tools", "harness", "project", "runtime", "user"]);
const select = { turnId: claudeTurn.id, blockId: "@tools", blockIds: ["@tools"], category: "tools" as const, label: "Tools & capabilities" };
const markup = renderToStaticMarkup(createElement(RequestView, {
  jumpToBlock: null, onNavigate: () => {}, onSelectToken: () => {}, onViewChange: () => {},
  selection: select, turn: claudeTurn, turns: [claudeTurn], view: "timeline",
}));
assert(markup.includes('data-layer="capabilities"'));
assert(markup.includes('data-layer="instructions"'));
assert(markup.includes('aria-label="Unlink Tool definitions"'));
assert(markup.includes("lookup"), "Selected capability must expose the actual tool definition");
assert(markup.includes("Hello fixture"));
assert(!markup.includes("Show in Tokens"));
console.log("Claude UI: dominant tools preserve all categories; Timeline exposes and links request context.");

const focusFixture: TraceRecord = {
  ...{ capture: { client: "codex" } },
  request: { path: "/v1/responses", body: { input: [
    { type: "message", role: "developer", content: [{ type: "input_text", text: "Cached instruction fixture" }] },
    { type: "message", role: "developer", content: [{ type: "input_text", text: "Fresh instruction fixture" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Unrelated user fixture" }] },
  ] } }, response: { body: { usage: { input_tokens: 300, output_tokens: 10 } } },
};
const [focusTurn] = buildTurns([focusFixture]);
const conversationMarkup = renderToStaticMarkup(createElement(RequestView, { jumpToBlock: null, onNavigate: () => {}, onSelectToken: () => {}, onViewChange: () => {}, selection: null, turn: focusTurn, turns: [focusTurn], view: "timeline" }));
assert(conversationMarkup.includes("Request context"), "Timeline has one context disclosure");
assert(!conversationMarkup.includes("Cached instruction fixture"), "Request context starts collapsed");
assert(conversationMarkup.includes("Unrelated user fixture"), "User message body is immediately readable");
assert(conversationMarkup.includes("tf-dialog-user"), "Dialog uses a right-aligned user bubble");
assert(conversationMarkup.includes('aria-label="User message"'), "Dialog preserves accessible speaker identity");
assert(!conversationMarkup.includes(">Earlier<") && !conversationMarkup.includes(">So far<"), "Conversation history is not hidden behind carried groups");
focusTurn.categories = focusTurn.blocks.map((block, index) => ({ id: block.id, memberIds: [block.id], label: block.inputClass.label, category: block.inputClass.category, layer: block.inputClass.layer, tokens: 100, cached: index === 0 ? 100 : 0, fresh: index === 0 ? 0 : 100, color: "gray" }));
const layerSelection = { turnId: focusTurn.id, blockId: focusTurn.blocks[0].id, label: "Instructions", layer: "instructions" as const };
assert.equal(selectedBlocks(focusTurn, layerSelection).length, 2);
assert.deepEqual([...fullyCachedBlockIds(focusTurn)], [focusTurn.blocks[0].id]);
for (const view of ["timeline", "structured", "raw"] as const) {
  const html = renderToStaticMarkup(createElement(RequestView, { jumpToBlock: null, onNavigate: () => {}, onSelectToken: () => {}, onViewChange: () => {}, selection: layerSelection, turn: focusTurn, turns: [focusTurn], view }));
  assert(html.includes("Cached instruction fixture"), `${view} opens cached match`);
  assert(html.includes("Fresh instruction fixture"), `${view} opens all matches`);
  assert(html.includes('data-cache-state="cached"'), `${view} marks cached content`);
  assert(html.includes('aria-label="Next matching block"'), `${view} allows navigating layer matches`);
  assert(html.includes('aria-label="Previous matching block"'), `${view} allows returning to the previous match`);
  assert(html.includes('aria-expanded="false"'), `${view} folds unrelated content`);
}
const mixedTurn = { ...focusTurn, categories: [{ ...focusTurn.categories[0], memberIds: focusTurn.blocks.map((block) => block.id), tokens: 300, cached: 150, fresh: 150 }] };
assert.equal(fullyCachedBlockIds(mixedTurn).size, 0, "Mixed aggregate cannot identify cached members");
console.log("Cross-link: all views open matching blocks, fold unrelated content and preserve cache evidence.");
const rangeMarkup = renderToStaticMarkup(createElement(RawJsonTree, {
  active: true, turnId: "fixture", value: { text: "firstsecond" },
  selectedPath: ["trace", "text"], selectedRange: { start: 5, end: 11 },
  targets: [
    { path: ["trace", "text"], range: { start: 0, end: 5 }, cached: false },
    { path: ["trace", "text"], range: { start: 5, end: 11 }, cached: false },
  ],
}));
assert.equal((rangeMarkup.match(/data-source-range=/g) || []).length, 1);
assert(rangeMarkup.includes('data-source-range="">second'), "Raw navigation targets the current range, not the first matching range");

const splitText = "# Environment\nshared needle\nAvailable agent types for the Agent tool:\nFleetView default agent. shared needle\n# MCP Server Instructions\nshared needle";
const searchFixture: TraceRecord = {
  ...{ capture: { client: "claude" } },
  request: { path: "/v1/messages", headers: { "x-example": "header-only-needle" }, body: {
    tools: [{ name: "fixture_tool", description: "tool-only-needle", input_schema: { type: "object" } }],
    system: [{ type: "text", text: "# Memory\nsystem-only-needle" }],
    messages: [{ role: "system", content: [{ type: "text", text: splitText }] }],
  } }, response: { body: { usage: { input_tokens: 100 } } },
};
const [searchTurn] = buildTurns([searchFixture]);
const repeated = searchRecord(searchFixture, "shared needle", searchTurn.blocks);
assert.deepEqual(repeated.map((hit) => hit.category), ["runtime", "tools", "harness"]);
assert.equal(new Set(repeated.map((hit) => hit.blockId)).size, 3);
for (const hit of repeated) {
  const block = searchTurn.blocks.find((candidate) => candidate.id === hit.blockId)!;
  assert.deepEqual(block.rawPath, ["trace", "request", "body", "messages", 0, "content", 0, "text"]);
  assert.equal(splitText.slice(block.rawRange!.start, block.rawRange!.end), block.text);
}
const [fleetHit] = searchRecord(searchFixture, "FleetView", searchTurn.blocks);
assert.equal(fleetHit.label, "Sub-agents");
assert.equal(fleetHit.blockId, "@input.0:1");
assert.equal(searchRecord(searchFixture, "tool-only-needle", searchTurn.blocks)[0].blockId, "@tools");
assert.equal(searchRecord(searchFixture, "system-only-needle", searchTurn.blocks)[0].category, "project");
assert.equal(searchRecord(searchFixture, "header-only-needle", searchTurn.blocks)[0].blockId, undefined);
assert.equal(searchRecord(searchFixture, "content", searchTurn.blocks).find((hit) => hit.match === "content")?.blockId, undefined, "JSON key hits must not masquerade as text content");
for (const fixture of fixtures) {
  const [turn] = buildTurns([fixture]);
  const [hit] = searchRecord(fixture, "Hello", turn.blocks);
  assert(hit.blockId, "Captured input text must link for every supported protocol");
}
console.log("Search: source spans, repeated text, Claude sections, tools, system text and raw-only metadata passed.");

const prose = "New harness wording.\n# Doing tasks\nWork carefully.\n# Tone and style\nBe concise.";
assert.deepEqual(claude.splitSystemText!(prose), [prose]);
const fenced = "Instructions\n~~~text\n# Environment\nexample only\n~~~\n# Tone\nBe brief.";
assert.deepEqual(claude.splitSystemText!(fenced), [fenced]);
assert.deepEqual(claude.splitSystemText!("# Environment\nactual context\n# Other instructions\nDo work."), ["# Environment\nactual context", "# Other instructions\nDo work."]);
assert.equal(classifyInput(searchFixture, { role: "user", content: "# My heading\nMy request" }).category, "user");
assert.equal(classifyInput(searchFixture, { role: "user", content: "<system-reminder>Unrecognized injected content</system-reminder>" }).category, "unknown");
assert.equal(classifyInput(searchFixture, { role: "system", content: "# Environment setup instructions\nExplain setup." }).category, "harness");
const reminderCases = [
  ["# Environment\nYou have been invoked in the following environment:", "runtime", "Environment"],
  ["Available agent types for the Agent tool:\n- example: Example agent", "tools", "Sub-agents"],
  ["# MCP Server Instructions\nTool usage instructions", "harness", "Tool guide"],
  ["You are powered by the model named Example. The exact model ID is example-model.", "runtime", "Model information"],
  ["Today's date is 2026-09-26.", "runtime", "Date"],
] as const;
for (const [body, category, label] of reminderCases) {
  const text = `<system-reminder>\n${body}\n</system-reminder>`;
  const classification = classifyInput(searchFixture, { role: "user", content: text });
  assert.equal(classification.category, category);
  assert.equal(classification.label, label);
  const fixture: TraceRecord = { ...searchFixture, request: { ...searchFixture.request, body: { messages: [{ role: "user", content: [{ type: "text", text }] }] } } };
  const [turn] = buildTurns([fixture]);
  const block = turn.blocks.find((entry) => entry.text === text);
  assert(block, "Reminder stays intact as one source block");
  assert.deepEqual(block.rawPath, ["trace", "request", "body", "messages", 0, "content", 0, "text"]);
}
for (const body of ["# Environment setup instructions\nExplain setup.", "# MCP Server Instructions example\nQuoted text", "Today's date is unknown.", "Unrecognized injected content"]) {
  assert.equal(classifyInput(searchFixture, { role: "user", content: `<system-reminder>\n${body}\n</system-reminder>` }).category, "unknown");
}
console.log("Claude conservative parsing: ordinary headings stay whole; fences, role evidence and unknown reminders respected.");
