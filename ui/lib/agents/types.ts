import type { ReactNode } from "react";
import type { AnyObject } from "../json";
import type { CallSource, OutputFormat } from "../output-format";
import type { InputClass, TraceRecord, TurnThread } from "../types";

export interface SectionFact {
  mono: boolean;
  value: string;
}

/* How an agent reads and renders one labeled section of its prompt. Every hook
   is optional; returning `undefined` falls back to the generic view. `previous`
   is the same section's text in the nearest earlier turn. */
export interface SectionView {
  preview?(text: string): string | undefined;
  fact?(text: string): SectionFact | undefined;
  changes?(text: string, previous: string | undefined): string[];
  render?(text: string, previous: string | undefined): ReactNode | undefined;
}

/* One agent harness (Codex, Pi, …). It owns what the harness means by the
   content it sends: section labels, typed-prompt detection, and section views.
   The wire format belongs to the protocol adapter (`ui/lib/protocols`). The
   capture side of the same agent is `token_tap/agents/<id>.py`. */
export interface AgentPlugin {
  id: string;
  /* Capture client ids (`record.capture.client`) this plugin reads. */
  clients: string[];
  /* The kind a client declared for a content part itself, shown on its row. */
  declaredKind?(item: AnyObject, partIndex: number | undefined): string;
  /* Classes for declared kinds. Preferred over text patterns. */
  contentKinds?: Record<string, InputClass>;
  /* Text-prefix rules, tried in order after declared classes. */
  textPatterns?: Array<[RegExp, InputClass]>;
  /* User-role text the harness injects; never shown as the typed prompt. */
  injectedUserPrefixes?: string[];
  /* Auxiliary prompts (title generation, …) by lower-case prefix. */
  metadataPrompts?: Array<[string, string]>;
  /* Strip harness wrapping from a typed prompt. */
  cleanPrompt?(text: string): string;
  /* Split one system text into the sections the harness assembled it from. */
  splitSystemText?(text: string): string[];
  /* How a tool's result reads, for tools the generic rules do not cover (see
     `ui/lib/output-format.ts`). Return undefined to keep the generic answer. */
  outputFormat?(source: CallSource): OutputFormat | undefined;
  /* The thread a request belongs to and the thread that spawned it, when the
     client says so. Without it, turns group by their captured lane. */
  thread?(record: TraceRecord): Partial<TurnThread> | undefined;
  /* Views by section label. */
  sections?: Record<string, SectionView>;
}
