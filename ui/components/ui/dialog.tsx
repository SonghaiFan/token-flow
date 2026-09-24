"use client";

import { useEffect, useId, useState } from "react";
import { motionMs } from "../motion";
import { Button } from "./button";
import { Notice } from "./feedback";

/* Confirmation for a destructive action. Cancel takes focus, so the safe choice
   is the default; Escape and the backdrop cancel unless the action is running. */
export function ConfirmDialog({ busy, busyLabel, confirmLabel, description, error, onCancel, onConfirm, open, title }: {
  busy: boolean;
  busyLabel: string;
  confirmLabel: string;
  description: string;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
  open: boolean;
  title: string;
}) {
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onCancel, open]);

  // Modal open / close: stay mounted while the closing scale-down plays, then unmount.
  const [shown, setShown] = useState(open);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setShown(true);
  }
  const closing = shown && !open;
  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => setShown(false), motionMs("--modal-close-dur", 150));
    return () => window.clearTimeout(timer);
  }, [closing]);

  if (!shown) return null;
  return <div className={`t-modal-backdrop fixed inset-0 z-(--z-modal) grid place-items-center bg-black/45 p-4 ${closing ? "is-closing" : ""}`} onMouseDown={(event) => { if (event.currentTarget === event.target && !busy) onCancel(); }}>
    <section aria-describedby={`${id}-description`} aria-labelledby={`${id}-title`} aria-modal="true" className={`t-modal ${closing ? "is-closing " : ""}w-full max-w-md rounded-panel border border-line bg-panel p-5 shadow-overlay`} role="alertdialog">
      <h2 className="tf-title" id={`${id}-title`}>{title}</h2>
      <p className="mt-2 text-sm text-muted" id={`${id}-description`}>{description}</p>
      {error ? <div className="mt-3"><Notice compact tone="danger">{error}</Notice></div> : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button autoFocus disabled={busy} onClick={onCancel}>Cancel</Button>
        <Button disabled={busy} onClick={onConfirm} variant="danger">{busy ? busyLabel : confirmLabel}</Button>
      </div>
    </section>
  </div>;
}
