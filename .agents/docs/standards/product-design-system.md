---
owner: token-flow-maintainers
last_reviewed: 2026-09-22
source_of_truth: AGENTS.md
---

# Token Flow Product Design Contract

Token Flow is a quiet technical instrument. It helps a person find an AI coding
conversation, select a model request, and understand where its context tokens
came from without requiring protocol knowledge.

This contract applies to every user-facing Token Flow surface, including the
conversation dashboard, the conversation workspace, exported viewers, and
future responsive layouts.

## Product principles

### Focus

Show the next useful decision before secondary detail. Every persistent control
must earn its place. Prefer one clear selection at each level over multiple
competing navigators, repeated summaries, or decorative chrome.

### Context

Keep people oriented. Preserve the selected agent, conversation, turn, and lens
when navigating or changing viewport size. A layout may reflow, but the user's
mental model and current selection must not change.

### Evidence

Every token value, status, and classification must be traceable to captured
data. Distinguish zero, empty, unavailable, and unknown. When evidence is
missing, show `Unknown`; never infer a confident value.

### Continuity

The dashboard and conversation workspace are consecutive steps in one product,
not separate applications. They use the same vocabulary, status semantics,
visual tokens, and interaction behavior.

## Canonical information architecture

```text
Token Flow service
└── Conversations
    └── Conversation workspace
        ├── Turn
        ├── Lens: Composition | Token flow | Request
        └── Detail or raw evidence
```

- A **conversation** is the top-level task or session captured from an agent.
- A **turn** is one captured model request inside a conversation.
- An **agent** is the originating coding agent, such as Codex or Claude Code.
- A **lens** is a mutually exclusive way to inspect the same selected turn.
- **Request** is the captured source evidence. It is a lens, not another level
  in the navigation hierarchy.

Use these terms consistently in the interface. Do not use `trace`, `session`,
and `conversation` interchangeably in user-facing copy. Internal identifiers
may retain legacy names when changing them would add unnecessary risk.

## Entry dashboard

The dashboard answers one question: **Which conversation should I open?**

- The app toolbar owns service-wide controls: agent filters, watching state,
  theme, language, and service actions.
- The conversation collection owns search, date and status filters, selection,
  and refresh.
- Collection metrics provide orientation. They must not overpower the list or
  repeat information without adding meaning.
- A conversation row is the primary navigation target and should be clickable
  as one object. Agent, start time, turns, tokens, and status help identify it.
- Status meanings are stable across the product. `Active`, `Complete`, `Empty`,
  `Error`, and `Unknown` must not be collapsed into a color-only distinction.
- On narrow screens, the table becomes stacked conversation cards. Do not
  squeeze every desktop column into a horizontally overflowing page.

## Conversation workspace

The workspace answers a second question: **What happened in this conversation?**

- There is one persistent selected turn shared by every lens.
- On wide screens, turns use the rich vertical rail. On narrow screens, the
  same turn cards reflow into a horizontal rail with the same order, metadata,
  and selection state.
- The turn rail offers three local ordering modes without creating another
  navigator: `Model` groups requests by model, `Turn` preserves chronological
  order, and `Query` groups a user request with its follow-up model calls.
- `Composition`, `Token flow`, and `Request` are the primary content tabs.
- Turn-versus-conversation grouping is a local control for the request content,
  not a competing top-level view.
- Structured, tree, and raw representations belong inside the Request lens.
- Do not render a second turn navigator or maintain parallel selection state.

## Control scope

| Scope | Controls and state |
| --- | --- |
| Service | Agent filter, watching state, theme, language, service actions |
| Conversation collection | Search, date, status, bulk selection, refresh |
| Conversation | Selected turn, turn ordering, Composition, Token flow, Request |
| Request content | Turn/conversation grouping, structured/tree/raw, request actions |

Place a control beside the content it affects. If a control changes only one
panel, it does not belong in the global toolbar.

