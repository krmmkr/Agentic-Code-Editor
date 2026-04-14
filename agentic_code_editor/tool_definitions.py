"""
tool_definitions.py — LiteLLM tool/function schemas and dispatch logic.

Defines the tools available to the agentic LLM loop and maps tool names
to their implementations in tools.py.
"""

from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from typing import Any

from . import tools as _tools

logger = logging.getLogger(__name__)


TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": (
                "Read the full contents of a file. Returns the file path and its text content. "
                "Use this to understand existing code before making changes."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative file path from the workspace root (e.g. 'src/main.py').",
                    },
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": (
                "Create or overwrite a file with the given content. Creates parent directories automatically. "
                "IMPORTANT: Requires user approval before the write is applied."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative file path from the workspace root.",
                    },
                    "content": {
                        "type": "string",
                        "description": "The complete file content to write.",
                    },
                    "description": {
                        "type": "string",
                        "description": "A brief description of what this change does.",
                    },
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_files",
            "description": (
                "List immediate children of a directory. Returns name, path, type (file/directory), and size. "
                "Use this to explore the project structure."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative directory path. Leave empty for workspace root.",
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_file_tree",
            "description": (
                "Get a recursive file tree of a directory. Useful for understanding the full project layout. "
                "Skips common directories like .git, node_modules, __pycache__."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative directory path. Leave empty for workspace root.",
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_repository_map",
            "description": (
                "Get a concise map of the entire repository showing file paths, sizes, and brief snippets. "
                "Excellent starting point to understand a project's structure and locate relevant files."
            ),
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_files",
            "description": (
                "Search for a regex pattern across all text files in the workspace. "
                "Returns matching file paths, line numbers, and matched lines. "
                "Useful for finding where functions, classes, or specific strings are defined."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Regex pattern to search for (e.g. 'def my_function', 'class UserService', 'import.*react').",
                    },
                    "file_pattern": {
                        "type": "string",
                        "description": "Optional glob pattern to filter files (e.g. '*.py', '*.tsx'). Leave empty to search all files.",
                    },
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_terminal",
            "description": (
                "Execute a shell command in the workspace. Returns stdout, stderr, and exit code. "
                "IMPORTANT: Requires user approval before execution. "
                "Use for running tests, installing packages, building projects, etc."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The shell command to execute (e.g. 'python -m pytest tests/ -v').",
                    },
                    "working_dir": {
                        "type": "string",
                        "description": "Optional working directory relative to workspace root. Defaults to workspace root.",
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "Timeout in seconds. Defaults to 120.",
                    },
                    "description": {
                        "type": "string",
                        "description": "A brief description of what this command does.",
                    },
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "propose_plan",
            "description": (
                "Propose a structured implementation plan for the user to review and approve. "
                "Use this when the task involves multiple steps or files, or when the approach is non-trivial. "
                "The user can edit the plan before approval. "
                "After approval, execute each step by calling write_file or run_terminal."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Short title for the plan.",
                    },
                    "description": {
                        "type": "string",
                        "description": "Brief overview of what the plan accomplishes.",
                    },
                    "reasoning": {
                        "type": "string",
                        "description": "Your reasoning for this approach.",
                    },
                    "steps": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "description": {
                                    "type": "string",
                                    "description": "What this step does.",
                                },
                                "files": {
                                    "type": "array",
                                    "items": {"type": "string"},
                                    "description": "List of file paths this step will touch.",
                                },
                            },
                            "required": ["description"],
                        },
                        "description": "Ordered list of implementation steps.",
                    },
                },
                "required": ["title", "description", "steps"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "semantic_search",
            "description": (
                "Search for relevant code snippets using vector embeddings. "
                "Useful for finding code by meaning rather than exact text overlap."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query (e.g. 'how do we handle database migrations?').",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Number of results to return. Defaults to 5.",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "index_codebase",
            "description": (
                "Index the entire workspace into the vector database. "
                "Run this when you first arrive or when many files have changed."
            ),
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
            },
        },
    },
]


def get_tool_definitions() -> list[dict[str, Any]]:
    return TOOL_DEFINITIONS


TOOLS_REQUIRING_APPROVAL = {"write_file", "run_terminal", "propose_plan", "ask_user"}


