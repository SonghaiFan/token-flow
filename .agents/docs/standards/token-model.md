# Token model

The vocabulary Token Flow uses for what a model reads in one request, and for how
that changes from request to request. Every agent plugin, protocol adapter, chart,
and inspector uses it.

## Purpose

Token Flow exists to show how a model's context changes across the requests an
agent sends, within one user turn (the agent loop) and across user turns, and
what each change costs. So that different agents and models can be compared,
every captured block is described on the same few axes.

The rule that decides every boundary: **two kinds of content are separate
categories when they change for different reasons or in different ways;
otherwise they are one.** A difference in meaning alone is a detail, not a
category. Where content is carried (system text, a tool field, a message, a
reminder wrapper) never decides its category.

## Axes

| Axis | Values | Owned by |
|---|---|---|
| Layer | capabilities, instructions, context, conversation, unknown | Derived from the category |
| Category | the fixed set below | Protocol and agent plugins choose one |
| Detail | free label, such as `Permissions`, `AGENTS.md`, `System reminder` | Agent plugin |
| State | new, carried, changed, removed, rewritten | `ui/lib/token-model.ts` |
| Measurement | measured, estimated (`≈`), unattributed | `ui/lib/token-model.ts` |

## Categories

Seven categories, each with one driver. The set is closed: a plugin maps its
content onto it and never adds a category. Its own vocabulary goes in the
detail, which is shown wherever a block is listed.

| Layer | Category | Driver | In the agent loop | Across user turns |
|---|---|---|---|---|
| Capabilities | **Tools & capabilities** | Harness and user configuration | Unchanged, or grows as tools load on demand | Changes when the user installs or enables something |
| Instructions | **Harness instructions** | Harness code | Unchanged | Unchanged, except a mode switch or harness update |
| Context | **Project & memory** | User and project files | Unchanged | Changes when a file is edited or memory is written |
| Context | **Runtime state** | The world outside the conversation | May change every request | May change every request |
| Conversation | **User input** | The user | Unchanged | One new entry per user turn |
| Conversation | **Model output** | The model | One new entry per request | May be dropped by the harness (stripped reasoning) |
| Conversation | **Tool results** | Tool execution | One new entry per call, the fastest growth | May be truncated, cleared, or compacted |

`Unattributed` (layer `unknown`) holds measured tokens that no captured block can
honestly claim. A measured range whose blocks share one layer but several
categories, and that has no local estimates, keeps that layer with category
`unknown` and is labeled `<Layer> (mixed)`.

### What each category holds

- **Tools & capabilities**: everything that says what the model can do. Full tool
  schemas, including MCP tools and schemas loaded on demand, and catalogs that list
  only names and descriptions: skills, plugins, apps, MCP servers, sub-agent kinds,
  slash commands, deferred tool names. Details: `Tool definitions`, `Skills`,
  `Plugins`, `Apps`, `MCP servers`, `Sub-agents`, `Slash commands`, `Recommended plugins`.
- **Harness instructions**: everything the harness vendor wrote. Identity, behavior,
  style, safety, tool-use policy, permission and mode instructions, and a caller's
  own system or developer text. Details: `Base instructions`, `Agent role`,
  `Tool guide`, `Permissions`, `Collaboration mode`, `Multi-agent mode`, `Rules`,
  `Guidelines`, `Communication style`, `Messaging`, `Artifacts`, `Transcripts`,
  `Harness docs`, `Developer instructions`.
- **Project & memory**: instructions and knowledge the user or project keeps in
  files: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, and persistent memory.
  Details name the file kind: `AGENTS.md`, `Memory`.
- **Runtime state**: what the harness observes and injects per request: working
  directory, platform, date, git status, open files and selection, app or browser
  state, todo lists, file-change notices, mode notices, budgets, hook output.
  Details: `Environment`, `App context`, `Browser context`, `System reminder`.
- **User input**: what the user typed and attached this turn or an earlier one:
  prompts, `@file` references, pasted text and images. Details: `User prompt`,
  `Mentioned files`.
- **Model output**: what the model produced and the harness sends back: messages,
  reasoning, tool calls. Details: `Assistant messages`, `Reasoning`, `Tool calls`.
- **Tool results**: what tools returned. Detail: `Tool results`.

A reminder wrapper is a carrier, not a category. A plugin that can read what a
wrapper holds (a `CLAUDE.md` inside a `<system-reminder>`, a skill catalog inside a
reminder) classifies the content; one that cannot keeps it as `Runtime state`.

## State

State compares a block with every earlier request of the conversation, by
captured item id and content. It is what separates history from this turn; it is
never a category.

| State | Meaning |
|---|---|
| carried | Same content as before |
| new | First appearance |
| changed | Same item, different content |
| removed | Present in the previous request of the thread, absent now (a count per turn) |
| rewritten | The previous request's first item is gone or changed: its history was replaced, as compaction does (a turn-level flag) |

Items with an id are compared with every earlier request by id, so auxiliary
requests do not reset them. Items without one (Anthropic Messages, Gemini, Chat
Completions) are compared by position with the previous request of the same
thread, ignoring cache breakpoints. `removed` and `rewritten` are
`TurnModel.change`; states are `TurnModel.itemStates`, keyed by item id or
`@<position>`.

A request that asks the model to summarize the conversation (plugins list the
prompt in `compactionPrompts`) is a turn of kind `compaction`. It stays in the
flow: it reads the whole context like any other request.

## Scope

A capture holds more than the conversation. Every request is in one scope
(`ui/lib/conversation-scope.ts`):

- **conversation**: the user's threads and the branches they spawn (sub-agents,
  web searches);
- **background**: threads the harness runs on its own, which a plugin marks with
  `background` from `thread()` (memory writing, summaries of other sessions);
- **auxiliary**: title generation and empty requests.

The overview and comparisons describe the conversation scope and report the
others beside it, never mixed into it.

## Order

Layers are listed in prompt order, which is also the expected order of
stability: capabilities, instructions, context, conversation. A change in an
earlier layer invalidates the prompt cache for everything after it, so a change
to Tools & capabilities or Harness instructions deserves attention even when it
is small.

## Refining an agent

Refinement happens in details only. To describe an agent more precisely, add
declared kinds, text patterns, or system-text splitting to its plugin in
`ui/lib/agents/<id>.tsx`, each mapped to one of the seven categories with the
`inputClass(category, detail)` helper. Categories, their colors, and their order
stay fixed so conversations from different agents and models remain comparable.