## Persistent layout

Use at most three persistent bands before the main content:

1. App toolbar for identity and service-wide controls.
2. Context or primary lens tabs for the current conversation.
3. Main split content: turn navigator plus the selected lens.

The content is the interface. Avoid repeating page names, selected-turn facts,
or metric summaries merely to fill a band.

## Component patterns

### App toolbar

Shows Token Flow identity, current collection context, watching state, and global
utilities. It remains visually stable between the dashboard and workspace.

### Lens tabs

Use a single tab set for mutually exclusive main panes. Selection must be
persistent, keyboard reachable, and apparent without relying on color alone.

### Turn navigator

Each card shows the same essential identity in every orientation: ordinal,
input tokens, duration, model, endpoint or request kind, time, and problem state
when available. `Model`, `Turn`, and `Query` change the order or grouping of the
same cards and must preserve the selected turn. Desktop is vertical; narrow
layouts are horizontal.

### Metric summary

Shows only metrics needed to understand the current scope. Overview values may
be compact; exact values remain available in details, tooltips, and exports.

### Composition treemap

Each rectangle owns its category label, token total, turn share, and cached
versus fresh subdivision. Encode these values directly in the rectangle when
space allows; retain exact values in its accessible label and tooltip. Do not
require a separate inspector to interpret the selected rectangle.

### Token flow

Token flow answers one question: how does each category's token amount change
across turns? Every visible node is one category total in one turn, aggregating
the real captured blocks that share that category; its size is their actual
combined token count. Keep the primary Composition view fully disaggregated so
the underlying blocks remain inspectable. Omit metadata-only turns from the
flow while retaining them in the global turn list. A quiet, low-opacity base
ribbon connects the nearest earlier node with the same category and spans the
full height of both nodes. It communicates category continuity only and does
not encode cache volume. A darker fresh-use ribbon overlays that base and uses
each endpoint's fresh-token share; it tapers to zero when the destination is
fully cached. Cache remains encoded by the hatched portion of each node; do not
infer cache provenance from a category label. This full-height continuity base
is an intentional exception to quantity encoding because the user needs a
stable visual channel underneath the quantitative fresh-use layer. Rank
categories by token count within each turn and combine categories below 3% of
that turn's input as `Others` in the flow and its aligned mini treemap. Do not
add balancing nodes such as `New` or `Cache saved`. Center each D3-laid-out turn
column as a compact, balanced group. Place each turn's compact composition
treemap beneath its corresponding desktop axis; use the same filtered turn
order in the mobile vertical layout.

### Coordinated inspection

Composition, Token flow, and Request share a selection identified by `turnId`
plus one or more real block ids. A Composition rectangle selects one exact
block. An aggregated Token flow category selects its member blocks in that turn;
repeated labels in other turns are related category flow, not the same selected
objects. Double-clicking a treemap rectangle opens its exact structured request
block. Clicking unused plot space clears selection. `Unattributed input` must
never link to a guessed request section. The same selection persists across
Structured, Tree, and Raw. Tree expands only the selected block's ancestor path,
then scrolls and highlights the exact captured node; it must not expand the
entire trace just to reveal one selection.

### Local control bar

Holds controls that affect only the adjacent content. It must not look like a
second global navigation bar.

### Conversation list

Use a table when widths allow comparison across conversations. Use a card list
on narrow screens. Both representations expose the same underlying fields and
the same row action.

### Disclosure section

Hide secondary technical detail behind predictable disclosure. Keep the label,
summary, and state visible so disclosure never becomes information loss.

### Structured machine output

In the Request lens, parse valid JSON embedded in captured text into readable
objects and lists. Preserve any warning or truncation preamble as visible
metadata. Tool-definition collections use one collapsed entry per captured tool:
show its name and plain-language summary first, then place its declaration and
additional fields in nested disclosures. Large collections render lazily. When
captured JSON is malformed, recover only a known, unambiguous structure; do not
invent missing fields. Raw JSON always retains the exact captured evidence.

