"""
tools.py — File-system and shell tools used by the agent.

All tools operate relative to a configurable WORKSPACE_DIR so the agent
cannot escape the project root.
"""

from __future__ import annotations

import asyncio
import fnmatch
import os
import re
import shutil
import logging
import yaml
from pathlib import Path
from typing import Any, List
from .vector_db import get_vector_db

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
    Uses default hardcoded settings for backward compatibility with REST API.
    """
    return get_repository_map_configurable()


def get_repository_map_configurable(
    skip_dirs: set[str] | None = None,
    extensions: set[str] | None = None,
    max_files: int = 100,
    snippet_lines: int = 5,
    snippet_max_chars: int = 200,
) -> ToolResult:
    """
    Generate a concise map of the entire repository for agent context.
    All parameters are configurable via agent_config.yaml.
    """
    try:
        ws = get_workspace()
        files_map = []
        count = 0

        _skip = skip_dirs if skip_dirs is not None else {
            ".git", "node_modules", "__pycache__", ".venv", "venv", ".next", "dist", "build",
        }
        _ext = extensions if extensions is not None else {
            ".py", ".ts", ".tsx", ".js", ".jsx", ".css", ".html", ".md",
            ".json", ".yaml", ".toml",
        }

        for root, dirs, filenames in os.walk(ws):
            dirs[:] = [d for d in dirs if d not in _skip]

            for fname in sorted(filenames):
                if count >= max_files:
                    break

                fpath = os.path.join(root, fname)
                rel_path = os.path.relpath(fpath, ws)

                ext = Path(fpath).suffix.lower()
                if ext not in _ext:
                    continue

                snippet = ""
                try:
                    with open(fpath, "r", encoding="utf-8") as f:
                        lines = []
                        for _ in range(snippet_lines):
                            line = f.readline().strip()
                            if line:
                                lines.append(line)
                        snippet = " | ".join(lines)[:snippet_max_chars]
                except Exception:
                    pass

                files_map.append({
                    "path": rel_path,
                    "size": os.path.getsize(fpath),
                    "hint": snippet,
                })
                count += 1

            if count >= max_files:
                break

        return ToolResult(success=True, data={"files": files_map, "truncated": count >= max_files})
    except Exception as exc:
        return ToolResult(success=False, error=f"get_repository_map error: {exc}")


def search_files(
    pattern: str,
    file_pattern: str = "",
    max_results: int = 30,
) -> ToolResult:
    """
    Search for a regex pattern across all text files in the workspace.
    Returns matching file paths, line numbers, and matched lines.
    """
    try:
        ws = get_workspace()
        try:
            regex = re.compile(pattern, re.IGNORECASE)
        except re.error as exc:
            return ToolResult(success=False, error=f"Invalid regex pattern: {exc}")

        matches: list[dict[str, Any]] = []
        skip_dirs = {
            ".git", "node_modules", "__pycache__", ".venv", "venv",
            ".next", "dist", "build", "__pypackages__", ".mypy_cache",
            ".pytest_cache", ".ruff_cache",
        }

        for root, dirs, filenames in os.walk(ws):
            dirs[:] = [d for d in dirs if d not in skip_dirs]

            for fname in sorted(filenames):
                if len(matches) >= max_results:
                    break

                fpath = os.path.join(root, fname)

                if file_pattern and not fnmatch.fnmatch(fname, file_pattern):
                    continue

                try:
                    with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                        for line_num, line in enumerate(f, 1):
                            if regex.search(line):
                                rel_path = os.path.relpath(fpath, ws)
                                matches.append({
                                    "path": rel_path,
                                    "line": line_num,
                                    "content": line.rstrip()[:500],
                                })
                                if len(matches) >= max_results:
                                    break
                except (PermissionError, OSError):
                    continue

            if len(matches) >= max_results:
                break

        return ToolResult(success=True, data={"pattern": pattern, "matches": matches, "truncated": len(matches) >= max_results})
    except Exception as exc:
        return ToolResult(success=False, error=f"search_files error: {exc}")


async def semantic_search(query: str, limit: int = 5) -> ToolResult:
    """Search for relevant code snippets using vector embeddings."""
    try:
        db = get_vector_db()
        results = await db.search(query, limit=limit)
        return ToolResult(success=True, data={"results": results})
    except Exception as e:
        return ToolResult(success=False, error=str(e))


async def index_codebase(batch_size: int = 20) -> ToolResult:
    """Index the entire workspace into the vector database."""
    try:
        from .database import get_setting
        settings = get_setting("llm_settings", {})
        api_key = settings.get("apiKey") or get_setting("llm_api_key") or os.getenv("LITELLM_API_KEY") or os.getenv("OPENAI_API_KEY")
        
        if not api_key:
            logger.warning("No API key found. Skipping codebase indexing until LLM is configured.")
            return ToolResult(success=False, error="API key not configured. Please set your API key in the UI settings.")

        db = get_vector_db()
        db.clear()
        
        ws = get_workspace()
        files_to_index = []
        
        # Simple walk to find files
        for root, dirs, files in os.walk(ws):
            # Skip hidden and ignored dirs
            dirs[:] = [d for d in dirs if not d.startswith('.') and d not in ('.git', 'node_modules', '__pycache__', 'venv', '.venv')]
            
            for file in sorted(files):
                if file.endswith(('.py', '.js', '.ts', '.tsx', '.jsx', '.md', '.txt', '.go', '.rs')):
                    files_to_index.append(Path(root) / file)

        total_indexed = 0
        current_batch = []
        
        for file_path in files_to_index:
            try:
                rel_path = str(file_path.relative_to(ws))
                with open(file_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                
                # Simple chunking by lines (approx 1500 chars as per config)
                chunks = _chunk_text(content, chunk_size=1500, overlap=200)
                for i, chunk in enumerate(chunks):
                    current_batch.append({
                        "id": f"{rel_path}_{i}",
                        "path": rel_path,
                        "content": chunk,
                        "metadata": {"chunk_index": i}
                    })
                    
                    if len(current_batch) >= batch_size:
                        await db.add_documents(current_batch)
                        total_indexed += len(current_batch)
                        current_batch = []
            except Exception as e:
                logger.warning(f"Failed to index {file_path}: {e}")

        if current_batch:
            await db.add_documents(current_batch)
            total_indexed += len(current_batch)

        return ToolResult(success=True, data={"total_indexed_chunks": total_indexed})
    except Exception as e:
        logger.exception("Indexing failed")
        return ToolResult(success=False, error=str(e))


def _chunk_text(text: str, chunk_size: int = 1500, overlap: int = 200) -> List[str]:
    """Helper to split text into overlapping chunks."""
    if len(text) <= chunk_size:
        return [text]
    
    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunks.append(text[start:end])
        start += (chunk_size - overlap)
    return chunks
