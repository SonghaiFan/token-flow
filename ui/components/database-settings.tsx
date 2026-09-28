"use client";

import { useEffect, useId, useState } from "react";
import { chooseDatabasePath, fetchDatabaseSettings, setDatabasePath } from "@/lib/api";
import { Button } from "./ui/button";
import { Notice } from "./ui/feedback";

export function DatabaseSettingsDialog({ onClose }: { onClose: () => void }) {
  const id = useId();
  const [current, setCurrent] = useState("");
  const [path, setPath] = useState("");
  const [canChoose, setCanChoose] = useState(false);
  const [loading, setLoading] = useState(true);
  const [choosing, setChoosing] = useState<"existing" | "new" | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetchDatabaseSettings(controller.signal)
      .then((settings) => {
        setCanChoose(settings.can_choose_path);
        setCurrent(settings.db_path);
        setPath(settings.db_path);
      })
      .catch((reason: Error) => {
        if (reason.name !== "AbortError") setError(reason.message || "Unable to load database settings");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  async function save() {
    setSaving(true);
    setError("");
    try {
      await setDatabasePath(path.trim());
      window.location.assign("/dashboard");
    } catch (reason) {
      setError((reason as Error).message || "Unable to change database");
      setSaving(false);
    }
  }

  async function choose(mode: "existing" | "new") {
    setChoosing(mode);
    setError("");
    try {
      const selected = await chooseDatabasePath(mode);
      if (selected) setPath(selected);
    } catch (reason) {
      setError((reason as Error).message || "Unable to open Finder");
    } finally {
      setChoosing(null);
    }
  }

  return <div className="t-modal-backdrop fixed inset-0 z-(--z-modal) grid place-items-center bg-black/45 p-4" onMouseDown={(event) => { if (event.currentTarget === event.target && !saving) onClose(); }}>
    <section aria-labelledby={`${id}-title`} aria-modal="true" className="t-modal w-full max-w-lg rounded-panel border border-line bg-panel p-5 shadow-overlay" role="dialog">
      <h2 className="tf-title" id={`${id}-title`}>Database</h2>
      <p className="mt-2 text-sm text-muted">Choose the SQLite file Token Flow uses for conversations and captures.</p>
      <label className="mt-4 block">
        <span className="tf-eyebrow">File path</span>
        <input autoFocus={!canChoose} className="tf-control mt-2 w-full rounded-control border border-line bg-panel px-3 font-mono text-sm text-ink placeholder:text-muted hover:border-muted/50" disabled={loading || saving || Boolean(choosing)} onChange={(event) => setPath(event.target.value)} placeholder="/absolute/path/to/traces.sqlite3" readOnly={canChoose} spellCheck={false} type="text" value={path}/>
      </label>
      {canChoose ? <div className="mt-3 flex flex-wrap gap-2">
        <Button disabled={loading || saving || Boolean(choosing)} onClick={() => void choose("existing")}>{choosing === "existing" ? "Opening…" : "Open existing…"}</Button>
        <Button disabled={loading || saving || Boolean(choosing)} onClick={() => void choose("new")}>{choosing === "new" ? "Opening…" : "Create new…"}</Button>
      </div> : <p className="mt-2 text-xs text-muted">Enter an existing SQLite file or a location for a new one.</p>}
      <p className="mt-2 text-xs text-muted">Nothing is moved or deleted when you switch databases.</p>
      {error ? <div className="mt-3"><Notice compact tone="danger">{error}</Notice></div> : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button disabled={saving} onClick={onClose}>Cancel</Button>
        <Button disabled={loading || saving || !path.trim() || path.trim() === current} onClick={() => void save()} variant="primary">{saving ? "Switching…" : "Use database"}</Button>
      </div>
    </section>
  </div>;
}
