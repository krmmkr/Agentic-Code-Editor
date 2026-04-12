"""
tools.py — File-system and shell tools used by the agent.

All tools operate relative to a configurable WORKSPACE_DIR so the agent
cannot escape the project root.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import logging
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


logger = logging.getLogger(__name__)


_WORKSPACE: Path | None = None


def set_workspace(path: str | Path) -> None:
    """Set the root workspace directory. Called once at startup."""
    global _WORKSPACE
    _WORKSPACE = Path(path).resolve()
    _WORKSPACE.mkdir(parents=True, exist_ok=True)


def get_workspace() -> Path:
    assert _WORKSPACE is not None, "Workspace not initialised — call set_workspace() first"
    return _WORKSPACE


def _resolve(rel_path: str) -> Path:
    """Resolve *rel_path* inside the workspace and verify it stays within."""
    ws = get_workspace()
    # Strip leading slashes to prevent pathlib from treating it as an absolute path
    clean_path = rel_path.lstrip("/")
    target = (ws / clean_path).resolve()
    if not str(target).startswith(str(ws)):
        raise PermissionError(f"Path escapes workspace: {rel_path}")
    return target


# ---------------------------------------------------------------------------
# Tool result model
# ---------------------------------------------------------------------------

class ToolResult(BaseModel):
    success: bool = True
    data: Any = None
    error: str = ""


# ---------------------------------------------------------------------------
# Public tool functions
# ---------------------------------------------------------------------------

def read_file(path: str) -> ToolResult:
    """Read the full content of a file inside the workspace."""
    try:
        target = _resolve(path)
        logger.info("Reading file: %s (resolved to: %s)", path, target)
        if not target.is_file():
            logger.warning("File not found: %s", target)
            return ToolResult(success=False, error=f"File not found: {path}")
        content = target.read_text(encoding="utf-8")
        return ToolResult(success=True, data={"path": path, "content": content})
    except PermissionError as exc:
        return ToolResult(success=False, error=str(exc))
    except Exception as exc:
        return ToolResult(success=False, error=f"read_file error: {exc}")


def write_file(path: str, content: str) -> ToolResult:
    """Write *content* to a file inside the workspace (creates dirs as needed)."""
    try:
        target = _resolve(path)
        logger.info("Writing file: %s (resolved to: %s)", path, target)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        return ToolResult(success=True, data={"path": path})
    except PermissionError as exc:
        return ToolResult(success=False, error=str(exc))
    except Exception as exc:
        return ToolResult(success=False, error=f"write_file error: {exc}")


def list_files(path: str = "") -> ToolResult:
    """List immediate children of *path* (default = workspace root)."""
    try:
        target = _resolve(path) if path else get_workspace()
        if not target.is_dir():
            return ToolResult(success=False, error=f"Not a directory: {path}")
        entries: list[dict[str, Any]] = []
        for child in sorted(target.iterdir()):
            entries.append({
                "name": child.name,
                "path": str(child.relative_to(get_workspace())),
                "type": "directory" if child.is_dir() else "file",
                "size": child.stat().st_size if child.is_file() else 0,
            })
        return ToolResult(success=True, data={"path": path, "entries": entries})
    except PermissionError as exc:
        return ToolResult(success=False, error=str(exc))
    except Exception as exc:
        return ToolResult(success=False, error=f"list_files error: {exc}")


def get_file_tree(path: str = "", max_depth: int = 5) -> ToolResult:
    """
    Recursively build a file tree (JSON-like structure) up to *max_depth*.
    """
    try:
        target = _resolve(path) if path else get_workspace()
        if not target.is_dir():
            return ToolResult(success=False, error=f"Not a directory: {path}")

        def _walk(current: Path, depth: int) -> list[dict[str, Any]]:
            if depth > max_depth:
                return [{"name": current.name, "type": "directory", "truncated": True}]
            items: list[dict[str, Any]] = []
            try:
                for child in sorted(current.iterdir()):
                    # Skip common junk directories
                    if child.name in {".git", "__pycache__", "node_modules", ".next", "dist", ".venv", "venv"}:
                        continue
                    if child.is_dir():
                        children = _walk(child, depth + 1)
                        items.append({
                            "name": child.name,
                            "path": str(child.relative_to(get_workspace())),
                            "type": "directory",
                            "children": children,
                        })
                    else:
                        items.append({
                            "name": child.name,
                            "path": str(child.relative_to(get_workspace())),
                            "type": "file",
                            "size": child.stat().st_size,
                        })
            except PermissionError:
                pass
            return items

        tree = _walk(target, 0)
        return ToolResult(success=True, data={"path": path or ".", "tree": tree})
    except PermissionError as exc:
        return ToolResult(success=False, error=str(exc))
    except Exception as exc:
        return ToolResult(success=False, error=f"get_file_tree error: {exc}")


async def run_terminal_command(
    command: str,
    working_dir: str = "",
    timeout: int = 120,
) -> ToolResult:
    """
    Execute a shell command asynchronously.

    Returns stdout, stderr, and exit_code.
    The *working_dir* is resolved inside the workspace.
    """
    try:
        cwd = _resolve(working_dir) if working_dir else get_workspace()
        if not cwd.is_dir():
            return ToolResult(success=False, error=f"Working directory not found: {working_dir}")

        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(cwd),
        )

        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return ToolResult(
                success=False,
                data={
                    "stdout": "",
                    "stderr": f"Command timed out after {timeout}s",
                    "exit_code": -1,
                },
            )

        stdout = stdout_bytes.decode("utf-8", errors="replace")
        stderr = stderr_bytes.decode("utf-8", errors="replace")

        return ToolResult(
            success=proc.returncode == 0,
            data={
                "stdout": stdout,
                "stderr": stderr,
                "exit_code": proc.returncode,
            },
        )
    except PermissionError as exc:
        return ToolResult(success=False, error=str(exc))
    except Exception as exc:
        return ToolResult(success=False, error=f"run_terminal_command error: {exc}")


def delete_file(path: str) -> ToolResult:
    """Delete a file or empty directory inside the workspace."""
    try:
        target = _resolve(path)
        if not target.exists():
            return ToolResult(success=False, error=f"Path not found: {path}")
        if target.is_dir():
            shutil.rmtree(target)
        else:
            target.unlink()
        return ToolResult(success=True, data={"path": path})
    except PermissionError as exc:
        return ToolResult(success=False, error=str(exc))
    except Exception as exc:
        return ToolResult(success=False, error=f"delete_file error: {exc}")


def get_repository_map() -> ToolResult:
    """
    Generate a concise map of the entire repository for agent context.
    Includes file paths and the first few lines of each text file for symbol hints.
    """
    try:
        ws = get_workspace()
        files_map = []
        
        # Max files to map to prevent context explosion
        MAX_FILES = 100
        count = 0

        for root, dirs, filenames in os.walk(ws):
            dirs[:] = [d for d in dirs if d not in {".git", "node_modules", "__pycache__", ".venv", "venv", ".next", "dist", "build"}]
            
            for fname in sorted(filenames):
                if count >= MAX_FILES:
                    break
                
                fpath = os.path.join(root, fname)
                rel_path = os.path.relpath(fpath, ws)
                
                # Check extension
                ext = Path(fpath).suffix.lower()
                if ext not in {".py", ".ts", ".tsx", ".js", ".jsx", ".css", ".html", ".md", ".json", ".yaml", ".toml"}:
                    continue

                snippet = ""
                try:
                    with open(fpath, "r", encoding="utf-8") as f:
                        lines = []
                        for _ in range(5): # Read first 5 lines for context
                            line = f.readline().strip()
                            if line:
                                lines.append(line)
                        snippet = " | ".join(lines)[:200]
                except Exception:
                    pass

                files_map.append({
                    "path": rel_path,
                    "size": os.path.getsize(fpath),
                    "hint": snippet
                })
                count += 1
            
            if count >= MAX_FILES:
                break

        return ToolResult(success=True, data={"files": files_map, "truncated": count >= MAX_FILES})
    except Exception as exc:
        return ToolResult(success=False, error=f"get_repository_map error: {exc}")
