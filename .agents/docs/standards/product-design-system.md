---
owner: token-flow-maintainers
last_reviewed: 2026-09-24
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

Keep people oriented. Preserve the selected agent, conversation, turn, and block
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
        ├── Turn flow (conversation level, always visible)
        └── Inspector: conversation overview, or the selected turn's request
```

- A **conversation** is the top-level task or session captured from an agent.
- A **turn** is one captured model request inside a conversation.
- A **block** is one attributed part of a turn's input, such as a tool
  definition, an instruction section, or a tool result.
- An **input layer** groups blocks by origin: capabilities, instructions,
  injected context, conversation, and unattributed input.
- An **agent** is the originating coding agent, such as Codex or Claude Code.
- The **turn flow** is the conversation itself: its turns in order, each with
  its input composition, joined by the tokens that carry over.
- The **inspector** shows the conversation overview when nothing is selected,
  and the selected turn's captured request evidence otherwise. It is the
  detail of the flow, not another level in the navigation hierarchy.

Use these terms consistently in the interface. Do not use `trace`, `session`,
and `conversation` interchangeably in user-facing copy. Internal identifiers
may retain legacy names when changing them would add unnecessary risk.

## Entry dashboard

The dashboard answers one question: **Which conversation should I open?** Its
only other action is starting a new one. Show what the user can do now, never
everything the system supports.

- The page is: title with a one-line purpose and a **Capture** button; a quiet
  line of counts (conversations, turns, tokens); one toolbar with search, Agent,
  and Status; the conversation list. Nothing else is permanently visible.
- **Capture** opens a menu: *Capture with* lists the agents installed on this
  computer; *More agents…* reveals supported agents that are not installed,
  with install links. While a capture runs the button shows it, and the menu
  offers Stop.
- Issues appear only when there are some (`⚠ N issues`, which filters to
  them); zero counts are not shown.
- Rows show conversation, agent, started, turns, and tokens. Mark only
  exceptions: a green dot for Active, `Empty` and `Error` badges. Complete is
  the default and stays unmarked. A row opens as one object; per-row actions,
  such as delete, live in its `•••` menu.
- Start times read as people scan: the time today, `Yesterday`, then the date;
  the exact timestamp is in the title.
- The app toolbar holds identity, watching state, theme, and a `•••` menu for
  rare service actions (refresh, clear all). Destructive actions are never
  first-level buttons.
- On narrow screens, rows become two-line cards: title, then agent, time, and
  tokens. Do not squeeze desktop columns into a horizontally overflowing page.

## Conversation workspace

The workspace answers a second question: **What happened in this conversation?**

- Opening a conversation shows the conversation overview. No turn is selected
  until the user selects one; never drop the user into the first turn.
- The turn list and the token flow Sankey are one component. Every turn is a
  row with its identity on the left and its Sankey nodes on the right; the
  Sankey runs top to bottom in every layout, so desktop and mobile read in the
  same direction.
- Selecting a row opens that turn in the inspector. Selecting a Sankey node
  opens the same turn and highlights that layer or category. `Esc` or the
  overview row returns to the conversation overview.
- Structured and raw representations, search, and the comparison with the
  previous turn, belong inside the turn inspector.
- Do not render a second turn navigator, lens tabs, or parallel selection state.
- Keep the workspace as quiet as the dashboard. The toolbar shows the
  conversation title and watching state; Export and Delete live in its `•••`
  menu, never as first-level buttons.
- The flow's header is one line: the turn count (which returns to the
  overview), a search icon that reveals turn search (`/`), and Layers or
  Categories. The legend is one line; explanations live in tooltips. Each turn
  row is two lines, its label and tokens, then what it added; cache share,
  duration, and time are in its tooltip.
- The overview states counts as one quiet line, then where the input went:
  the unit treemap (one square per fixed token amount, grouped by layer) above
  the ranked categories (the largest six and the rest), and the few turns
  worth opening. Selecting a square or a category follows it through the flow.
  Do not add instructions for obvious controls.
- The turn inspector has one toolbar: back, `Turn N of M` with previous and
  next, one view switch (Structured, Raw, Changes), and a search icon that
  reveals search. Layer sections show their name and tokens; their
  descriptions are tooltips.
- Stepping between turns updates the inspector in place; it is never replaced
  or slid out. Rows keep their identity (captured item id, else position), so
  what persists stays put with its open state, and only rows the new turn
  brings in enter with the *Row enter* motion recipe (settle and a brief
  tint). Rows a turn adds or changes while carrying earlier items open by
  default; tool definitions stay closed. Opening a turn from the overview
  keeps the page-side-by-side entrance.

## Control scope

| Scope | Controls and state |
| --- | --- |
| Service | Watching state, theme, language, `•••` service actions, running-capture Stop on workspace pages |
| Dashboard | Capture menu, counts, search, agent and status filters, pagination |
| Conversation | Selected turn or overview, selected layer or block, turn search |
| Turn inspector | Structured/raw, search, selection stepping, this turn versus changes, previous/next turn |

Place a control beside the content it affects. If a control changes only one
panel, it does not belong in the global toolbar.

## Persistent layout

Use at most two persistent bands:

1. App toolbar for identity and service-wide controls.
2. Main split content: the turn flow plus the inspector.

The content is the interface. Avoid repeating page names, selected-turn facts,
or metric summaries merely to fill a band.

## Component patterns

### App toolbar

Shows Token Flow identity, current collection context, watching state, and global
utilities. It remains visually stable between the dashboard and workspace.

### Turn flow

The token flow is a Sankey diagram drawn top to bottom, one node row per turn,
aligned with the turn list. Rows are in chronological capture order and never
regrouped by model; query boundaries appear as quiet headers between rows. All
row text sits in the left column (ordinal, input tokens, a short step summary
such as the prompt or the tools the turn added, cache share, duration, time,
and problem state); the right column belongs to the Sankey alone.

Nodes are `Layers` by default (capabilities, instructions, injected context,
conversation, unattributed) or `Categories` (blocks sharing a label, with
categories below 3% of the turn's input combined as `Others`). Both keep prompt
order. Every node uses one scale across the conversation, so context growth is
visible, and each turn's nodes are centered as a compact group. The cached
portion of a node is hatched from its leading edge, using captured per-block
cache counts.

Each node links to the nearest earlier node with the same layer or category in
the same captured thread (`thread_id`, otherwise the prompt cache key). A quiet,
low-opacity base ribbon spans both nodes and communicates continuity only; a
darker fresh-use ribbon overlays it at each node's trailing edge and tapers to
zero when the destination is fully cached. Do not add balancing nodes such as
`New` or `Cache saved`. Auxiliary requests such as title generation stay in the
list, marked `Meta`, but outside the flow. Links are hidden while the list is
filtered. Keep row height fixed so nodes and ribbons stay aligned with rows.

### Conversation overview

Summarizes the whole conversation from captured usage: turns, input, cache
read, and output; where the input went; and the turns with the most new,
uncached input or a problem status, which link into the inspector.

Where the input went is a unit treemap: one rounded square per fixed, round
amount of input tokens summed over every turn (1, 2, or 5 times a power of ten,
chosen so the conversation fits in about 700 squares), laid out as a
slice-and-dice treemap on the grid. Layers take consecutive cells in prompt
order along the major direction (vertical bands on wide layouts, horizontal on
narrow ones); categories, largest first, take consecutive cells of their layer
along the other direction. Counts are exact and no cell is left empty except in
the chart's last column or row, so boundaries may step by one cell rather than
leave gaps. Cached squares are pale and fresh squares solid. There are no borders:
layers and categories are told apart by color alone. Labels never take area inside the chart. Below it,
one legend line names the layer color families and the unit, followed by bars
for the five largest categories (swatch, share bar on one axis, exact tokens,
share of input, cache rate) and one quiet row totaling the other categories, so
the list still sums to the whole. Those rows are the keyboard-reachable way to
focus a category. A category under half a
square still shows as one square and is marked `<`. The legend states the unit.

Selecting a square or a category focuses that category: other squares fade,
the token flow keeps the category (or its layer, in `Layers` mode) bright in
every turn, and the overview names the turns where it is largest, or where it
first appears when its size never changes. Those turns open in the inspector
with the category selected. Selecting it again, or clearing it, ends the focus.

### Turn inspector

Shows the selected turn with previous/next controls and a way back to the
overview. Its header states the turn's query, model, route, status, duration,
and input, cached, and new tokens in every representation. On narrow screens it
opens over the flow and closing it returns to the same place in the flow.

### Metric summary

Shows only metrics needed to understand the current scope. Overview values may
be compact; exact values remain available in details, tooltips, and exports.

### Coordinated inspection

The flow and the inspector share one selection identified by `turnId` plus
either one or more real block ids or one input layer. Every highlight uses the
selection's own category or layer color, never a generic outline.

- A layer node selects a layer. The inspector scrolls to that layer's section,
  outlines it in the layer color, and lets other sections step back, without
  expanding every row in it.
- A category node selects its member blocks. Matching rows show a left bar and
  a light tint in the category color; non-matching rows step back; only the
  focused block opens. The selection chip names the category and steps through
  its blocks one captured item at a time.
- In the flow, the selected node is outlined and the same layer or category
  stays bright in every turn, with its ribbons, so its path through the
  conversation reads at once. Everything else fades.
- A row's category swatch in the inspector selects that row's blocks.
- `Unattributed input` must never link to a guessed request section.
- The same selection persists across Structured and Raw. Raw expands only the
  selected block's ancestor path, then scrolls to and highlights the exact
  captured node.

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

In the turn inspector, parse valid JSON embedded in captured text into readable
objects and lists. Render structured values by size, not by shape: a
single-field object shows its value, items that fit on one line stay inline,
short lists are numbered rows, objects are a plain key/value grid, and only a
large or deeply nested element folds, with a summary that previews its content
rather than "Item N". URLs read as links without the scheme. Preserve any warning or truncation preamble as visible
metadata. Tool-definition collections use one collapsed entry per captured tool:
show its name and plain-language summary first, then place its declaration and
additional fields in nested disclosures. Large collections render lazily. When
captured JSON is malformed, recover only a known, unambiguous structure; do not
invent missing fields. Raw JSON always retains the exact captured evidence.

A tool result is shown the way the call that produced it declares, never by
guessing from how the output looks (`ui/lib/output-format.ts`). A command that
prints one file (`cat`, `sed -n`, `head`, `tail`, optionally piped through
those) or a read tool takes the file's type: `.md` renders as Markdown, source
reads as code, `.diff`/`.patch` as a diff. `git diff`/`git show` render as a
diff; web tools read as prose with citation markers removed. Compound
commands, listings, searches, and anything without evidence stay plain text.
Only JSON that parses and complete HTML documents are recognized from content.
Each result names its evidence ("From README.md") and offers a switch between
the inferred view, Plain, and Markdown. Agent plugins may describe their own
tools through `outputFormat`.

The turn inspector has two evidence-preserving representations. `Structured`
uses domain-specific renderers for known trace shapes. `Raw` preserves the exact
captured trace for auditing and copying, presented as a literal, type-colored
JSON tree with quoted keys, JSON punctuation, full-copy, and in-place folding;
it does not semantically rewrite values.

Search in the inspector covers the turn's captured request and response keys
and values. Results appear as you type, in document order, each naming its
location in structured vocabulary (layer and category, request settings, or
response), a snippet with the match marked, and the exact JSON path. Choosing a
result reveals it in context: in Structured it opens and scrolls to the block
and marks the occurrence; locations without a structured row open in Raw at the
exact path. Occurrences stay marked as content opens, `Enter` and
`Shift+Enter` step through results, and `Esc` clears the search. Hover-only
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
  the turn flow, the overview, and the inspector alike. Each category label has an
  explicit color within its input layer's hue family (capabilities teal,
  instructions violet, injected context amber, conversation blue, unattributed
  gray). A new classifier label needs a palette entry; never hash or cycle colors.
- Use sentence case and direct, human-facing labels. Keep protocol paths and
  identifiers in monospace without reformatting their literal values.
- Compact large measurements in overview contexts, but show exact measurements
  in inspection contexts. Do not format technical identifiers such as `5000`
  as `5,000`.
- Keep the shared size scale consistent across conversations and the inspector:
  14px body text, 12px metadata and formatted JSON/code, 44px standard controls,
  12px control corners, and 16px panel corners. Keep smaller type and targets
  only for chart annotations and dense in-place tree controls.
- Every value comes from the design system below. New UI uses its tokens and
  primitives instead of isolated literals.

## Design system

The visual language is implemented once and reused everywhere:
`ui/styles/tokens.css` holds the tokens, `ui/styles/globals.css` the utility
roles, `ui/styles/motion.css` the motion recipes, and `ui/components/ui/` the
primitives. Views compose primitives; they do not restyle them.

### Tokens

| Group | Tokens | Use |
| --- | --- | --- |
| Surface | `canvas`, `panel`, `line` | Page background, panes and cards, every divider and border |
| Text | `ink`, `muted` | Primary text and values; labels, metadata, secondary text |
| Interaction | `fill-hover`, `fill-selected`, `--focus` | Hover and selected rows and controls on any surface; the focus ring |
| Status | `success`, `warning`, `danger`, each with `-soft`, `-line`, `-ink` | Fill, border, and readable text of a toned badge, notice, or button |
| Syntax | `syntax-key`, `-string`, `-number`, `-boolean` | Raw JSON only |
| Radius | `panel` 16, `control` 12, `inset` 8, `tag` 6, `mark` 3 | Panes; controls and cards; wells and menu items; badges; swatches |
| Elevation | `shadow-raised`, `shadow-overlay` | Panes; menus, popovers, and dialogs |
| Layer | `--z-sticky`, `--z-toolbar`, `--z-sheet`, `--z-popover`, `--z-modal` | Sticky headers up to dialogs, in that order |
| Layout | `--tf-toolbar-height`, `--tf-control-height`, `--tf-rail-min/max`, `max-w-page`, `max-w-content` | Toolbar, controls, turn-rail width, page and dashboard widths |
| Emphasis | `--tf-opacity-dimmed`, `--tf-opacity-disabled`, `FADED_MARK_OPACITY` | Content that steps back; disabled controls; chart marks outside a selection |

Colors are written once with `light-dark()`. The theme is `color-scheme` on
`<html>`, taken from the OS or from the saved `data-theme`, so native controls
follow it too. Status tones are derived from their base color, so a tone that
reads in one theme reads in the other.

### Roles

| Role | Utility | Use |
| --- | --- | --- |
| Display | `tf-display` | The dashboard title only |
| Title | `tf-title` | The object a pane shows: the overview's conversation, the inspector's turn, a dialog |
| Heading | `tf-heading` | A section inside a pane: a layer, request settings, a catalog |
| Eyebrow | `tf-eyebrow` | A quiet label above a group: table columns, "Where the input went" |
| Code | `tf-code` | Captured JSON and code |
| Pane | `tf-panel` | The turn flow, the overview, the inspector |
| Card | `tf-card` | A bounded group inside a pane |
| Well | `tf-well` | A recessed surface for captured text and code |
| Gutter | `tf-gutter` | Page edges; the toolbar uses it too, so their edges align |
| Inset | `tf-inset` | Horizontal padding of a band inside a pane: toolbars, headers, rows |
| Pad | `tf-pad` | Padding of a pane's body |
| Dimmed | `tf-dimmed` | A row or section outside the current selection; hovering restores it |
| Inset focus | `tf-focus-inset` | Draws the focus ring inside full-width rows |

### Primitives

| Primitive | Use it for |
| --- | --- |
| `Button` | Text actions. `primary` is the page's one main action; `secondary` sits beside content or in a dialog; `ghost` is quiet, in toolbars and lists; `danger` confirms destruction; `live` is a running process that can be stopped |
| `IconButton` | Icon-only actions. Always named; the name is its tooltip unless a title with a shortcut is given |
| `Chip` | A pill-shaped shortcut in a wrap of facts: a filter, a jump to a turn |
| `Segmented` | The one view switch for adjacent content |
| `SearchField`, `Select` | Every search input and every filter |
| `Badge` | A static state or exception: `new` (success), `changed` (warning), `failed`/`Error` (danger), `Empty` (warning), facts (neutral). `mono` for identifiers and counts |
| `StatusDot` | Live and health state beside its label |
| `Swatch` | The color key of a layer or category |
| `Notice` | A message about the current scope: an error, a completed action, a truncated capture |
| `EmptyState` | What is absent, why, and what to do next; `framed` inside a pane |
| `Stat`, `StatList` | The quiet line of counts on the dashboard and the overview |
| `Menu` | The `•••` menus and the Capture menu |
| `ConfirmDialog` | Confirming a destructive action |
| Icons (`ui/icons.tsx`) | Every control glyph: 18px in controls, 16px beside text. Never use text characters (`←`, `›`, `×`) as icons |

### Rules

- One control height (44px) for buttons, fields, selects, and segmented
  controls. Rows that act as controls are at least 44px tall.
- Hover is `fill-hover`, selection is `fill-selected` plus the element's own
  selection mark; never lighten or darken with ad hoc opacity.
- One focus ring: 2px `--focus`, offset 2px, drawn inside full-width rows.
- Disclosures put their chevron first; rows without a body keep its space, so
  summaries align; a row's body aligns with its summary.
- Icon buttons at a band's edge take a negative margin, so the icon, not its
  hit area, aligns with the band's inset.
- Tag and status colors come only from the status tones; category colors come
  only from `category-palette.ts`.
- `npm run lint` rejects Tailwind palette classes, `dark:` variants, and
  arbitrary pixel radii and type sizes in class strings. A needed exception is
  a missing token: add it to `tokens.css` and this table.

## Responsive behavior

Responsive design reflows the same objects; it does not invent a second product.

- Wide layouts place the turn flow beside the inspector.
- Narrow layouts show the same top-to-bottom turn flow; the overview follows
  it, and a selected turn opens over it.
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
4. Select a turn and a Sankey node, then return to the overview.
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
