"use client";

import { useEffect, useState } from "react";
import { motionMs } from "./motion";

export function DeleteDialog({ busy, description, error, onCancel, onConfirm, open, title }: {
  busy: boolean;
  description: string;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
  open: boolean;
  title: string;
}) {
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
  return <div className={`t-modal-backdrop fixed inset-0 z-[100] grid place-items-center bg-black/45 p-4 ${closing ? "is-closing" : ""}`} onMouseDown={(event) => { if (event.currentTarget === event.target && !busy) onCancel(); }}>
    <section aria-describedby="delete-dialog-description" aria-labelledby="delete-dialog-title" aria-modal="true" className={`t-modal ${closing ? "is-closing " : ""}w-full max-w-md rounded-panel border border-line bg-panel p-5 shadow-2xl`} role="alertdialog">
      <h2 className="text-lg font-semibold tracking-[-0.02em]" id="delete-dialog-title">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-muted" id="delete-dialog-description">{description}</p>
      {error ? <div className="mt-3 rounded-control border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">{error}</div> : null}
      <div className="mt-5 flex justify-end gap-2">
        <button autoFocus className="tf-control rounded-control border border-line px-4 text-sm font-medium hover:bg-canvas disabled:opacity-50" disabled={busy} onClick={onCancel} type="button">Cancel</button>
        <button className="tf-control rounded-control bg-red-600 px-4 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50" disabled={busy} onClick={onConfirm} type="button">{busy ? "Deleting…" : "Delete"}</button>
      </div>
    </section>
  </div>;
}
