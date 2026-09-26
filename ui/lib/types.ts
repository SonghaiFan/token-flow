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

export interface CaptureClient {
  id: string;
  label: string;
  available: boolean;
  /* Why it cannot start from the dashboard, when unavailable. */
  reason?: "platform" | "not_installed" | null;
  /* Interactive TUI clients open in their own Terminal window. */
  terminal: boolean;
  /* The command a Terminal client runs. */
  command?: string | null;
  install_url?: string;
}

export interface CaptureStatus {
  /* The dashboard can start captures (false for a plain viewer). */
  enabled?: boolean;
  available: boolean;
  client: string;
  clients?: CaptureClient[];
  /* Directory terminal clients start in. */
  cwd?: string;
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

/* Where a captured input block comes from, independent of its protocol shape:
   tool capabilities, harness instructions, harness-injected context, or the
   prompt/agent loop itself. */
export type InputLayer = "capabilities" | "instructions" | "context" | "conversation" | "unknown";

/* Relation of a captured input item to earlier turns of the same conversation,
   decided only by its captured item id and content. */
export type ItemState = "new" | "carried" | "changed";

export interface InputClass {
  layer: InputLayer;
  label: string;
}

export interface TokenCategory {
  id: string;
  memberIds?: string[];
  label: string;
  layer?: InputLayer;
  state?: ItemState;
  tokens: number;
  cached: number;
  fresh: number;
  color: string;
  aggregate?: boolean;
  /* Sized by local tokenizer estimates scaled to a measured total. */
  estimated?: boolean;
}

export interface TokenSelection {
  turnId: string;
  blockId: string;
  blockIds?: string[];
  label: string;
  /* Set when a whole input layer of the turn is selected rather than one block. */
  layer?: InputLayer;
}

export interface TurnThread {
  id: string;
  parentId?: string;
  /* What kind of thread it is, such as "Sub-agent" or "Guardian review". */
  label?: string;
  /* The agent's own name when it was spawned for a task, such as "/root/release_docs". */
  name?: string;
}

export interface TurnModel {
  id: string;
  index: number;
  label: string;
  captureTurn?: number | string;
  title: string;
  /* What this turn added to the conversation, such as its prompt or tool calls. */
  step: string;
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
  itemStates: Record<string, ItemState>;
  /* The input the model received: the request's own input, preceded by the context
     and output of the turn named by `previous_response_id` when that was captured. */
  context: {
    input: unknown[];
    chainedFromTurn?: string;
    chainedItems: number;
    chainBroken: boolean;
  };
  /* Set when prompt-cache counts prove this turn reused an earlier turn's prompt:
     `carried` tokens came from that turn, `added` tokens are new in this one. */
  cacheChain?: {
    fromTurn: string;
    carried: number;
    added: number;
  };
  /* Captured thread identity; the token flow only connects turns in the same lane. */
  lane: string;
  /* The agent thread this request belongs to. A thread with a parent is a sub-agent
     branch of that thread; `label` names what kind of thread it is. */
  thread: TurnThread;
  /* Plugins that read this turn: the wire protocol and the agent harness. */
  protocol: string;
  agent: string;
  record: TraceRecord;
}
