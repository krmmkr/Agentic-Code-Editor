"""
agent.py — Agent orchestrator powered by LiteLLM (multi-provider LLM).

Supports 100+ LLM providers via LiteLLM:
  - GLM (Zhipu):       LITELLM_MODEL=glm/glm-4-flash   LITELLM_API_KEY=xxx
  - Gemini (Google):   LITELLM_MODEL=gemini/gemini-2.0-flash  GOOGLE_API_KEY=xxx
  - OpenAI:            LITELLM_MODEL=openai/gpt-4o      OPENAI_API_KEY=xxx
  - DeepSeek:          LITELLM_MODEL=deepseek/deepseek-chat  DEEPSEEK_API_KEY=xxx
  - Anthropic Claude:  LITELLM_MODEL=claude-3-5-sonnet-20241022  ANTHROPIC_API_KEY=xxx

The agent:
  1. Receives a user message via Socket.IO.
  2. Reads relevant files, builds a plan (using LLM).
  3. Sends the plan to the frontend and **waits for approval**.
  4. Executes steps one-by-one; file changes and terminal commands
     each **wait for user approval** before being applied.
  5. Yields structured AgentEvent objects throughout so the WebSocket
     manager can push them to the frontend in real-time.

The `run()` method is an **async generator** — callers iterate over it
with `async for event in agent.run(...`.

Field names MUST match the frontend TypeScript types in src/lib/api-client.ts.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from pathlib import Path
from typing import Any, AsyncGenerator

from .protocol import (
    AgentEvent,
    ChatCommandPayload,
    ErrorPayload,
    FileChangePayload,
    FileReadPayload,
    MessagePayload,
    PlanPayload,
    PlanStepPayload,
    StatusPayload,
    StepUpdatePayload,
    TerminalCommandPayload,
    TerminalOutputPayload,
)
from . import tools

logger = logging.getLogger(__name__)


def _uid() -> str:
    return str(uuid.uuid4())


# ---------------------------------------------------------------------------
# LLM abstraction via LiteLLM
# ---------------------------------------------------------------------------

def _get_llm_backend(model: str | None = None) -> str:
    """
    Determine which LLM backend to use.
    
    Priority:
      1. Explicit model with provider prefix (e.g. 'deepseek/') -> litellm
      2. LITELLM_MODEL env var set -> litellm
      3. GOOGLE_API_KEY env var set -> adk
      4. Default -> unknown
    """
    if model and "/" in model:
        return "litellm"
    if os.getenv("LITELLM_MODEL"):
        return "litellm"
    if os.getenv("GOOGLE_API_KEY"):
        return "adk"
    return "unknown"


# ---------------------------------------------------------------------------
# Agent implementation
# ---------------------------------------------------------------------------

class CodeAgent:
    """
    Agentic code editor backend.

    Usage::

        agent = CodeAgent()
        async for event in agent.run(user_message, command_queue):
            await websocket.send_text(event.to_json())
    """

    def __init__(self) -> None:
        from .database import get_setting
        self._cancelled = False
        self._llm_settings: dict[str, str] = {}
        
        # Load defaults from DB or Env
        db_model = get_setting("llm_model")
        self._model = db_model or os.getenv("LITELLM_MODEL", "gemini/gemini-2.0-flash")
        self._backend = _get_llm_backend(self._model)
        
        # State tracking for phases
        self._last_repo_context = ""
        self._last_file_contents = {}
        self._last_plan = None
        self._last_approval = None
        self._pending_changes = []  # Persistent changes awaiting review
        logger.info("Agent LLM backend: %s (model: %s)", self._backend, self._model or "default")

    def cancel(self) -> None:
        """Signal the agent to stop as soon as possible."""
        self._cancelled = True

    # -----------------------------------------------------------------------
    # Main entry point — async generator
    # -----------------------------------------------------------------------

    @staticmethod
    async def verify_credentials(api_key: str | None, model: str | None) -> dict[str, Any]:
        """Test model access with a minimal completion."""
        if not model:
            return {"success": False, "error": "Model not specified"}
        
        try:
            # Simple ping with minimal tokens
            import litellm
            response = await litellm.acompletion(
                model=model,
                messages=[{"role": "user", "content": "ping"}],
                max_tokens=1,
                api_key=api_key
            )
            return {"success": True, "model": model}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def _find_resumable_plan(self, session_id: str) -> dict[str, Any] | None:
        """Scan historical messages to find the most recent actionable plan."""
        from .database import get_messages
        import json
        
        try:
            messages = get_messages(session_id)
            # Find the most recent assistant message with a plan payload
            for m in reversed(messages):
                if m.role == "assistant" and m.payload:
                    try:
                        # Extract the payload which is a JSON string in the DB
                        data = json.loads(m.payload) if isinstance(m.payload, str) else m.payload
                        # A plan has 'steps' and a status
                        if isinstance(data, dict) and "steps" in data and data.get("status") in ["pending", "approved"]:
                            return data
                    except:
                        continue
            return None
        except Exception as e:
            logger.error("Failed to find resumable plan: %s", e)
            return None

    async def _detect_intent(self, user_message: str) -> str:
        """Detect if the user wants to chat or perform a coding task."""
        if self._backend != "litellm":
            return "coding_task" # Default for other backends
            
        try:
            import litellm
            from .database import get_setting
            model_name = self._model
            
            # Key priority: request > DB > Env
            db_key = get_setting("llm_api_key")
            api_key = self._llm_settings.get("api_key") or db_key or os.getenv("LITELLM_API_KEY", "")
            
            db_base = get_setting("llm_api_base")
            api_base = self._llm_settings.get("api_base") or db_base or os.getenv("LITELLM_API_BASE", "")

            response = await litellm.acompletion(
                model=model_name,
                messages=[
                    {
                        "role": "system", 
                        "content": (
                            "Categorize the user's message into one of these types:\n"
                            "1. 'chat': Greetings, simple questions about the agent, or general conversation that doesn't require editing code or deep repository analysis.\n"
                            "2. 'coding_task': Requests to write, fix, debug, refactor, or analyze the codebase.\n\n"
                            "Output ONLY the category name ('chat' or 'coding_task')."
                        )
                    },
                    {"role": "user", "content": user_message},
                ],
                api_key=api_key or None,
                api_base=api_base or None,
                temperature=0,
                max_tokens=10,
            )
            intent = response.choices[0].message.content or "coding_task"
            return intent.strip().lower()
        except Exception as e:
            logger.error("Intent detection failed: %s", e)
            return "coding_task"

    async def _generate_chat_response(self, user_message: str) -> str:
        """Generate a direct conversational response."""
        try:
            import litellm
            from .database import get_setting
            model_name = self._model
            
            db_key = get_setting("llm_api_key")
            api_key = self._llm_settings.get("api_key") or db_key or os.getenv("LITELLM_API_KEY", "")
            
            db_base = get_setting("llm_api_base")
            api_base = self._llm_settings.get("api_base") or db_base or os.getenv("LITELLM_API_BASE", "")
            
            logger.info("Generating chat response with model: %s, base: %s", model_name, api_base)

            response = await litellm.acompletion(
                model=model_name,
                messages=[
                    {"role": "system", "content": "You are a helpful AI coding assistant. You can chat with the user and acknowledge greetings or questions. Keep it brief."},
                    {"role": "user", "content": user_message},
                ],
                api_key=api_key or None,
                api_base=api_base or None,
                temperature=0.7,
                max_tokens=300,
                timeout=30
            )
            return response.choices[0].message.content or "How can I help you today?"
        except Exception as e:
            logger.error("Chat generation failed: %s", e)
            return "I'm sorry, I'm having trouble connecting to my brain right now. How can I help with your code?"

    async def run(
        self,
        user_message: str,
        wait_for_command: AsyncGenerator[dict[str, Any], None],
        llm_settings: dict[str, str] | None = None,
        session_id: str | None = None,
    ) -> AsyncGenerator[AgentEvent, None]:
        """
        Process *user_message* and yield AgentEvents.

        *wait_for_command* is an async generator that yields the next
        command dict whenever the frontend sends one.
        """
        self._cancelled = False
        self._llm_settings = llm_settings or {}
        self._current_session_id = session_id
        from .database import get_setting, get_session_by_id
        
        # Priority: request > DB > Env
        db_model = get_setting("llm_model")
        if self._llm_settings.get("model"):
            self._model = self._llm_settings["model"]
        elif db_model:
            self._model = db_model
            
        # Re-evaluate backend based on model
        self._backend = _get_llm_backend(self._model)
        logger.info("Using model: %s (backend: %s)", self._model, self._backend)

        # Recover state if session_id provided
        if session_id:
            session_rec = get_session_by_id(session_id)
            if session_rec:
                try:
                    self._pending_changes = json.loads(session_rec.pending_changes)
                    logger.info("Recovered %d pending changes for session %s", len(self._pending_changes), session_id)
                    if session_rec.current_plan:
                        self._last_plan = json.loads(session_rec.current_plan)
                        logger.info("Recovered active plan for session %s", session_id)
                except Exception as e:
                    logger.warning("Failed to recover session state: %s", e)

        try:
            # 0. CHECK FOR RESUMPTION
            resumable_plan = None
            is_continuation = any(word in user_message.lower() for word in ["continue", "resume", "go on", "keep going"])
            is_generic_msg = not user_message or any(word == user_message.lower().strip() for word in ["hello", "hi", "hey", "ping"])
            
            # If we already have an approved plan in state, and the message is generic or a continuation, jump to it
            if self._last_plan and self._last_plan.get("status") == "approved":
                has_unfinished = any(s.get("status") != "completed" for s in self._last_plan.get("steps", []))
                if has_unfinished and (is_generic_msg or is_continuation):
                    logger.info("Auto-resuming existing approved plan in memory")
                    resumable_plan = self._last_plan

            if not resumable_plan and session_id and is_continuation:
                resumable_plan = await self._find_resumable_plan(session_id)
            
            if resumable_plan:
                yield AgentEvent.build("thought", {"content": f"Resuming implementation for: {resumable_plan.get('title', 'Current Plan')}"})
                # Emit the plan immediately so the UI can draw it
                yield AgentEvent.build("plan", resumable_plan)
                plan = resumable_plan
            else:
                # 1. RESEARCH PHASE
                async for event in self._run_research_phase(user_message):
                    yield event
                if self._cancelled: return
                repo_context = self._last_repo_context
                file_contents = self._last_file_contents

                # 2. PLANNING PHASE
                async for event in self._run_planning_phase(user_message, repo_context, file_contents):
                    yield event
                if self._cancelled or not self._last_plan: return
                plan = self._last_plan

            # 3. APPROVAL PHASE (Wait for user)
            async for event in self._run_approval_phase(plan, wait_for_command):
                yield event
            if not self._last_approval:
                yield AgentEvent.build("thought", {"content": "Plan rejected. I'll wait for further instructions."})
                yield AgentEvent.build("complete", {})
                return
            
            # Update plan based on potential manual edits from disk or memory sync
            async for event in self._sync_approved_plan(plan, self._last_approval):
                yield event
            plan = self._last_plan

            # 4. IMPLEMENTATION PHASE (Gated)
            async for event in self._run_implementation_phase(plan, wait_for_command, file_contents):
                yield event

            yield AgentEvent.build("status", {"state": "complete", "detail": "Task finished successfully."})
            yield AgentEvent.build("complete", {})

        except asyncio.CancelledError:
            yield AgentEvent.build("complete", {})
        except Exception as exc:
            logger.exception("Agent error during run")
            yield AgentEvent.build("error", {"detail": f"Agent error: {exc}"})
        # NOTE: WE NO LONGER DELETE REVIEW FILES IN FINALLY. 
        # They persist for the user's reference.

    # -----------------------------------------------------------------------
    # File discovery
    # -----------------------------------------------------------------------

    def _discover_files(self, user_message: str, workspace: Path) -> list[str]:
        """Find relevant files in the workspace to read for context."""
        files = []
        if not workspace.exists():
            return files

        # Collect all project files
        all_files = []
        for root, dirs, filenames in os.walk(workspace):
            dirs[:] = [d for d in dirs if d not in {".git", "node_modules", "__pycache__", ".venv", "venv", ".next", "dist", "build"}]
            for fname in filenames:
                fpath = os.path.join(root, fname)
                rel = os.path.relpath(fpath, workspace)
                all_files.append(f"/{rel}")

        # Extract keywords from user message
        import re
        keywords = set(re.findall(r"\w{3,}", user_message.lower()))
        
        # Score files based on keyword matches in path
        scored_files = []
        for f in all_files:
            score = 0
            f_lower = f.lower()
            for kw in keywords:
                if kw in f_lower:
                    score += 1
            
            # Prioritize source code
            if f.endswith((".py", ".ts", ".tsx", ".js", ".jsx", ".css", ".html", ".md")):
                score += 0.5
            
            scored_files.append((score, f))

        # Sort by score (descending) then path
        scored_files.sort(key=lambda x: (-x[0], x[1]))
        
        # Return top 15 most relevant files
        return [f for score, f in scored_files[:15]]

    # -----------------------------------------------------------------------
    # Plan generation
    # -----------------------------------------------------------------------

    async def _generate_plan(
        self,
        user_message: str,
        files: list[str],
        file_contents: dict[str, str],
        repo_context: str = ""
    ) -> dict:
        """Generate a plan payload using the Architect persona."""
        if self._backend == "litellm":
            plan = await self._generate_plan_litellm(user_message, files, file_contents, repo_context)
        elif self._backend == "adk":
            plan = await self._generate_plan_adk(user_message, files)
        else:
            raise ValueError("No valid LLM backend configured (need LITELLM_MODEL or GOOGLE_API_KEY)")

        # Validation: Ensure plan has steps
        if not plan.get("steps"):
            logger.warning("Agent produced an empty plan.")
            plan["steps"] = [{
                "id": _uid(),
                "description": "Examine the repository to clarify next steps",
                "files": files[:2] if files else []
            }]
            plan["description"] = "I couldn't identify specific code changes yet. Let's start by exploring the context more deeply."

        return plan

    def _discover_files_with_researcher(self, user_message: str, repo_context: str) -> list[str]:
        """
        Mimic a Researcher role to select files to read based on the repository map.
        Currently uses smart filtering, but could be upgraded to an LLM call.
        """
        import re
        keywords = set(re.findall(r"\w{3,}", user_message.lower()))
        
        candidates = []
        # Parse the repo_context (simple path list)
        for line in repo_context.split("\n"):
            if line.startswith("- "):
                path = line.split(" ")[1]
                score = 0
                path_lower = path.lower()
                for kw in keywords:
                    if kw in path_lower:
                        score += 2
                
                # Boost if path contains 'main', 'app', 'routes', 'api', etc.
                if any(k in path_lower for k in ["main", "app", "api", "route", "service"]):
                    score += 1
                
                candidates.append((score, path))
        
        candidates.sort(key=lambda x: (-x[0], x[1]))
        return [c[1] for c in candidates[:15]]

    # ── LiteLLM backend (GLM, Gemini, OpenAI, DeepSeek, Claude, etc.) ──

    async def _generate_plan_litellm(
        self,
        user_message: str,
        files: list[str],
        file_contents: dict[str, str],
        repo_context: str = ""
    ) -> dict:
        """Use the Architect persona to generate a plan via LiteLLM."""
        try:
            import litellm

            model_name = self._model
            api_key = self._llm_settings.get("api_key") or os.getenv("LITELLM_API_KEY", "")
            api_base = self._llm_settings.get("api_base") or os.getenv("LITELLM_API_BASE", "")
            
            # Context components
            context_parts = []
            for fpath in files:
                content = file_contents.get(fpath, "")
                if len(content) > 3000:
                    content = content[:3000] + "\n... (truncated)"
                context_parts.append(f"--- {fpath} ---\n{content}")

            file_context = "\n\n".join(context_parts)

            system_prompt = (
                "You are the Architect role in an Antigravity-style agentic workflow.\n\n"
                "Your objective is to design a high-level implementation plan based on research data. "
                "You have been provided with a Repository Map (global view) and deep File Context (local view).\n\n"
                "Rules:\n"
                "- Produce your plan as JSON ONLY.\n"
                '- Use the format: {"title": "...", "description": "...", "reasoning": "...", '
                '"steps": [{"description": "...", "files": ["relative/path"]}]}\n'
                "- Be precise. Do not guess file paths; use the ones provided in the repo map or context.\n"
                "- Proactively include terminal verification steps (e.g., listing files, running tests, or checking for specific strings) to ensure the implementation is correct."
            )

            user_prompt = (
                f"## Infrastructure Overview (Global Map)\n{repo_context}\n\n"
                f"## Deep Research Findings (File Content)\n{file_context}\n\n"
                f"## User Directive\n{user_message}"
            )

            logger.info("Calling LiteLLM with model: %s", model_name)

            response = await litellm.acompletion(
                model=model_name,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                api_key=api_key or None,
                api_base=api_base or None,
                temperature=0.2,
                max_tokens=2048,
            )

            raw = response.choices[0].message.content or ""
            # Strip markdown code fences if present
            cleaned = raw.strip()
            if cleaned.startswith("```"):
                cleaned = cleaned.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
            if cleaned.startswith("json"):
                cleaned = cleaned[4:].strip()

            plan_dict = json.loads(cleaned)
            steps = [
                {
                    "id": _uid(),
                    "description": s["description"],
                    "files": [f if not f.startswith("/") else f for f in s.get("files", [])],
                }
                for s in plan_dict.get("steps", [])
            ]

            return {
                "id": _uid(),
                "title": plan_dict.get("title", "Agent Plan"),
                "description": plan_dict.get("description", ""),
                "reasoning": plan_dict.get("reasoning", ""),
                "steps": steps,
            }
        except Exception as exc:
            logger.error("LiteLLM plan generation failed: %s", exc)
            raise

    # ── Google ADK backend (Gemini-only, legacy) ──

    async def _generate_plan_adk(self, user_message: str, files: list[str]) -> dict:
        """Use Google ADK to generate a plan (Gemini only)."""
        try:
            from google.adk import Runner, Agent  # type: ignore[import-untyped]
            from google.adk.sessions import InMemorySessionService  # type: ignore[import-untyped]
            from google.adk.runners import types  # type: ignore[import-untyped]

            model_name = self._model or "gemini-2.0-flash"

            agent = Agent(
                name="plan_generator",
                model=model_name,
                instruction=(
                    "You are a code planning assistant. Given a user request and a list of files, "
                    "produce a JSON plan. Respond ONLY with JSON, no markdown.\n"
                    'Format: {"title": "...", "description": "...", "reasoning": "...", '
                    '"steps": [{"description": "...", "files": ["path1", "path2"]}]}'
                ),
            )

            session_service = InMemorySessionService()
            session_service.create_session_sync(app_name="plan_generator", user_id="user", session_id="plan")
            runner = Runner(agent=agent, app_name="plan_generator", session_service=session_service)
            full_text = ""
            async for event in runner.run_async(
                session_id="plan",
                user_id="user",
                new_message=types.Content(
                    role="user",
                    parts=[types.Part(text=f"Request: {user_message}\n\nFiles available:\n" + "\n".join(files))]
                ),
            ):
                if event.content and event.content.parts:
                    for part in event.content.parts:
                        if hasattr(part, "text") and part.text:
                            full_text += part.text

            raw = full_text
            cleaned = raw.strip()
            if cleaned.startswith("```"):
                cleaned = cleaned.split("\n", 1)[-1].rsplit("```", 1)[0].strip()

            plan_dict = json.loads(cleaned)
            steps = [
                {
                    "id": _uid(),
                    "description": s["description"],
                    "files": s.get("files", []),
                }
                for s in plan_dict.get("steps", [])
            ]

            return {
                "id": _uid(),
                "title": plan_dict.get("title", "Agent Plan"),
                "description": plan_dict.get("description", ""),
                "reasoning": plan_dict.get("reasoning", ""),
                "steps": steps,
            }
        except Exception as exc:
            logger.error("ADK plan generation failed: %s", exc)
            raise

    # -----------------------------------------------------------------------
    # LLM-powered file changes (uses LiteLLM to generate actual diffs)
    # -----------------------------------------------------------------------

    async def _generate_file_change(
        self,
        step_desc: str,
        file_path: str,
        original_content: str,
        user_message: str,
    ) -> str:
        """Use LLM to generate modified file content for a change step."""
        if self._backend == "litellm":
            return await self._generate_change_litellm(step_desc, file_path, original_content, user_message)
        elif self._backend == "adk":
            return await self._generate_change_adk(step_desc, file_path, original_content, user_message)
        else:
            raise ValueError(f"No valid LLM backend configured for file generation (current: {self._backend})")

    async def _generate_change_litellm(
        self,
        step_desc: str,
        file_path: str,
        original_content: str,
        user_message: str,
    ) -> str:
        """Use LiteLLM to generate the modified file content."""
        try:
            import litellm

            model_name = self._model
            api_key = self._llm_settings.get("api_key") or os.getenv("LITELLM_API_KEY", "")
            api_base = self._llm_settings.get("api_base") or os.getenv("LITELLM_API_BASE", "")
            response = await asyncio.wait_for(
                litellm.acompletion(
                    model=model_name,
                    messages=[
                        {
                            "role": "system",
                            "content": (
                                "You are the Implementer role in an Antigravity-style workflow.\n\n"
                                "Your objective is to produce the COMPLETE modified content for a file "
                                "based on a specific Architect-approved step. Do NOT output explanations or markdown fences — ONLY the raw file content.\n"
                                "Ensure the file remains syntactically correct and exactly matches the architectural intent."
                            ),
                        },
                        {
                            "role": "user",
                            "content": (
                                f"## Original Request\n{user_message}\n\n"
                                f"## Change to Apply\n{step_desc}\n\n"
                                f"## File: {file_path}\n```\n{original_content}\n```\n\n"
                                "Return the complete modified file:"
                            ),
                        },
                    ],
                    api_key=api_key or None,
                    api_base=api_base or None,
                    temperature=0.1,
                    max_tokens=4096,
                ),
                timeout=45
            )
            
            modified = response.choices[0].message.content or ""
            # Strip markdown code fences if present
            modified = modified.strip()
            if modified.startswith("```"):
                modified = modified.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
            # Remove common language identifiers (e.g., ```python)
            lang_markers = {"python", "typescript", "javascript", "css", "html", "json"}
            first_line = modified.split("\n")[0].lower()
            if first_line in lang_markers:
                modified = "\n".join(modified.split("\n")[1:]).strip()

            return modified
        except Exception as exc:
            logger.warning("LiteLLM change generation failed: %s", exc)
            return original_content + f"\n\n# Agent change: {step_desc}\n"

    async def _generate_change_adk(
        self,
        step_desc: str,
        file_path: str,
        original_content: str,
        user_message: str,
    ) -> str:
        """Use Google ADK to generate the modified file content."""
        try:
            from google.adk import Runner, Agent
            from google.adk.sessions import InMemorySessionService
            from google.adk.runners import types

            model_name = self._model or "gemini-2.0-flash"
            agent = Agent(
                name="code_editor",
                model=model_name,
                instruction=(
                    "You are a code editor. Return the COMPLETE modified file. No explanations, only code."
                ),
            )

            session_service = InMemorySessionService()
            session_service.create_session_sync(app_name="code_editor", user_id="user", session_id="edit")
            runner = Runner(agent=agent, app_name="code_editor", session_service=session_service)
            full_text = ""
            # Wrap ADK run in timeout
            try:
                gen = runner.run_async(
                    session_id="edit",
                    user_id="user",
                    new_message=types.Content(
                        role="user",
                        parts=[types.Part(text=f"Apply change: {step_desc}\n\nFile: {file_path}\n```\n{original_content}\n```")]
                    ),
                )
                async for event in asyncio.wait_for(gen, timeout=45):
                    if event.content and event.content.parts:
                        for part in event.content.parts:
                            if hasattr(part, "text") and part.text:
                                full_text += part.text
            except asyncio.TimeoutError:
                logger.error("ADK change generation timed out")
                return original_content + f"\n\n# Error: Change generation timed out\n"

            modified = full_text
            if modified.startswith("```"):
                modified = modified.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
            return modified
        except Exception as exc:
            logger.warning("ADK change generation failed: %s", exc)
            return original_content + f"\n\n# Agent change: {step_desc}\n"

    async def _generate_terminal_command_litellm(
        self,
        step_desc: str,
        files: list[str],
        file_contents: dict[str, str],
    ) -> str:
        """Use the Implementer persona to generate a terminal command."""
        try:
            import litellm

            model_name = self._model
            api_key = self._llm_settings.get("api_key") or os.getenv("LITELLM_API_KEY", "")
            api_base = self._llm_settings.get("api_base") or os.getenv("LITELLM_API_BASE", "")

            system_prompt = (
                "You are the Implementer role (Terminal Expert) in an Antigravity-style workflow.\n\n"
                "Your objective is to produce a single, precise, and safe shell command to execute the Architect's plan step.\n\n"
                "Rules:\n"
                "- Output ONLY the raw shell command, no markdown fences, no explanation.\n"
                "- Ensure the command is safe to run in a Linux environment.\n"
                "- Use relative paths from the workspace root (no leading /)."
            )

            response = await asyncio.wait_for(
                litellm.acompletion(
                    model=model_name,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": f"Step to execute: {step_desc}\nRelevant files: {', '.join(files)}"},
                    ],
                    api_key=api_key or None,
                    api_base=api_base or None,
                    temperature=0.1,
                    max_tokens=256,
                ),
                timeout=30
            )

            cmd = response.choices[0].message.content or ""
            return cmd.strip().strip("`")
        except Exception as exc:
            logger.error(f"Failed to generate terminal command via LLM: {exc}")
            return self._infer_terminal_command(step_desc.lower(), files)

    # -----------------------------------------------------------------------
    # Step execution
    # -----------------------------------------------------------------------

    async def _determine_step_type(self, step_description: str) -> str:
        """Categorize step into execution type using rules first, LLM as fallback."""
        # 1. Rule-based pre-categorization (Anti-stall: no LLM call needed for common steps)
        desc = step_description.lower()

        # Read/View/Check steps → silent file read, no approval needed
        if any(k in desc for k in (
            "read", "explore", "analyze", "review", "open ", "look at",
            "check", "verify", "confirm", "ensure", "inspect",
            "view the", "contains correct", "validate content",
        )):
            return "file_read"

        # Terminal/shell steps → generates command, needs approval
        if any(k in desc for k in (
            "run ", "test ", "execute", "command", "install",
            "ls ", "git ", "pip ", "pytest", "script",
            "validate results", "verify behavior", "print output",
        )):
            return "terminal_command"

        # Write/create/modify steps → generates diff, needs approval
        if any(k in desc for k in (
            "write", "implement", "apply", "fix", "create",
            "add", "modify", "delete", "remove", "update", "refactor",
        )):
            return "file_change"

        # 2. LLM categorization as fallback
        try:
            import litellm
            model_name = self._model
            api_key = self._llm_settings.get("api_key") or os.getenv("LITELLM_API_KEY", "")
            api_base = self._llm_settings.get("api_base") or os.getenv("LITELLM_API_BASE", "")

            response = await asyncio.wait_for(
                litellm.acompletion(
                    model=model_name,
                    messages=[
                        {
                            "role": "system",
                            "content": (
                                "Categorize the following plan step into ONE of these types:\n"
                                "1. 'file_read': Reading or analyzing existing files.\n"
                                "2. 'terminal_command': Running shell commands (e.g. ls, pytest, pip, git, results check).\n"
                                "3. 'file_change': Writing, modifying, or deleting code in a file.\n"
                                "4. 'generic': High-level tasks, notes, or descriptions that don't need direct execution.\n\n"
                                "Output ONLY the type name."
                            )
                        },
                        {"role": "user", "content": step_description},
                    ],
                    api_key=api_key or None,
                    api_base=api_base or None,
                    temperature=0,
                    max_tokens=20,
                ),
                timeout=30
            )
            return response.choices[0].message.content.strip().lower()
        except Exception as e:
            logger.error(f"Step type detection failed: {e}")
            return "generic"

    async def _execute_step(
        self,
        step: dict,
        plan_id: str,
        wait_for_command: AsyncGenerator[dict[str, Any], None],
        file_contents: dict[str, str],
    ) -> AsyncGenerator[AgentEvent, None]:
        """Execute a single plan step and yield events."""
        step_desc = step["description"]
        step_files = step.get("files", [])
        
        # Determine step type via LLM
        step_type = await self._determine_step_type(step_desc)
        logger.info("Executing step '%s' as type '%s'", step_desc, step_type)

        if step_type == "file_read":
            # Read step — just emit file_read events
            for fpath in step_files[:2]:
                if self._cancelled:
                    return
                yield AgentEvent.build("file_read", {
                    "path": fpath,
                    "reason": step_desc,
                })
                await asyncio.sleep(0.2)

        elif step_type == "terminal_command":
            # Terminal command step — needs approval
            if self._backend == "litellm":
                cmd = await self._generate_terminal_command_litellm(step_desc, step_files, file_contents)
            else:
                cmd = self._infer_terminal_command(step_desc.lower(), step_files)
            
            cmd_id = _uid()

            yield AgentEvent.build("terminal_command", {
                "id": cmd_id,
                "command": cmd,
                "description": step_desc,
                "working_dir": str(tools.get_workspace()),
            })

            approved = await self._wait_for_approval(
                wait_for_command,
                approve_type="approve_terminal",
                reject_type="reject_terminal",
                expected_id=cmd_id
            )
 
            if approved:
                yield AgentEvent.build("status", {"state": "running_terminal", "detail": f"Running: {cmd}"})
                start = time.time()
                result = await tools.run_terminal_command(cmd, timeout=30)
                duration = (time.time() - start) * 1000

                yield AgentEvent.build("terminal_output", {
                    "command_id": cmd_id,
                    "exit_code": result.data.get("exit_code", -1) if result.data else -1,
                    "stdout": result.data.get("stdout", "") if result.data else "",
                    "stderr": result.data.get("stderr", "") if result.data else "",
                    "duration_ms": duration,
                })
            else:
                yield AgentEvent.build("message", {"content": f"Skipped terminal command: {step_desc}"})

        elif step_type == "file_change":
            # File change step — needs approval
            for fpath in step_files[:1]:
                if self._cancelled:
                    return

                # Read original content
                original = file_contents.get(fpath, "")
                if not original:
                    read_result = tools.read_file(fpath)
                    if read_result.success and read_result.data:
                        original = read_result.data.get("content", "")

                # Use LLM to generate the modified content
                modified = await self._generate_file_change(
                    step_desc,
                    fpath,
                    original,
                    "",  # user_message not needed here since step already describes the change
                )

                change_id = _uid()
                change_payload = {
                    "id": change_id,
                    "path": fpath,
                    "original": original,
                    "modified": modified,
                    "description": step_desc,
                }
                
                # Track in agent memory
                self._pending_changes.append(change_payload)
                
                # Sync to database
                from .database import update_session_state
                if session_id := getattr(self, "_current_session_id", None):
                   update_session_state(session_id, pending_changes=self._pending_changes)

                yield AgentEvent.build("file_change", change_payload)

                # Wait for user approval
                approved = await self._wait_for_approval(
                    wait_for_command,
                    approve_type="accept_change",
                    reject_type="reject_change",
                    expected_id=change_id
                )

                if approved:
                    write_result = tools.write_file(fpath, modified)
                    if write_result.success:
                        # Update file_contents cache
                        file_contents[fpath] = modified
                        yield AgentEvent.build("message", {"content": f"Applied: {step_desc}"})
                    else:
                        yield AgentEvent.build("error", {"detail": f"Failed to write: {write_result.error}"})
                else:
                    yield AgentEvent.build("message", {"content": f"Skipped change: {step_desc}"})

                # Remove from pending changes and sync to DB
                self._pending_changes = [c for c in self._pending_changes if c["id"] != change_id]
                from .database import update_session_state
                if session_id := getattr(self, "_current_session_id", None):
                    update_session_state(session_id, pending_changes=self._pending_changes)
        else:
            # Generic step
            await asyncio.sleep(0.3)
            yield AgentEvent.build("message", {"content": f"Completed: {step_desc}"})

    # -----------------------------------------------------------------------
    # Helpers
    # -----------------------------------------------------------------------

    @staticmethod
    def _infer_terminal_command(description: str, files: list[str]) -> str:
        """Infer a terminal command from step description."""
        desc_lower = description.lower()
        if "test" in desc_lower:
            return "python -m pytest tests/ -v"
        if "install" in desc_lower or "pip" in desc_lower:
            return "pip install -e ."
        if "lint" in desc_lower or "ruff" in desc_lower:
            return "ruff check ."
        if "format" in desc_lower or "black" in desc_lower:
            return "black ."
        if "type" in desc_lower and "check" in desc_lower:
            return "mypy ."
        return f"echo 'Executing: {description}'"

    @staticmethod
    async def _wait_for_approval(
        wait_for_command: AsyncGenerator[dict[str, Any], None],
        approve_type: str,
        reject_type: str,
        expected_id: str | None = None,
    ) -> dict[str, Any] | None:
        """Block until a command matching approve/reject type arrives.
        
        If expected_id is provided, it is matched against all common ID fields
        (id, plan_id, change_id, command_id). Non-matching commands are re-queued
        by simply continuing to consume, so they are NOT lost.
        """
        async for cmd in wait_for_command:
            cmd_type = cmd.get("type", "")
            payload = cmd.get("payload", {})

            logger.debug(
                "_wait_for_approval: waiting=%s/%s, got=%s, payload=%s",
                approve_type, reject_type, cmd_type, payload
            )

            if cmd_type == "cancel":
                raise asyncio.CancelledError()

            # If we need ID matching, extract it from all common ID fields
            if expected_id:
                cmd_id = (
                    payload.get("id")
                    or payload.get("plan_id")
                    or payload.get("change_id")
                    or payload.get("command_id")
                )
                if cmd_id and cmd_id != expected_id:
                    logger.info(
                        "Skipping command %s (id=%s), waiting for id=%s",
                        cmd_type, cmd_id, expected_id
                    )
                    continue

            if cmd_type == approve_type:
                logger.info("Approval RECEIVED: %s", approve_type)
                return cmd
            if cmd_type == reject_type:
                logger.info("Rejection RECEIVED: %s", reject_type)
                return None
            # Unknown command type — log and keep waiting
            logger.debug("Ignoring unrelated command %s while waiting for %s", cmd_type, approve_type)

        return None

    def _write_review_files(self, plan: dict) -> None:
        """Write the implementation plan and task list to the workspace."""
        # 1. Implementation Plan
        plan_md = [
            f"# Implementation Plan: {plan['title']}\n",
            f"{plan.get('description', '')}\n",
            "## Analysis & Reasoning\n",
            f"{plan.get('reasoning', '')}\n",
            "---",
            f"**Note:** You can edit this file to add comments or context. To change the actual execution steps, edit `task_list.md` instead."
        ]
        tools.write_file("implementation_plan.md", "\n".join(plan_md))

        # 2. Task List
        task_md = [
            "# Task List\n",
            "Edit this checklist to modify the agent's work plan. Add or remove items to change what I do.\n",
        ]
        for step in plan.get("steps", []):
            files_str = f" ({', '.join(step['files'])})" if step.get("files") else ""
            task_md.append(f"- [ ] {step['description']}{files_str}")
        
        tools.write_file("task_list.md", "\n".join(task_md))

    @staticmethod
    def _parse_task_list(md_content: str) -> list[dict] | None:
        """Parse a markdown checklist back into Agent steps."""
        steps = []
        import re
        # Look for lines starting with - [ ] or - [x]
        lines = md_content.splitlines()
        for line in lines:
            # Handle both - [ ] and - [x] or * [ ] etc
            match = re.match(r"^[-*]\s*\[[\sxX]\]\s*(.*)$", line.strip())
            if match:
                desc_line = match.group(1).strip()
                if not desc_line:
                    continue
                
                # Try to extract files in parentheses at the end
                files = []
                file_match = re.search(r"\(([^)]+)\)$", desc_line)
                if file_match:
                    files_raw = file_match.group(1)
                    files = [f.strip() for f in files_raw.split(",")]
                    description = desc_line[:file_match.start()].strip()
                else:
                    description = desc_line
                
                steps.append({
                    "id": str(uuid.uuid4()),
                    "description": description,
                    "files": files,
                    "status": "pending"
                })
        
        return steps if steps else None

    @staticmethod
    def _parse_task_list_preserving_ids(
        md_content: str, original_steps: list[dict]
    ) -> list[dict] | None:
        """Parse task list markdown, reusing original step IDs where descriptions match."""
        import re
        steps = []
        # Build a lookup of description → original step for ID reuse
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

            # Reuse original step ID if description matches (for frontend sync)
            original = original_by_desc.get(description.strip().lower())
            step_id = original["id"] if original else str(uuid.uuid4())

            steps.append({
                "id": step_id,
                "description": description,
                "files": files if files else (original["files"] if original else []),
                "status": "pending",
            })

        return steps if steps else None

    # -----------------------------------------------------------------------
    # Phase Executors
    # -----------------------------------------------------------------------

    async def _run_research_phase(self, user_message: str):
        """Phase 1: Deep research and file discovery."""
        yield AgentEvent.build("thought", {"content": "Starting research. Mapping repository structure to identify relevant areas."})
        yield AgentEvent.build("status", {"state": "analyzing", "detail": "Researcher: Mapping repository structure..."})
        
        repo_map = tools.get_repository_map()
        repo_context = ""
        if repo_map.success:
            repo_context = "\n".join([f"- {f['path']} ({f['hint']})" for f in repo_map.data["files"]])
            if repo_map.data.get("truncated"):
                repo_context += "\n... (large project, map truncated)"

        yield AgentEvent.build("thought", {"content": "Analyzing repository map to discover files relevant to the request."})
        yield AgentEvent.build("status", {"state": "analyzing", "detail": "Researcher: Identifying relevant source files..."})
        files_to_read = self._discover_files_with_researcher(user_message, repo_context)

        file_contents = {}
        if files_to_read:
            yield AgentEvent.build("thought", {"content": f"Identified {len(files_to_read)} files for examination: {', '.join(files_to_read)}. Initializing deep read."})
        
        for fpath in files_to_read:
            if self._cancelled: break
            yield AgentEvent.build("file_read", {"path": fpath, "reason": "Deep research"})
            await asyncio.sleep(0.1) # Smooth UI
            result = tools.read_file(fpath)
            if result.success and result.data:
                file_contents[fpath] = result.data.get("content", "")

        self._last_repo_context = repo_context
        self._last_file_contents = file_contents

    async def _run_planning_phase(self, user_message: str, repo_context: str, file_contents: dict):
        """Phase 2: Architectural planning."""
        yield AgentEvent.build("thought", {"content": "Research complete. Acting as Architect to design a robust implementation strategy."})
        yield AgentEvent.build("status", {"state": "planning", "detail": "Architect: Designing implementation plan..."})

        # Convert file_contents map to list of paths for _generate_plan
        paths = list(file_contents.keys())
        plan = await self._generate_plan(user_message, paths, file_contents, repo_context)
        self._last_plan = plan

    async def _run_approval_phase(self, plan: dict, wait_for_command):
        """Phase 3: Wait for user review and approval."""
        yield AgentEvent.build("plan", plan)
        if self._current_session_id:
            from .database import update_session_state
            update_session_state(self._current_session_id, current_plan=plan)
        
        # Write files for user to review in their own editor
        self._write_review_files(plan)
        
        # Post summary to chat
        steps_summary = "\n".join([f"{i+1}. {s['description']}" for i, s in enumerate(plan['steps'])])
        yield AgentEvent.build("message", {
            "content": f"### Proposed Plan: {plan['title']}\n{plan['description']}\n\n**Steps:**\n{steps_summary}\n\n*Review the details in `implementation_plan.md` and `task_list.md` before approving.*"
        })
        
        yield AgentEvent.build("status", {"state": "awaiting_plan_approval", "detail": "Plan generated. Waiting for your approval in `implementation_plan.md`."})
        yield AgentEvent.build("file_read", {"path": "implementation_plan.md", "reason": "Please review and approve the plan"})
        
        self._last_approval = await self._wait_for_approval(wait_for_command, "approve_plan", "reject_plan", expected_id=plan.get("id"))

    async def _sync_approved_plan(self, original_plan: dict, approval_cmd: dict):
        """Merge potential manual edits from the user into the execution plan."""
        yield AgentEvent.build("thought", {"content": "Plan approved! Synchronizing final instructions."})
        
        payload = approval_cmd.get("payload", {})
        task_md = payload.get("task_md", "")

        original_plan["status"] = "approved"

        # Fallback to reading from disk if memory sync is empty
        if not task_md:
            fr = tools.read_file("task_list.md")
            if fr.success and fr.data:
                task_md = fr.data.get("content", "")

        if task_md:
            # Parse but PRESERVE original step IDs by matching on description
            revised_steps = self._parse_task_list_preserving_ids(
                task_md, original_plan.get("steps", [])
            )
            if revised_steps:
                original_plan["steps"] = revised_steps
                yield AgentEvent.build("thought", {
                    "content": f"Parsed {len(revised_steps)} steps. IDs preserved for UI sync."
                })

        # Always emit plan_sync so the frontend updates its step list with correct IDs
        # This is a lightweight event that updates steps WITHOUT resetting approval status
        yield AgentEvent.build("plan_sync", {
            "id": original_plan["id"],
            "steps": original_plan["steps"],
        })
        self._last_plan = original_plan
        if self._current_session_id:
            from .database import update_session_state
            update_session_state(self._current_session_id, current_plan=original_plan)

    async def _run_implementation_phase(self, plan: dict, wait_for_command, file_contents: dict):
        """Phase 4: Gated implementation of plan steps."""
        yield AgentEvent.build("status", {"state": "implementing", "detail": "Implementing approved plan..."})
        yield AgentEvent.build("thought", {"content": "Implementation starting. I will propose changes step-by-step for your review."})

        plan_id = plan["id"]
        steps = plan["steps"]

        for step in steps:
            if self._cancelled: break
            
            step_id = step["id"]
            step_desc = step["description"]
            
            yield AgentEvent.build("thought", {"content": f"Next step: '{step_desc}'"})
            
            # Update step status in the plan object
            step["status"] = "running"
            if self._current_session_id:
                from .database import update_session_state
                update_session_state(self._current_session_id, current_plan=plan)

            yield AgentEvent.build("step_update", {
                "step_id": step_id,
                "plan_id": plan_id,
                "status": "running",
                "detail": "Executing...",
            })

            # Execute and YIELD all events (file changes, terminals)
            try:
                # We iterate over _execute_step and yield its events up to run()
                async for event in self._execute_step(step, plan_id, wait_for_command, file_contents):
                    if self._cancelled: return
                    yield event
                
                # Step finished
                step["status"] = "completed"
                if self._current_session_id:
                    from .database import update_session_state
                    update_session_state(self._current_session_id, current_plan=plan)

                yield AgentEvent.build("step_update", {
                    "step_id": step_id,
                    "plan_id": plan_id,
                    "status": "completed",
                    "detail": "Step complete",
                })
                yield AgentEvent.build("step_update", {
                    "step_id": step_id,
                    "plan_id": plan_id,
                    "status": "completed",
                    "detail": "Step complete",
                })
            except Exception as e:
                logger.error(f"Step {step_id} failed: {e}")
                yield AgentEvent.build("step_update", {
                    "step_id": step_id,
                    "plan_id": plan_id,
                    "status": "failed",
                    "detail": str(e),
                })
                yield AgentEvent.build("message", {"content": f"Step failed: {step_desc}. Error: {e}"})
                break
