import type { AgentBucket, CaptureStatus, DeleteSessionsResult, SessionRecordsPayload, SessionsPayload } from "./types";

async function readJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json() as Promise<T>;
}

async function deleteJson<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "DELETE",
    headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload as T;
}

async function captureMutation(method: "POST" | "DELETE"): Promise<CaptureStatus> {
  const health = await readJson<{ quit_token?: string }>("/dashboard/health");
  if (!health.quit_token) throw new Error("Capture controls are unavailable for this dashboard");
  const response = await fetch("/dashboard/captures", {
    method,
    headers: { Accept: "application/json", "X-Claude-Tap-Dashboard-Token": health.quit_token },
  });
  const payload = await response.json().catch(() => ({})) as CaptureStatus & { error?: string };
  if (!response.ok && response.status !== 409) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

export async function fetchSessions(
  filters: { agent?: string; date?: string; status?: string; search?: string } = {},
  signal?: AbortSignal,
): Promise<SessionsPayload> {
  const params = new URLSearchParams({ offset: "0", limit: "200" });
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  return readJson<SessionsPayload>(`/api/sessions?${params}`, signal);
}

export async function fetchAgents(signal?: AbortSignal): Promise<AgentBucket[]> {
  const payload = await readJson<{ agents: AgentBucket[] }>("/api/agents", signal);
  return payload.agents;
}

export function fetchSessionRecords(sessionId: string, signal?: AbortSignal): Promise<SessionRecordsPayload> {
  return readJson<SessionRecordsPayload>(`/api/sessions/${encodeURIComponent(sessionId)}/records?view=turns`, signal);
}

export function deleteSession(sessionId: string): Promise<DeleteSessionsResult> {
  return deleteJson<DeleteSessionsResult>(`/api/sessions/${encodeURIComponent(sessionId)}`);
}

export function clearSessions(): Promise<DeleteSessionsResult> {
  return deleteJson<DeleteSessionsResult>("/api/sessions", { clear_all: true });
}

export function fetchCaptureStatus(signal?: AbortSignal): Promise<CaptureStatus> {
  return readJson<CaptureStatus>("/dashboard/captures", signal);
}

export function startCodexCapture(): Promise<CaptureStatus> {
  return captureMutation("POST");
}

export function stopCodexCapture(): Promise<CaptureStatus> {
  return captureMutation("DELETE");
}
