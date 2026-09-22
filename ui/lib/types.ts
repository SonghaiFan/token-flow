export type SessionStatus = "active" | "complete" | "error" | "empty" | "unknown";

export interface AgentBucket {
  key: string;
  label: string;
  sessions: number;
  records: number;
}

export interface SessionSummary {
  id: string;
  agent?: string;
  model?: string;
  status?: SessionStatus | string;
  live?: boolean;
  started_at?: string;
  updated_at?: string;
  first_user?: string;
  record_count?: number;
  turn_count?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  duration_ms?: number;
}

export interface SessionsPayload {
  sessions: SessionSummary[];
  total: number;
  total_records: number;
  total_tokens: number;
  total_errors: number;
  dates: string[];
  has_legacy: boolean;
  has_more: boolean;
}

export interface DeleteSessionsResult {
  deleted_sessions: number;
  deleted_records: number;
  deleted_logs: number;
  missing_sessions?: string[];
  skipped_active_sessions?: string[];
}

export type CaptureState = "idle" | "starting" | "capturing" | "stopping" | "error";

export interface CaptureStatus {
  available: boolean;
  client: "codexapp";
  state: CaptureState;
  pid?: number | null;
  started_at?: string | null;
  exit_code?: number | null;
  error?: string | null;
}

export interface TraceRecord {
  request_id?: string;
  timestamp?: string;
  turn?: number | string;
  display_turn?: number | string;
  capture_turn?: number | string;
  duration_ms?: number;
  transport?: string;
  request?: {
    method?: string;
    path?: string;
    headers?: Record<string, unknown>;
    body?: Record<string, unknown>;
  };
  response?: {
    status?: number;
    headers?: Record<string, unknown>;
    body?: unknown;
  };
  events?: unknown[];
}

export interface SessionRecordsPayload {
  session: SessionSummary;
  records: TraceRecord[];
}

export interface TokenCategory {
  id: string;
  memberIds?: string[];
  label: string;
  tokens: number;
  cached: number;
  fresh: number;
  color: string;
  aggregate?: boolean;
}

export interface TokenSelection {
  turnId: string;
  blockId: string;
  blockIds?: string[];
  label: string;
}

export interface TurnModel {
  id: string;
  index: number;
  label: string;
  captureTurn?: number | string;
  title: string;
  kind: "user" | "metadata" | "tool" | "unknown";
  queryText: string;
  queryUserIndex: number;
  queryMessageCount: number;
  timestamp?: string;
  durationMs: number;
  method: string;
  path: string;
  model: string;
  status: number;
  input: number;
  output: number;
  cached: number;
  fresh: number;
  categories: TokenCategory[];
  record: TraceRecord;
}

export type WorkspaceLens = "composition" | "flow" | "request";
