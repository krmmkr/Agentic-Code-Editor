/**
 * API Client for communicating with the agent backend.
 *
 * In production, point BASE_URL at your FastAPI server.
 * Currently uses a WebSocket mini-service for demo/simulation.
 */

export const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';
export const WS_URL = process.env.NEXT_PUBLIC_WS_URL || '';

// ── REST API ──────────────────────────────────────────────

export async function fetchApi<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = BACKEND_URL
    ? `${BACKEND_URL}${normalizedPath}`
    : normalizedPath;

  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(body.detail || `API error ${res.status}`);
  }
  return res.json();
}

// ── WebSocket Events ──────────────────────────────────────
// These define the protocol between frontend ↔ backend agent.
// Your FastAPI + Google ADK backend should emit these same events.

export type AgentEventType =
  | 'status'           // Agent status change (idle, analyzing, planning, implementing...)
  | 'message'          // Agent text message (thinking, explanation)
  | 'thought'          // Agent's internal reasoning (Antigravity-style)
  | 'plan'             // Agent proposes implementation plan
  | 'plan_sync'        // Agent syncs step IDs after approval (no status reset)
  | 'file_read'        // Agent read a file (shows which file it's looking at)
  | 'file_change'      // Agent proposes a file change (diff data)
  | 'terminal_command' // Agent wants to execute a terminal command
  | 'terminal_output'  // Terminal command produced output
  | 'step_update'      // A plan step has started/completed/failed
  | 'error'            // Something went wrong
  | 'usage'            // Token and cost usage for the session
  | 'complete';        // Agent finished its task

export interface AgentEvent {
  type: AgentEventType;
  payload: Record<string, unknown>;
}

export interface AgentStatusEvent {
  type: 'status';
  payload: {
    state: AgentState;
    detail?: string;
  };
}

export interface AgentMessageEvent {
  type: 'message';
  payload: {
    content: string;
    reasoning?: string;
  };
}

export interface AgentThoughtEvent {
  type: 'thought';
  payload: {
    content: string;
  };
}

export interface AgentPlanEvent {
  type: 'plan';
  payload: {
    id: string;
    title: string;
    description: string;
    steps: Array<{
      id: string;
      description: string;
      files: string[];
    }>;
  };
}

export interface AgentFileReadEvent {
  type: 'file_read';
  payload: {
    path: string;
    reason?: string;
  };
}

export interface AgentFileChangeEvent {
  type: 'file_change';
  payload: {
    id: string;
    path: string;
    original: string;
    modified: string;
    description: string;
  };
}

export interface AgentTerminalCommandEvent {
  type: 'terminal_command';
  payload: {
    id: string;
    command: string;
    description: string;
    working_dir: string;
    timeout_ms?: number;
  };
}

export interface AgentTerminalOutputEvent {
  type: 'terminal_output';
  payload: {
    command_id: string;
    exit_code: number;
    stdout: string;
    stderr: string;
    duration_ms: number;
  };
}

export interface AgentStepUpdateEvent {
  type: 'step_update';
  payload: {
    step_id: string;
    plan_id: string;
    status: 'running' | 'completed' | 'failed';
    detail?: string;
  };
}

export interface AgentUsageEvent {
  type: 'usage';
  payload: {
    prompt_tokens: number;
    completion_tokens: number;
    cost: number;
  };
}

export type AgentState =
  | 'idle'
  | 'connecting'
  | 'analyzing'
  | 'planning'
  | 'awaiting_plan_approval'
  | 'implementing'
  | 'awaiting_change_approval'
  | 'awaiting_terminal_approval'
  | 'running_terminal'
  | 'complete'
  | 'error';

// ── Frontend → Backend Commands ──────────────────────────

export type ClientCommand =
  | { type: 'chat'; payload: { message: string; session_id?: string | null; llm_settings?: { api_key?: string; model?: string; api_base?: string } } }
  | { type: 'approve_plan'; payload: { plan_id: string; plan?: any; plan_md?: string; task_md?: string } }
  | { type: 'reject_plan'; payload: { plan_id: string; reason?: string } }
  | { type: 'accept_change'; payload: { change_id: string } }
  | { type: 'reject_change'; payload: { change_id: string; reason?: string } }
  | { type: 'approve_terminal'; payload: { command_id: string } }
  | { type: 'reject_terminal'; payload: { command_id: string; reason?: string } }
  | { type: 'cancel'; payload?: Record<string, never> };
