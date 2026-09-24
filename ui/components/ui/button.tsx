import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

/* Buttons. Every button is one control height (44px) with control corners.
   - primary: the page's one main action (Capture).
   - secondary: a neutral action beside content or in a dialog.
   - ghost: a quiet action inside a toolbar or list.
   - danger: confirms a destructive action; never a first-level button.
   - live: a running process the user can stop. */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "live";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "border-ink bg-ink text-panel hover:opacity-90",
  secondary: "border-line bg-panel text-ink hover:bg-fill-hover",
  ghost: "border-transparent text-muted hover:bg-fill-hover hover:text-ink",
  danger: "border-danger bg-danger text-white hover:opacity-90",
  live: "border-success-line bg-success-soft text-success-ink hover:border-success",
};

type NativeButton = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & { ref?: Ref<HTMLButtonElement>; type?: "button" | "submit" };

export function Button({ className = "", compact = false, type = "button", variant = "secondary", ...props }: NativeButton & { compact?: boolean; variant?: ButtonVariant }) {
  return <button
    className={`tf-control inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-control border text-sm font-medium transition-colors active:translate-y-px disabled:cursor-not-allowed disabled:opacity-(--tf-opacity-disabled) disabled:active:translate-y-0 ${compact ? "px-3" : "px-4"} ${VARIANTS[variant]} ${className}`}
    type={type}
    {...props}
  />;
}

/* An icon-only control. It always has an accessible name, shown as its tooltip
   unless a title with a shortcut is given. `active` marks a toggled-on state. */
export function IconButton({ active = false, children, className = "", label, title, type = "button", ...props }: NativeButton & { active?: boolean; children: ReactNode; label: string }) {
  return <button
    aria-label={label}
    className={`tf-icon-control grid place-items-center rounded-control transition-colors hover:bg-fill-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-(--tf-opacity-disabled) disabled:hover:bg-transparent ${active ? "text-ink" : "text-muted"} ${className}`}
    title={title ?? label}
    type={type}
    {...props}
  >{children}</button>;
}

/* A compact, pill-shaped action that sits in running text or a wrap of facts:
   a filter shortcut or a jump to a turn. Its hit area still reaches 44px. */
export function Chip({ children, className = "", tone = "neutral", type = "button", ...props }: NativeButton & { tone?: "neutral" | "warning" }) {
  const tones = {
    neutral: "border-line text-ink hover:bg-fill-hover",
    warning: "border-warning-line bg-warning-soft text-warning-ink hover:border-warning",
  };
  return <button
    className={`relative inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-[''] ${tones[tone]} ${className}`}
    type={type}
    {...props}
  >{children}</button>;
}
