"""
protocol.py — Shared types for the agentic code editor WebSocket protocol.

All events sent over WebSocket follow the envelope format:
    {"type": "event_name", "payload": {…}}

All commands received from the frontend follow the same envelope:
    {"type": "command_name", "payload": {…}}

IMPORTANT: Field names MUST match the frontend TypeScript types in
src/lib/api-client.ts exactly. The frontend parses these payloads
by type and accesses fields by name.
"""

from __future__ import annotations

import uuid
from typing import Any, Literal

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Helper: generate a unique ID
# ---------------------------------------------------------------------------

def _uid() -> str:
    return str(uuid.uuid4())


# ---------------------------------------------------------------------------
# Event payload models (Server → Client)
# These must match AgentStatusEvent, AgentPlanEvent, etc. in api-client.ts
# ---------------------------------------------------------------------------

class StatusPayload(BaseModel):
    """Mirrors AgentStatusEvent.payload"""
    state: str = Field(..., description="AgentState: idle|analyzing|planning|awaiting_plan_approval|implementing|awaiting_change_approval|awaiting_terminal_approval|running_terminal|complete|error")
    detail: str = ""


class MessagePayload(BaseModel):
    """Mirrors AgentMessageEvent.payload"""
    content: str
    reasoning: str = ""


class PlanStepPayload(BaseModel):
    """A single step inside a plan."""
    id: str = Field(default_factory=_uid)
    description: str
    files: list[str] = Field(default_factory=list)


class PlanPayload(BaseModel):
    """Mirrors AgentPlanEvent.payload"""
    id: str = Field(default_factory=_uid)
    title: str
    description: str
    reasoning: str = ""
    steps: list[PlanStepPayload] = Field(default_factory=list)


class FileReadPayload(BaseModel):
    """Mirrors AgentFileReadEvent.payload"""
    path: str
    reason: str = ""


class FileChangePayload(BaseModel):
    """Mirrors AgentFileChangeEvent.payload"""
    id: str = Field(default_factory=_uid)
    path: str
    original: str = ""
    modified: str = ""
    description: str = ""


class TerminalCommandPayload(BaseModel):
    """Mirrors AgentTerminalCommandEvent.payload"""
    id: str = Field(default_factory=_uid)
    command: str
    description: str = ""
    working_dir: str = ""
    timeout_ms: int = 30000


class TerminalOutputPayload(BaseModel):
    """Mirrors AgentTerminalOutputEvent.payload"""
    command_id: str
    exit_code: int = 0
    stdout: str = ""
    stderr: str = ""
    duration_ms: float = 0


class StepUpdatePayload(BaseModel):
    """Mirrors AgentStepUpdateEvent.payload"""
    step_id: str
    plan_id: str = ""
    status: Literal["running", "completed", "failed"] = "running"
    detail: str = ""


class ErrorPayload(BaseModel):
    detail: str = ""


# ---------------------------------------------------------------------------
# Envelope (what travels on the wire)
# ---------------------------------------------------------------------------

class AgentEvent(BaseModel):
    """Top-level event sent from server to client over WebSocket."""
    type: str
    payload: dict[str, Any] = Field(default_factory=dict)

    @classmethod
    def build(cls, event_type: str, payload: BaseModel | dict) -> AgentEvent:
        if isinstance(payload, BaseModel):
            payload = payload.model_dump()
        return cls(type=event_type, payload=payload)

    def to_json(self) -> str:
        return self.model_dump_json()


# ---------------------------------------------------------------------------
# Client command payloads (Client → Server)
# ---------------------------------------------------------------------------

class ChatCommandPayload(BaseModel):
    message: str


class PlanApprovalPayload(BaseModel):
    plan_id: str = ""
    reason: str = ""


class ChangeApprovalPayload(BaseModel):
    change_id: str = ""
    reason: str = ""


class TerminalApprovalPayload(BaseModel):
    command_id: str = ""
    reason: str = ""


class ClientCommand(BaseModel):
    """Top-level command received from client over WebSocket."""
    type: str
    payload: dict[str, Any] = Field(default_factory=dict)
