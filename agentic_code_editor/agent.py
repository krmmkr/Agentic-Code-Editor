"""
agent.py — Agentic code editor powered by LiteLLM tool-calling ReAct loop.

Supports 100+ LLM providers via LiteLLM:
  - GLM (Zhipu):       LITELLM_MODEL=glm/glm-4-flash   LITELLM_API_KEY=xxx
  - Gemini (Google):   LITELLM_MODEL=gemini/gemini-2.0-flash  GOOGLE_API_KEY=xxx
  - OpenAI:            LITELLM_MODEL=openai/gpt-4o      OPENAI_API_KEY=xxx
  - DeepSeek:          LITELLM_MODEL=deepseek/deepseek-chat  DEEPSEEK_API_KEY=xxx
  - Anthropic Claude:  LITELLM_MODEL=claude-3-5-sonnet-20241022  ANTHROPIC_API_KEY=xxx

The agent uses a Reason-Act-Observe loop with native tool calling:
  1. The LLM receives the user message + tool definitions.
  2. The LLM decides which tools to call (read_file, write_file, run_terminal, etc.)
  3. Tool results are fed back into the conversation.
  4. The loop continues until the LLM sends a final text response or hits iteration limits.

Human-in-the-loop: write_file, run_terminal, and propose_plan require user approval
before execution. All other tools (read, list, search, map) are safe and execute immediately.

Field names MUST match the frontend TypeScript types in src/lib/api-client.ts.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, AsyncGenerator

import yaml

from .protocol import AgentEvent
from . import tools
from .tool_definitions import (
    TOOL_DEFINITIONS,
    TOOLS_REQUIRING_APPROVAL,
    execute_tool,
    get_tool_definitions,
)
from .database import update_session_state, get_messages, update_message_record, get_setting, add_message_record
import litellm

logger = logging.getLogger(__name__)


def _uid() -> str:
    return str(uuid.uuid4())


_CONFIG_PATH = Path(__file__).parent / "agent_config.yaml"


def _load_config() -> dict[str, Any]:
    try:
        with open(_CONFIG_PATH, "r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    except FileNotFoundError:
        logger.warning("agent_config.yaml not found at %s, using defaults", _CONFIG_PATH)
        return {}
    except Exception as exc:
        logger.error("Failed to load agent config: %s", exc)
        return {}


def _cfg(data: dict, *keys: str, default: Any = None) -> Any:
    current = data
    for key in keys:
        if not isinstance(current, dict):
            return default
        current = current.get(key)
        if current is None:
            return default
    return current


class UsageTracker:
    """Tracks token usage and cost for LLM calls."""
    def __init__(self):
        self.total_prompt_tokens = 0
        self.total_completion_tokens = 0
        self.total_cost = 0.0

    def update(self, response: Any):
        usage = getattr(response, "usage", None)
        if usage:
            self.total_prompt_tokens += getattr(usage, "prompt_tokens", 0)
            self.total_completion_tokens += getattr(usage, "completion_tokens", 0)
        
        try:
            cost = litellm.completion_cost(completion_response=response)
            if cost:
                self.total_cost += float(cost)
        except Exception:
            pass

    def get_current_usage(self, response: Any) -> dict:
        usage = getattr(response, "usage", None)
        prompt = getattr(usage, "prompt_tokens", 0) if usage else 0
        completion = getattr(usage, "completion_tokens", 0) if usage else 0
        cost = 0.0
        try:
            cost = float(litellm.completion_cost(completion_response=response) or 0.0)
        except Exception:
            pass
        return {
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "cost": cost
        }


class CodeAgent:
    """
    Agentic code editor backend using a tool-calling ReAct loop.

    Usage::

        agent = CodeAgent()
        async for event in agent.run(user_message, command_queue):
            await websocket.send_text(event.to_json())
    """

    def __init__(self) -> None:
        self._cancelled = False
        self._llm_settings: dict[str, str] = {}
        self._config = _load_config()

        db_model = get_setting("llm_model")
        self._model = db_model or os.getenv("LITELLM_MODEL", _cfg(self._config, "model", "default", default="deepseek/deepseek-chat"))

        self._pending_changes: list[dict] = []
        self._current_session_id: str | None = None
        self._last_plan: dict | None = None
        self._completed_steps: set[str] = set()
        self._active_proc: asyncio.subprocess.Process | None = None

        logger.info("Agent initialized — model: %s", self._model)

    def _get_credentials(self) -> tuple[str | None, str | None]:
        # Favor stored dict from frontend, fallback to individual keys or env
        settings = get_setting("llm_settings", {})
        api_key = self._llm_settings.get("api_key") or settings.get("apiKey") or get_setting("llm_api_key") or os.getenv("LITELLM_API_KEY") or os.getenv("OPENAI_API_KEY")
        api_base = self._llm_settings.get("api_base") or settings.get("apiBase") or get_setting("llm_api_base") or os.getenv("LITELLM_API_BASE")
        return api_key, api_base

    def cancel(self) -> None:
        self._cancelled = True
        if self._active_proc:
            try:
                self._active_proc.kill()
            except Exception:
                pass

    @staticmethod
    async def verify_credentials(api_key: str | None, model: str | None, api_base: str | None = None) -> dict[str, Any]:
        if not model:
            return {"success": False, "error": "Model not specified"}
        try:
            import litellm
            settings = get_setting("llm_settings", {})
            final_key = api_key or settings.get("apiKey") or get_setting("llm_api_key") or os.getenv("LITELLM_API_KEY") or os.getenv("OPENAI_API_KEY")
            final_base = api_base or settings.get("apiBase") or get_setting("llm_api_base") or os.getenv("LITELLM_API_BASE")
            response = await litellm.acompletion(
                model=model,
                messages=[{"role": "user", "content": "ping"}],
                max_tokens=1,
                api_key=final_key or None,
                api_base=final_base or None,
            )
            return {"success": True, "model": model}
        except Exception as e:
            return {"success": False, "error": str(e)}

    @staticmethod
    async def get_completion(
        prefix: str, 
        suffix: str, 
        file_path: str, 
        model: str, 
        api_key: str | None = None, 
        api_base: str | None = None
    ) -> str:
        """Provide code completion based on prefix and suffix context."""
        try:
            # We use a standard completion prompt for code fillers
            messages = [
                {"role": "system", "content": "You are a code completion assistant. Provide ONLY the code that goes between the prefix and suffix. Do not include triple backticks or explanations."},
                {"role": "user", "content": f"File: {file_path}\n\nPrefix:\n{prefix}\n\nSuffix:\n{suffix}\n\nCompletion:"}
            ]
            
            response = await litellm.acompletion(
                model=model,
                messages=messages,
                max_tokens=256,
                temperature=0.0,
                api_key=api_key or None,
                api_base=api_base or None,
            )
            return response.choices[0].message.content.strip()
        except Exception as e:
            logger.error(f"Autocomplete failed: {e}")
            return ""

    async def run(
        self,
        user_message: str,
        wait_for_command: AsyncGenerator[dict[str, Any], None],
        llm_settings: dict[str, str] | None = None,
        session_id: str | None = None,
    ) -> AsyncGenerator[AgentEvent, None]:
        """
        Main entry point — runs the agentic ReAct loop.

        The LLM autonomously decides which tools to call. Results feed back
        into the conversation. The loop continues until the LLM sends a
        final text response with no tool calls, or the iteration limit is hit.
        """
        self._cancelled = False
        self._llm_settings = llm_settings or {}
        self._current_session_id = session_id
        from .database import get_setting, get_session_by_id

        db_model = get_setting("llm_model")
        if self._llm_settings.get("model"):
            self._model = self._llm_settings["model"]
        elif db_model:
            self._model = db_model

        logger.info("Agent run starting — model: %s", self._model)

        self._recover_session_state(session_id)

        # Check for simple greetings to avoid heavy tool-calling loops
        greetings = _cfg(self._config, "agent", "resumption", "greeting_keywords", default=["hello", "hi", "hey"])
        words = re.findall(r'\w+', user_message.lower())
        if len(words) <= 3 and any(g in words for g in greetings):
            yield AgentEvent.build("status", {"state": "analyzing", "detail": "Greeting user..."})
            yield AgentEvent.build("text", {"content": "Hello! I'm Antigravity, your agentic coding assistant. How can I help you with your codebase today?"})
            yield AgentEvent.build("status", {"state": "complete", "detail": "Ready"})
            return

        try:
            yield AgentEvent.build("status", {"state": "analyzing", "detail": "Agent starting..."})

            messages = self._build_initial_messages(user_message)
            tool_defs = get_tool_definitions()
            max_iterations = _cfg(self._config, "agent", "max_iterations", default=50)
            max_errors = _cfg(self._config, "agent", "max_consecutive_errors", default=3)

            iteration = 0
            consecutive_errors = 0

            usage_tracker = UsageTracker()

            while iteration < max_iterations and not self._cancelled:
                iteration += 1
                logger.debug("Agent iteration %d/%d", iteration, max_iterations)

                try:
                    # Determine current phase (Analyzing or Implementing)
                    is_implementing = self._last_plan and self._last_plan.get("status") == "approved"
                    status_state = "implementing" if is_implementing else "analyzing"
                    status_prefix = "Implementing plan..." if is_implementing else "Thinking..."

                    # Count and report current context tokens
                    context_tokens, context_limit = self._count_context_tokens(messages, self._model)
                    yield AgentEvent.build("status", {
                        "state": status_state, 
                        "detail": f"{status_prefix} (Context: {context_tokens}/{context_limit if context_limit else '??'} tokens)",
                        "context_tokens": context_tokens,
                        "context_limit": context_limit
                    })


                    api_key, api_base = self._get_credentials()
                    temperature = _cfg(self._config, "llm", "temperature", default=0.2)
                    max_tokens = _cfg(self._config, "llm", "max_tokens", default=4096)
                    timeout = _cfg(self._config, "llm", "timeout_seconds", default=60)

                    response = await asyncio.wait_for(
                        litellm.acompletion(
                            model=self._model,
                            messages=messages,
                            tools=tool_defs,
                            temperature=temperature,
                            max_tokens=max_tokens,
                            api_key=api_key or None,
                            api_base=api_base or None,
                        ),
                        timeout=timeout,
                    )

                    consecutive_errors = 0
                    usage = usage_tracker.get_current_usage(response)
                    usage_tracker.update(response)
                    
                    # Yield usage event for real-time cost tracking
                    yield AgentEvent.build("usage", usage)
                    
                    choice = response.choices[0]
                    assistant_msg = choice.message

                    # Extract Thought from content (if any)
                    thought_content = ""
                    if assistant_msg.content:
                        # Simple extraction of "Thought: ..." if present, or just use full content
                        if "Thought:" in assistant_msg.content:
                            thought_content = assistant_msg.content.split("Thought:")[1].split("Action:")[0].strip()
                        else:
                            thought_content = assistant_msg.content.strip()

                    if thought_content:
                        yield AgentEvent.build("thought", {"content": thought_content})

                    if hasattr(assistant_msg, "tool_calls") and assistant_msg.tool_calls:
                        messages.append(assistant_msg.model_dump())

                        for tool_call in assistant_msg.tool_calls:
                            if self._cancelled:
                                break
                            async for event in self._handle_tool_call(
                                tool_call, messages, wait_for_command
                            ):
                                yield event
                        continue

                    if assistant_msg.content:
                        # Log assistant message with metrics
                        if self._current_session_id:
                            add_message_record(
                                self._current_session_id, 
                                "assistant", 
                                assistant_msg.content,
                                prompt_tokens=usage["prompt_tokens"],
                                completion_tokens=usage["completion_tokens"],
                                cost=usage["cost"]
                            )
                        
                        yield AgentEvent.build("message", {
                            "content": assistant_msg.content,
                            "usage": usage
                        })
                        messages.append({"role": "assistant", "content": assistant_msg.content})

                    break

                except asyncio.TimeoutError:
                    consecutive_errors += 1
                    logger.error("LLM call timed out (attempt %d/%d)", consecutive_errors, max_errors)
                    yield AgentEvent.build("thought", {"content": f"LLM call timed out. Retrying... ({consecutive_errors}/{max_errors})"})
                    if consecutive_errors >= max_errors:
                        yield AgentEvent.build("error", {"detail": f"Agent halted: {max_errors} consecutive LLM timeouts."})
                        break
                    continue

                except asyncio.CancelledError:
                    raise

                except Exception as exc:
                    consecutive_errors += 1
                    logger.error("Agent iteration %d failed: %s", iteration, exc)
                    if consecutive_errors >= max_errors:
                        yield AgentEvent.build("error", {"detail": f"Agent halted: {max_errors} consecutive errors. Last: {exc}"})
                        break
                    yield AgentEvent.build("thought", {"content": f"Encountered an error, retrying... ({consecutive_errors}/{max_errors})"})
                    continue

            if iteration >= max_iterations:
                yield AgentEvent.build("thought", {"content": f"Reached maximum iteration limit ({max_iterations}). Stopping."})

            yield AgentEvent.build("status", {"state": "complete", "detail": "Task finished."})
            yield AgentEvent.build("complete", {})

        except asyncio.CancelledError:
            yield AgentEvent.build("complete", {})
        except Exception as exc:
            logger.exception("Agent error during run")
            yield AgentEvent.build("error", {"detail": f"Agent error: {exc}"})

    def _recover_session_state(self, session_id: str | None) -> None:
        if not session_id:
            return
        from .database import get_session_by_id
        session_rec = get_session_by_id(session_id)
        if not session_rec:
            return
        try:
            self._pending_changes = json.loads(session_rec.pending_changes)
            if session_rec.current_plan:
                self._last_plan = json.loads(session_rec.current_plan)
            logger.info("Recovered session state for %s (%d pending changes)", session_id, len(self._pending_changes))
        except Exception as exc:
            logger.warning("Failed to recover session state: %s", exc)

    def _build_initial_messages(self, user_message: str) -> list[dict[str, Any]]:
        system_prompt = _cfg(self._config, "system_prompt", default="You are an expert coding agent.")
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": system_prompt},
        ]

        if self._current_session_id:
            history = self._get_conversation_history(self._current_session_id)
            if history:
                messages.extend(history)

        messages.append({"role": "user", "content": user_message})
        
        # Log user message if session is active
        if self._current_session_id:
            add_message_record(self._current_session_id, "user", user_message)
            
        return messages

    def _count_context_tokens(self, messages: list[dict], model: str) -> tuple[int, int | None]:
        """Count tokens in the current context window and return (current, max)."""
        try:
            import litellm
            current = litellm.token_counter(model=model, messages=messages)
            try:
                limit = litellm.get_max_tokens(model)
            except Exception:
                limit = None
            return current, limit
        except Exception:
            return 0, None

    @staticmethod
    def _get_conversation_history(session_id: str) -> list[dict[str, Any]]:
        try:
            db_messages = get_messages(session_id)
            history = []
            for m in db_messages[-20:]:
                role = m.role if m.role in ("user", "assistant") else "user"
                history.append({"role": role, "content": m.content})
            return history
        except Exception:
            return []

    async def _handle_tool_call(
        self,
        tool_call: Any,
        messages: list[dict[str, Any]],
        wait_for_command: AsyncGenerator[dict[str, Any], None],
    ) -> AsyncGenerator[AgentEvent, None]:
        tool_name = tool_call.function.name
        try:
            tool_args = json.loads(tool_call.function.arguments) if tool_call.function.arguments else {}
        except json.JSONDecodeError:
            tool_args = {}

        logger.info("Tool call: %s(%s)", tool_name, json.dumps(tool_args)[:200])

        yield AgentEvent.build("thought", {"content": f"Calling {tool_name}({self._summarize_args(tool_name, tool_args)})"})

        if tool_name in TOOLS_REQUIRING_APPROVAL:
            async for event in self._execute_gated_tool(tool_name, tool_args, tool_call.id, messages, wait_for_command):
                yield event
        else:
            async for event in self._execute_safe_tool(tool_name, tool_args, tool_call.id, messages):
                yield event

    def _summarize_args(self, tool_name: str, args: dict) -> str:
        if tool_name == "write_file":
            path = args.get("path", "?")
            content = args.get("content", "")
            return f"path='{path}', content=<{len(content)} chars>"
        if tool_name == "run_terminal":
            return f"command='{args.get('command', '?')}'"
        if tool_name == "read_file":
            return f"path='{args.get('path', '?')}'"
        if tool_name == "search_files":
            return f"pattern='{args.get('pattern', '?')}'"
        if tool_name == "propose_plan":
            return f"title='{args.get('title', '?')}', steps={len(args.get('steps', []))}"
        return json.dumps(args)[:100]

    async def _execute_safe_tool(
        self,
        tool_name: str,
        tool_args: dict[str, Any],
        tool_call_id: str,
        messages: list[dict[str, Any]],
    ) -> AsyncGenerator[AgentEvent, None]:
        yield AgentEvent.build("status", {"state": "analyzing", "detail": f"Running {tool_name}..."})

        if tool_name == "read_file":
            path = tool_args.get("path", "")
            yield AgentEvent.build("file_read", {"path": path, "reason": "Agent reading file"})

        # Heuristic: mark plan step as running
        async for ev in self._update_step_status(tool_name, tool_args, "running"):
            yield ev

        result = execute_tool(tool_name, tool_args, self._config)
        if inspect.isawaitable(result):
            result = await result
            
        result_str = json.dumps(result, default=str)

        if "error" in result:
            logger.warning("Tool %s returned error: %s", tool_name, result["error"])
            yield AgentEvent.build("thought", {"content": f"Tool {tool_name} error: {result['error']}"})

        messages.append({
            "role": "tool",
            "tool_call_id": tool_call_id,
            "content": result_str,
        })

        # Heuristic: mark plan step as completed if safe tool succeeded
        if "error" not in result:
            async for ev in self._update_step_status(tool_name, tool_args, "completed"):
                yield ev

    async def _execute_gated_tool(
        self,
        tool_name: str,
        tool_args: dict[str, Any],
        tool_call_id: str,
        messages: list[dict[str, Any]],
        wait_for_command: AsyncGenerator[dict[str, Any], None],
    ) -> AsyncGenerator[AgentEvent, None]:
        if tool_name == "propose_plan":
            async for event in self._handle_propose_plan(tool_args, tool_call_id, messages, wait_for_command):
                yield event
        elif tool_name == "write_file":
            async for event in self._handle_write_file(tool_args, tool_call_id, messages, wait_for_command):
                yield event
        elif tool_name == "run_terminal":
            async for event in self._handle_run_terminal(tool_args, tool_call_id, messages, wait_for_command):
                yield event
        elif tool_name == "ask_user":
            async for event in self._handle_ask_user(tool_args, tool_call_id, messages, wait_for_command):
                yield event
        else:
            result = {"error": f"Gated tool '{tool_name}' has no handler"}
            messages.append({"role": "tool", "tool_call_id": tool_call_id, "content": json.dumps(result)})

    async def _handle_propose_plan(
        self,
        tool_args: dict[str, Any],
        tool_call_id: str,
        messages: list[dict[str, Any]],
        wait_for_command: AsyncGenerator[dict[str, Any], None],
    ) -> AsyncGenerator[AgentEvent, None]:
        plan = execute_tool("propose_plan", tool_args, self._config)
        plan_id = _uid()
        plan["id"] = plan_id

        for step in plan.get("steps", []):
            step["id"] = _uid()

        plan["status"] = "pending"
        self._last_plan = plan

        yield AgentEvent.build("plan", plan)
        if self._current_session_id:
            update_session_state(self._current_session_id, current_plan=plan)

        self._write_review_files(plan)

        steps_summary = "\n".join([f"{i+1}. {s['description']}" for i, s in enumerate(plan.get("steps", []))])
        yield AgentEvent.build("message", {
            "content": f"### Proposed Plan: {plan['title']}\n{plan.get('description', '')}\n\n**Steps:**\n{steps_summary}\n\n*Review the details in `implementation_plan.md` and `task_list.md` before approving.*"
        })
        yield AgentEvent.build("status", {"state": "awaiting_plan_approval", "detail": "Plan generated. Waiting for your approval."})

        approval_cfg = _cfg(self._config, "approval", default={})
        approve_type = approval_cfg.get("plan_approval_event", "approve_plan")
        reject_type = approval_cfg.get("plan_rejection_event", "reject_plan")

        approval_cmd = await self._wait_for_approval(
            wait_for_command, approve_type, reject_type, expected_id=plan_id
        )

        if not approval_cmd:
            yield AgentEvent.build("thought", {"content": "Plan rejected."})
            messages.append({"role": "tool", "tool_call_id": tool_call_id, "content": json.dumps({"status": "rejected"})})
            self._persist_plan_decision(plan_id, "rejected")
            return

        payload = approval_cmd.get("payload", {})
        task_md = payload.get("task_md", "")
        if not task_md:
            fr = tools.read_file("task_list.md")
            if fr.success and fr.data:
                task_md = fr.data.get("content", "")

        if task_md:
            revised_steps = self._parse_task_list_preserving_ids(task_md, plan.get("steps", []))
            if revised_steps:
                plan["steps"] = revised_steps

        plan["status"] = "approved"
        self._last_plan = plan

        yield AgentEvent.build("plan_sync", {"id": plan["id"], "steps": plan["steps"]})
        if self._current_session_id:
            update_session_state(self._current_session_id, current_plan=plan)

        self._persist_plan_decision(plan_id, "approved")

        yield AgentEvent.build("thought", {"content": f"Plan approved! Executing {len(plan['steps'])} steps."})

        steps_summary_text = "; ".join(s["description"] for s in plan["steps"])
        messages.append({
            "role": "tool",
            "tool_call_id": tool_call_id,
            "content": json.dumps({"status": "approved", "steps_summary": steps_summary_text, "plan": plan}),
        })

    async def _handle_write_file(
        self,
        tool_args: dict[str, Any],
        tool_call_id: str,
        messages: list[dict[str, Any]],
        wait_for_command: AsyncGenerator[dict[str, Any], None],
    ) -> AsyncGenerator[AgentEvent, None]:
        fpath = tool_args.get("path", "")
        content = tool_args.get("content", "")
        description = tool_args.get("description", f"Write to {fpath}")

        original = ""
        read_result = tools.read_file(fpath)
        if read_result.success and read_result.data:
            original = read_result.data.get("content", "")

        change_id = _uid()
        change_payload = {
            "id": change_id,
            "path": fpath,
            "original": original,
            "modified": content,
            "description": description,
        }

        self._pending_changes.append(change_payload)
        if self._current_session_id:
            update_session_state(self._current_session_id, pending_changes=self._pending_changes)
            yield AgentEvent.build("session_state", {"pending_changes": self._pending_changes})

        yield AgentEvent.build("status", {"state": "awaiting_change_approval", "detail": f"Proposing change to {fpath}"})
        yield AgentEvent.build("file_change", change_payload)

        approval_cfg = _cfg(self._config, "approval", default={})
        approve_type = approval_cfg.get("change_approval_event", "accept_change")
        reject_type = approval_cfg.get("change_rejection_event", "reject_change")

        approval_cmd = await self._wait_for_approval(
            wait_for_command, approve_type, reject_type, expected_id=change_id
        )

        if approval_cmd:
            # Mark step as running
            async for ev in self._update_step_status("write_file", tool_args, "running"):
                yield ev

            write_result = tools.write_file(fpath, content)
            if write_result.success:
                yield AgentEvent.build("message", {"content": f"Applied: {description}"})
                tool_result = {"path": fpath, "written": True}
                
                # Mark step as completed
                async for ev in self._update_step_status("write_file", tool_args, "completed"):
                    yield ev
            else:
                yield AgentEvent.build("error", {"detail": f"Failed to write: {write_result.error}"})
                tool_result = {"error": write_result.error}
        else:
            yield AgentEvent.build("message", {"content": f"Skipped: {description}"})
            tool_result = {"path": fpath, "written": False, "reason": "User rejected"}

        self._pending_changes = [c for c in self._pending_changes if c["id"] != change_id]
        if self._current_session_id:
            update_session_state(self._current_session_id, pending_changes=self._pending_changes)
            yield AgentEvent.build("session_state", {"pending_changes": self._pending_changes})

        messages.append({"role": "tool", "tool_call_id": tool_call_id, "content": json.dumps(tool_result)})

    async def _handle_run_terminal(
        self,
        tool_args: dict[str, Any],
        tool_call_id: str,
        messages: list[dict[str, Any]],
        wait_for_command: AsyncGenerator[dict[str, Any], None],
    ) -> AsyncGenerator[AgentEvent, None]:
        command = tool_args.get("command", "")
        working_dir = tool_args.get("working_dir", "")
        description = tool_args.get("description", f"Run: {command}")
        default_timeout = _cfg(self._config, "tools", "terminal_default_timeout", default=120)
        timeout = tool_args.get("timeout", default_timeout)

        cmd_id = _uid()

        yield AgentEvent.build("status", {"state": "awaiting_terminal_approval", "detail": f"Proposing: {command}"})
        yield AgentEvent.build("terminal_command", {
            "id": cmd_id,
            "command": command,
            "description": description,
            "working_dir": working_dir or str(tools.get_workspace()),
        })

        approval_cfg = _cfg(self._config, "approval", default={})
        approve_type = approval_cfg.get("terminal_approval_event", "approve_terminal")
        reject_type = approval_cfg.get("terminal_rejection_event", "reject_terminal")

        approval_cmd = await self._wait_for_approval(
            wait_for_command, approve_type, reject_type, expected_id=cmd_id
        )

        if approval_cmd:
            yield AgentEvent.build("status", {"state": "running_terminal", "detail": f"Running: {command}"})
            
            # Mark step as running
            async for ev in self._update_step_status("run_terminal", tool_args, "running"):
                yield ev
                
            start = time.time()
            try:
                cwd = tools._resolve(working_dir) if working_dir else tools.get_workspace()
                self._active_proc = await asyncio.create_subprocess_shell(
                    command,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=str(cwd),
                )
                
                try:
                    stdout_bytes, stderr_bytes = await asyncio.wait_for(self._active_proc.communicate(), timeout=timeout)
                    exit_code = self._active_proc.returncode
                    stdout = stdout_bytes.decode("utf-8", errors="replace")
                    stderr = stderr_bytes.decode("utf-8", errors="replace")
                except asyncio.TimeoutError:
                    if self._active_proc:
                        self._active_proc.kill()
                        await self._active_proc.wait()
                    exit_code = -1
                    stdout = ""
                    stderr = f"Command timed out after {timeout}s"
                except asyncio.CancelledError:
                    if self._active_proc:
                        self._active_proc.kill()
                        await self._active_proc.wait()
                    raise
                finally:
                    self._active_proc = None

                duration = (time.time() - start) * 1000
                
                yield AgentEvent.build("terminal_output", {
                    "command_id": cmd_id,
                    "exit_code": exit_code,
                    "stdout": stdout,
                    "stderr": stderr,
                    "duration_ms": duration,
                })
                
                tool_result = {
                    "success": exit_code == 0,
                    "stdout": stdout,
                    "stderr": stderr,
                    "exit_code": exit_code
                }
                
                # Mark step as completed
                if exit_code == 0:
                    async for ev in self._update_step_status("run_terminal", tool_args, "completed"):
                        yield ev
                
            except Exception as exc:
                logger.error("Error running terminal command: %s", exc)
                tool_result = {"error": str(exc)}
                self._active_proc = None
        else:
            yield AgentEvent.build("message", {"content": f"Skipped terminal command: {description}"})
            tool_result = {"command": command, "executed": False, "reason": "User rejected"}

        messages.append({"role": "tool", "tool_call_id": tool_call_id, "content": json.dumps(tool_result, default=str)})

    async def _handle_ask_user(
        self,
        tool_args: dict[str, Any],
        tool_call_id: str,
        messages: list[dict[str, Any]],
        wait_for_command: AsyncGenerator[dict[str, Any], None],
    ) -> AsyncGenerator[AgentEvent, None]:
        question = tool_args.get("question", "")
        yield AgentEvent.build("message", {"content": f"**Question:** {question}"})
        yield AgentEvent.build("status", {"state": "awaiting_change_approval", "detail": f"Waiting for user response: {question}"})

        cmd = await self._wait_for_approval(wait_for_command, "chat", "cancel")
        user_response = ""
        if cmd:
            user_response = cmd.get("payload", {}).get("message", "")
        else:
            user_response = "(no response)"

        messages.append({"role": "tool", "tool_call_id": tool_call_id, "content": json.dumps({"user_response": user_response})})

    @staticmethod
    async def _wait_for_approval(
        wait_for_command: AsyncGenerator[dict[str, Any], None],
        approve_type: str,
        reject_type: str,
        expected_id: str | None = None,
    ) -> dict[str, Any] | None:
        async for cmd in wait_for_command:
            cmd_type = cmd.get("type", "")
            payload = cmd.get("payload", {})

            logger.debug("_wait_for_approval: waiting=%s/%s, got=%s", approve_type, reject_type, cmd_type)

            if cmd_type == "cancel":
                raise asyncio.CancelledError()

            if expected_id:
                cmd_id = (
                    payload.get("id")
                    or payload.get("plan_id")
                    or payload.get("change_id")
                    or payload.get("command_id")
                )
                if cmd_id and cmd_id != expected_id:
                    logger.info("Skipping command %s (id=%s), waiting for id=%s", cmd_type, cmd_id, expected_id)
                    continue

            if cmd_type == approve_type:
                logger.info("Approval RECEIVED: %s", approve_type)
                return cmd
            if cmd_type == reject_type:
                logger.info("Rejection RECEIVED: %s", reject_type)
                return None
            logger.debug("Ignoring unrelated command %s while waiting for %s", cmd_type, approve_type)

        return None

    def _write_review_files(self, plan: dict) -> None:
        plan_md = [
            f"# Implementation Plan: {plan['title']}\n",
            f"{plan.get('description', '')}\n",
            "## Analysis & Reasoning\n",
            f"{plan.get('reasoning', '')}\n",
            "---",
            "**Note:** You can edit this file to add comments or context. To change the actual execution steps, edit `task_list.md` instead.",
        ]
        tools.write_file("implementation_plan.md", "\n".join(plan_md))

        task_md = [
            "# Task List\n",
            "Edit this checklist to modify the agent's work plan. Add or remove items to change what I do.\n",
        ]
        for step in plan.get("steps", []):
            files_str = f" ({', '.join(step['files'])})" if step.get("files") else ""
            task_md.append(f"- [ ] {step['description']}{files_str}")

        tools.write_file("task_list.md", "\n".join(task_md))

    def _persist_plan_decision(self, plan_id: str, decision: str) -> None:
        if not self._current_session_id:
            return
        try:
            msgs = get_messages(self._current_session_id)
            for m in reversed(msgs):
                if m.role == "assistant" and m.payload:
                    payload_data = json.loads(m.payload)
                    if payload_data.get("id") == plan_id:
                        payload_data["status"] = decision
                        if m.id is not None:
                            update_message_record(m.id, payload=payload_data)
                        break
        except Exception as exc:
            logger.error("Failed to persist plan decision: %s", exc)

    @staticmethod
    def _parse_task_list_preserving_ids(
        md_content: str, original_steps: list[dict]
    ) -> list[dict] | None:
        steps = []
        original_by_desc = {s["description"].strip().lower(): s for s in original_steps}

        for line in md_content.splitlines():
            match = re.match(r"^[-*]\s*\[[\sxX]\]\s*(.*)$", line.strip())
            if not match:
                continue
            desc_line = match.group(1).strip()
            if not desc_line:
                continue

            files = []
            file_match = re.search(r"\(([^)]+)\)$", desc_line)
            if file_match:
                files_raw = file_match.group(1)
                files = [f.strip() for f in files_raw.split(",")]
                description = desc_line[:file_match.start()].strip()
            else:
                description = desc_line

            original = original_by_desc.get(description.strip().lower())
            step_id = original["id"] if original else str(uuid.uuid4())

            steps.append({
                "id": step_id,
                "description": description,
                "files": files if files else (original["files"] if original else []),
                "status": "pending",
            })

        return steps if steps else None
    async def _update_step_status(self, tool_name: str, tool_args: dict, status: str) -> AsyncGenerator[AgentEvent, None]:
        """Heuristic to update plan steps based on tool usage."""
        if not self._last_plan:
            return

        target_file = tool_args.get("path") or tool_args.get("working_dir")
        if not target_file:
            # If no path, try matching by command (for run_terminal)
            target_file = tool_args.get("command")
            if not target_file:
                return
            
        # Normalize target file (remove leading slashes, lowercase for broad matching)
        target_norm = str(target_file).lstrip("/").lower()

        plan_steps = self._last_plan.get("steps", [])
        
        # We want to find the first PENDING or RUNNING step that matches.
        # This prevents an earlier completed step from "hoarding" the match.
        matched_step = None
        for step in plan_steps:
            step_id = step.get("id")
            
            # Skip if this step is already completed and we are trying to mark a step as running
            if step_id in self._completed_steps and status == "running":
                continue
                
            # Match by filename in description or files list
            match = False
            files = [str(f).lstrip("/").lower() for f in step.get("files", [])]
            desc = step.get("description", "").lower()
            
            # 1. Exact path match in files list
            if target_norm in files:
                match = True
            # 2. File basename mentioned in description
            elif any(f in target_norm or target_norm in f for f in files):
                match = True
            # 3. Path mentioned in description text
            elif target_norm in desc:
                match = True
            
            if match:
                matched_step = step
                # If we found a match that isn't completed yet, stop here.
                # If it IS completed but we're marking it 'completed' again (idempotent), that's fine too.
                if step_id not in self._completed_steps:
                    break
        
        if matched_step:
            step_id = matched_step.get("id")
            if status == "completed":
                self._completed_steps.add(step_id)
            
            logger.info("Plan matching: matched '%s' to step %s (%s)", target_norm, step_id, status)
            yield AgentEvent.build("step_update", {
                "step_id": step_id,
                "plan_id": self._last_plan.get("id", ""),
                "status": status,
                "detail": f"Agent {status} via {tool_name}"
            })

