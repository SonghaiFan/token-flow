import type { CSSProperties, ReactNode } from "react";
import { activateOnKey, useAccordion } from "../motion";
import { ChevronRightIcon } from "./icons";

/* The one disclosure pattern (product-design-system.md, "Disclosure"). Every fold
   in the product is one of four tiers; they differ in density and framing only.
   Chevron, motion, and state rules are shared, so a fold reads and moves the same
   in Dialog, Tokens, Raw, the turn flow, and menus.

   - section: a titled group inside a pane (an input layer). Card header.
   - row:     a block inside a section (Tokens). Full-width flat row.
   - inline:  secondary detail inside reading flow (Dialog tool steps, reasoning,
              request context, nested facts). No frame; body hangs off a rule.
   - tree:    dense in-place evidence (Raw JSON). Small glyph and target. */
export type DisclosureTier = "section" | "row" | "inline" | "tree";

export type DisclosureState = ReturnType<typeof useAccordion>;

const HEAD: Record<DisclosureTier, string> = {
  section: "tf-inset flex min-h-11 w-full items-center gap-(--tf-fold-gap) py-1.5 text-left",
  row: "tf-inset flex min-h-11 w-full items-center gap-(--tf-fold-gap) py-2 text-left text-sm hover:bg-fill-hover",
  inline: "-mx-2 flex min-h-11 w-[calc(100%+1rem)] items-center gap-2 rounded-inset px-2 text-left text-xs text-muted hover:bg-fill-hover hover:text-ink",
  tree: "inline-flex size-4 shrink-0 items-center justify-center rounded-tag text-muted hover:bg-fill-hover hover:text-ink",
};

/* The body starts where the summary text starts, so reading never jumps sideways. */
const BODY: Record<DisclosureTier, string> = {
  section: "border-t border-line",
  row: "tf-inset pb-4 pt-1 [&>*]:pl-(--tf-fold-indent)",
  inline: "ml-2 border-l border-line pb-2 pl-4 pt-1",
  tree: "",
};

/* The fold glyph: a right chevron in a fixed slot that turns a quarter when open.
   Dim while closed, muted when open, ink while its head is hovered. */
export function Chevron({ open, tier = "row" }: { open: boolean; tier?: DisclosureTier }) {
  const tree = tier === "tree";
  return <span aria-hidden="true" className={`t-acc-chevron grid shrink-0 place-items-center group-hover/fold:text-ink ${tree ? "w-(--tf-fold-glyph-dense)" : "w-(--tf-fold-glyph)"} ${open ? "text-muted" : "text-muted/60"}`} data-open={open ? "true" : "false"}>
    <ChevronRightIcon className={tree ? "size-3" : "size-4"} strokeWidth={tree ? 2.25 : undefined}/>
  </span>;
}

/* Header and animated body of one disclosure. The state comes from useAccordion,
   so callers decide default-open rules; everything visual is fixed by the tier. */
export function Disclosure({ children, className = "", dense = false, headClassName = "", headStyle, label, state, summary, tier = "row", title }: {
  children: ReactNode;
  className?: string;
  /* A long catalog of siblings (tool definitions): 32px lines instead of 44px. */
  dense?: boolean;
  headClassName?: string;
  headStyle?: CSSProperties;
  label?: string;
  state: DisclosureState;
  summary: ReactNode;
  tier?: Exclude<DisclosureTier, "tree">;
  title?: string;
}) {
  const { mounted, open, toggle } = state;
  return <div className={`t-acc ${className}`} data-open={open ? "true" : "false"}>
    {/* A role="button" region, not a <button>: summaries may hold their own controls. */}
    <div aria-expanded={open} aria-label={label} className={`t-acc-head group/fold tf-focus-inset cursor-pointer ${dense ? HEAD[tier].replace("min-h-11", "min-h-8") : HEAD[tier]} ${headClassName}`} onClick={toggle} onKeyDown={(event) => activateOnKey(event, toggle)} role="button" style={headStyle} tabIndex={0} title={title}>
      <Chevron open={open} tier={tier}/>
      {summary}
    </div>
    {mounted ? <DisclosurePanel className={BODY[tier]}>{children}</DisclosurePanel> : null}
  </div>;
}

/* A line in a list of disclosures that has nothing to open. It keeps the chevron's
   slot so its summary lines up with its folding neighbours. */
export function FoldLine({ children, className = "", style, tier = "row", title }: { children: ReactNode; className?: string; style?: CSSProperties; tier?: Exclude<DisclosureTier, "tree">; title?: string }) {
  return <div className={`${HEAD[tier].replace(/hover:\S+/g, "")} ${className}`} style={style} title={title}><span aria-hidden="true" className="w-(--tf-fold-glyph) shrink-0"/>{children}</div>;
}

/* Self-contained disclosure for callers with no selection rules of their own. */
export function SimpleDisclosure({ defaultOpen = false, ...props }: Omit<Parameters<typeof Disclosure>[0], "state"> & { defaultOpen?: boolean }) {
  const state = useAccordion(defaultOpen);
  return <Disclosure state={state} {...props}/>;
}

/* The grid-rows tween (Accordion expand). Must be a direct child of the .t-acc element. */
export function DisclosurePanel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className="t-acc-panel"><div className="t-acc-panel-inner"><div className={className}>{children}</div></div></div>;
}

/* The tree tier's toggle: an icon button inside a dense line of evidence. */
export function TreeToggle({ label, onToggle, open }: { label: string; onToggle: () => void; open: boolean }) {
  return <button aria-expanded={open} aria-label={label} className={`group/fold mr-1 mt-[0.15em] ${HEAD.tree}`} onClick={onToggle} type="button"><Chevron open={open} tier="tree"/></button>;
}