The Request lens has three evidence-preserving representations. `Structured`
uses domain-specific renderers for known trace shapes. `Tree` is a generic,
read-only JSON explorer for unknown or deeply nested shapes; it starts fully
expanded so the captured structure is immediately visible, supports manual
node folding, key/value search, and subtree copying, and loads only when selected.
`Raw` preserves the exact captured trace for auditing and copying, presented as
a literal, type-colored JSON tree with quoted keys, JSON punctuation, full-copy,
and in-place folding. Unlike the exploratory Tree, Raw has no search or depth
controls and does not semantically rewrite values. A generic tree must
complement, not replace, known semantic renderers. Hover-only tree
actions reserve their space and stay outside text flow so rows never rewrap or
shift when an action appears.

### Status badge

Combine text with shape or iconography. Color reinforces meaning but never
carries the meaning by itself.

### Empty state

Explain what is absent, why that may be normal, and the next useful action.
Never present missing capture data as a successful zero.

## Visual language

- Neutral surfaces are the default. Use the accent color for active selection
  and interaction, green for confirmed success or savings, red for error or
  destructive action, and amber for warning or incomplete state.
- Categorical visualization colors require a visible legend and stable category
  identity. Do not reuse navigation or status colors as data categories.
- Token categories use one fixed palette, `ui/lib/category-palette.ts`, in
  Composition, Token flow, and Request alike. Each category label has an
  explicit color within its input layer's hue family (capabilities teal,
  instructions violet, injected context amber, conversation blue, unattributed
  gray). A new classifier label needs a palette entry; never hash or cycle colors.
- Use sentence case and direct, human-facing labels. Keep protocol paths and
  identifiers in monospace without reformatting their literal values.
- Compact large measurements in overview contexts, but show exact measurements
  in inspection contexts. Do not format technical identifiers such as `5000`
  as `5,000`.
- Shared layout tokens define toolbar height, control height, touch target,
  content width, turn-rail width, radii, spacing, and motion. New UI should use
  semantic tokens instead of introducing isolated literals.

## Responsive behavior

Responsive design reflows the same objects; it does not invent a second product.

- Wide layouts use a vertical turn rail and a flexible content stage.
- Narrow layouts use the same turn cards in a horizontal, locally scrollable
  rail followed by the content stage.
- The page itself must not overflow horizontally. Wide charts, tables, and code
  can scroll inside a clearly bounded local container.
- Interactive targets on touch layouts are at least 44 by 44 CSS pixels.
- Preserve ordering, labels, selection, and available evidence across widths.

## Interaction and accessibility

- Keyboard navigation follows visible order. Arrow keys and `j`/`k` must not
  disagree with the rendered turn order.
- Focus is always visible. Icon-only controls require accessible names.
- Selection, live state, and problems require text or shape in addition to
  color.
- Destructive actions require confirmation or a reversible recovery path.
- Opening a conversation updates the current app context; it must not create
  unexpected browser tabs.
- Loading, empty, error, and stale states must be explicit and must preserve the
  last trustworthy context when safe.

## Verification path

Every material UI change must exercise this path with real captured data:

1. Open the dashboard.
2. Filter or search conversations.
3. Open a conversation.
4. Change the selected turn and lens.
5. Inspect readable and raw request evidence.
6. Return to the dashboard and confirm that the user remains oriented.

Also verify 3, 20, and 200-turn conversations; wide and narrow layouts; light
and dark appearance; and zero, empty, error, unknown, and live states. Check for
duplicated controls, stale metrics, mismatched selection, page-level overflow,
and unexpected tab creation.

## Governance

This contract is mandatory for future Token Flow interface work. An intentional
deviation must document the user need, the affected scope, and why an existing
pattern cannot satisfy it. New components must identify which pattern they
extend, use shared semantic tokens, and include real trace-backed verification.
