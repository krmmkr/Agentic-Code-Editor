"""
ws_manager.py — Socket.IO connection and session manager.

Wire protocol (must match frontend socket.io client):
  Server → Client:  socket.emit('agent:event', { type: '<event_type>', payload: {...} })
  Client → Server:  socket.on('client:command', ({ type, payload }) => { ... })

The manager is session-scoped — each socket.io connection gets its own
agent session so multiple browser tabs can run independently.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from .agent import CodeAgent
from .protocol import ErrorPayload

logger = logging.getLogger(__name__)


def register_handlers(sio) -> None:
    """Register all socket.io event handlers on the given server."""

    @sio.event
    async def connect(sid, environ):
        """Client connected — set up session state."""
        logger.info("Client connected: %s", sid)
        # Per-session state stored in the server's session dict
        await sio.save_session(sid, {
            "agent": CodeAgent(),
            "agent_task": None,
            "approval_queue": asyncio.Queue(),
        })

    @sio.event
    async def disconnect(sid):
        """Client disconnected — clean up agent."""
        logger.info("Client disconnected: %s", sid)
        session = await sio.get_session(sid)
        agent: CodeAgent = session.get("agent")
        task = session.get("agent_task")
        if agent:
            agent.cancel()
        if task and not task.done():
            task.cancel()

    @sio.on("client:command")
    async def handle_command(sid, data: dict[str, Any]):
        """Route incoming commands from the frontend."""
        if not isinstance(data, dict) or "type" not in data:
            await sio.emit("agent:event", {
                "type": "error",
                "payload": {"detail": "Invalid command: missing 'type' field"},
            }, room=sid)
            return

        cmd_type = data.get("type", "")
        session = await sio.get_session(sid)
        agent: CodeAgent = session.get("agent")
        approval_queue: asyncio.Queue = session.get("approval_queue")

        if cmd_type == "chat":
            # 1. CANCEL existing task before starting new one (Non-blocking)
            old_task = session.get("agent_task")
            if old_task and not old_task.done():
                logger.info("Cancelling existing task for sid %s", sid)
                agent.cancel()
                old_task.cancel()
                # We don't await old_task here because it could be stuck.
                # Let it finish in the background or be reaped by the garbage collector.

            # 2. Re-initialize state for NEW task
            new_agent = CodeAgent()
            new_queue = asyncio.Queue()
            
            # Save new state to session immediately
            session.update({
                "agent": new_agent,
                "approval_queue": new_queue,
                "agent_task": None
            })
            await sio.save_session(sid, session)

            # 3. Define the async runner
            async def command_generator():
                while True:
                    # Get from the SPECIFIC queue for THIS agent run
                    cmd = await new_queue.get()
                    yield cmd

            async def run_agent():
                try:
                    payload = data.get("payload", {})
                    message = payload.get("message", "")
                    session_id = payload.get("session_id")
                    llm_settings = payload.get("llm_settings")
                    
                    async for event in new_agent.run(message, command_generator(), llm_settings, session_id):
                        event_dict = event.model_dump() if hasattr(event, "model_dump") else event
                        await sio.emit("agent:event", event_dict, room=sid)
                except asyncio.CancelledError:
                    pass
                except Exception as exc:
                    logger.exception("Agent run failed: %s", exc)
                    await sio.emit("agent:event", {
                        "type": "error",
                        "payload": {"detail": f"Agent error: {exc}"},
                    }, room=sid)

            # 4. Start the runner
            task = asyncio.create_task(run_agent())
            session["agent_task"] = task
            await sio.save_session(sid, session)

        elif cmd_type == "cancel":
            # Always re-read session to get the latest agent/task references
            session = await sio.get_session(sid)
            current_agent: CodeAgent = session.get("agent")
            task = session.get("agent_task")
            logger.info("Handling CANCEL (sid: %s). Found task: %s", sid, task is not None)
            if current_agent:
                current_agent.cancel()
            if task and not task.done():
                task.cancel()
            session["agent_task"] = None
            await sio.save_session(sid, session)
            await sio.emit("agent:event", {
                "type": "status",
                "payload": {"state": "idle", "detail": "Task cancelled"},
            }, room=sid)

        else:
            # IT'S AN APPROVAL/INPUT COMMAND (approve_plan, accept_change, etc.)
            # Always re-read session to get latest queue reference
            session = await sio.get_session(sid)
            approval_queue = session.get("approval_queue")
            logger.info("Received approval command: %s (sid: %s)", cmd_type, sid)
            if approval_queue is not None:
                logger.info(
                    "Routing %s to approval queue (payload keys: %s)",
                    cmd_type, list(data.get("payload", {}).keys())
                )
                await approval_queue.put(data)
            else:
                logger.warning("Received %s but NO approval queue is active for sid %s", cmd_type, sid)
                await sio.emit("agent:event", {
                    "type": "error",
                    "payload": {"detail": f"No active task waiting for {cmd_type}"},
                }, room=sid)

    logger.info("Socket.IO event handlers registered")