def execute_read_file(args: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    max_chars = _nested_get(config, "tools", "read_file_max_chars", default=50000)
    result = _tools.read_file(args["path"])
    if not result.success:
        return {"error": result.error}
    data = result.data
    content = data.get("content", "")
    if len(content) > max_chars:
        content = content[:max_chars] + f"\n... (truncated, file is {len(data['content'])} chars)"
    return {"path": data["path"], "content": content}


def execute_write_file(args: dict[str, Any], _config: dict[str, Any]) -> dict[str, Any]:
    result = _tools.write_file(args["path"], args["content"])
    if not result.success:
        return {"error": result.error}
    return {"path": args["path"], "written": True}


def execute_list_files(args: dict[str, Any], _config: dict[str, Any]) -> dict[str, Any]:
    result = _tools.list_files(args.get("path", ""))
    if not result.success:
        return {"error": result.error}
    return result.data


def execute_get_file_tree(args: dict[str, Any], _config: dict[str, Any]) -> dict[str, Any]:
    result = _tools.get_file_tree(args.get("path", ""))
    if not result.success:
        return {"error": result.error}
    return result.data


def execute_get_repository_map(_args: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    skip_dirs = set(_nested_get(config, "workspace", "skip_directories", default=[]))
    extensions = set(_nested_get(config, "workspace", "source_extensions", default=[]))
    max_files = _nested_get(config, "workspace", "repo_map", "max_files", default=100)
    snippet_lines = _nested_get(config, "workspace", "repo_map", "snippet_lines", default=5)
    snippet_max = _nested_get(config, "workspace", "repo_map", "snippet_max_chars", default=200)
    result = _tools.get_repository_map_configurable(
        skip_dirs=skip_dirs,
        extensions=extensions,
        max_files=max_files,
        snippet_lines=snippet_lines,
        snippet_max_chars=snippet_max,
    )
    if not result.success:
        return {"error": result.error}
    return result.data


def execute_search_files(args: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    max_results = _nested_get(config, "tools", "search_max_results", default=30)
    result = _tools.search_files(
        pattern=args["pattern"],
        file_pattern=args.get("file_pattern", ""),
        max_results=max_results,
    )
    if not result.success:
        return {"error": result.error}
    return result.data


def execute_run_terminal(args: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    default_timeout = _nested_get(config, "tools", "terminal_default_timeout", default=120)
    timeout = args.get("timeout", default_timeout)
    result = _tools.run_terminal_command(
        command=args["command"],
        working_dir=args.get("working_dir", ""),
        timeout=timeout,
    )
    if not result.success and not result.data:
        return {"error": result.error}
    return result.data if result.data else {"error": result.error}


def execute_propose_plan(args: dict[str, Any], _config: dict[str, Any]) -> dict[str, Any]:
    return {
        "title": args["title"],
        "description": args.get("description", ""),
        "reasoning": args.get("reasoning", ""),
        "steps": args.get("steps", []),
    }


def execute_ask_user(args: dict[str, Any], _config: dict[str, Any]) -> dict[str, Any]:
    return {"question": args["question"]}


async def execute_semantic_search(args: dict[str, Any], _config: dict[str, Any]) -> dict[str, Any]:
    result = await _tools.semantic_search(args["query"], limit=args.get("limit", 5))
    if not result.success:
        return {"error": result.error}
    return result.data


async def execute_index_codebase(_args: dict[str, Any], _config: dict[str, Any]) -> dict[str, Any]:
    result = await _tools.index_codebase()
    if not result.success:
        return {"error": result.error}
    return result.data


_TOOL_DISPATCH = {
    "read_file": execute_read_file,
    "write_file": execute_write_file,
    "list_files": execute_list_files,
    "get_file_tree": execute_get_file_tree,
    "get_repository_map": execute_get_repository_map,
    "search_files": execute_search_files,
    "run_terminal": execute_run_terminal,
    "propose_plan": execute_propose_plan,
    "ask_user": execute_ask_user,
    "semantic_search": execute_semantic_search,
    "index_codebase": execute_index_codebase,
}


def execute_tool(name: str, args: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    # Note: caller should await if the handler is a coroutine
    handler = _TOOL_DISPATCH.get(name)
    if not handler:
        return {"error": f"Unknown tool: {name}"}
    try:
        import asyncio
        if asyncio.iscoroutinefunction(handler):
            # This is a bit tricky since execute_tool is sync.
            # However, agent.py calls this. I should make execute_tool async or handle it.
            # Actually, agent.py handles tool execution in _handle_tool_call which is async.
            # I'll change execute_tool to be potentially async.
            return handler(args, config) # Caller must await
        return handler(args, config)
    except Exception as exc:
        logger.exception("Tool '%s' execution failed", name)
        return {"error": f"Tool '{name}' failed: {exc}"}


def _nested_get(data: dict, *keys: str, default: Any = None) -> Any:
    current = data
    for key in keys:
        if not isinstance(current, dict):
            return default
        current = current.get(key, default)
        if current is None:
            return default
    return current
