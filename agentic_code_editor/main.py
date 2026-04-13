"""
main.py — FastAPI application for the agentic code editor backend.

This is the entry point. The actual package code lives in agentic_code_editor/.

Endpoints:
  REST
    GET  /files          List files in the workspace
    GET  /files/{path}   Read a file
    POST /files          Create a new file
    PUT  /files/{path}   Update an existing file
    DELETE /files/{path} Delete a file

  Socket.IO
    /                     Bidirectional agent communication
    Client sends:  'client:command'  →  { type, payload }
    Server sends:  'agent:event'     ←  { type, payload }
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
import subprocess
from typing import Any, Dict, List, Optional, Union

import socketio
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

# Updated imports to use absolute package paths
from agentic_code_editor.tools import list_files, read_file, write_file, delete_file, set_workspace, get_workspace
from agentic_code_editor.agent import CodeAgent
from agentic_code_editor.ws_manager import register_handlers
from agentic_code_editor.database import (
    init_db, get_sessions, get_session_by_id, create_session_record, 
    delete_session_record, update_session_state, add_message_record, 
    get_messages, set_setting, get_setting, reset_db_content, delete_setting_record,
    rename_session_record
)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

load_dotenv()

WORKSPACE_DIR = os.path.abspath(os.getenv("WORKSPACE_DIR", "./workspace"))
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown hooks."""
    logger.info("Setting workspace to: %s", WORKSPACE_DIR)
    set_workspace(WORKSPACE_DIR)
    logger.info("Workspace initialised at %s", get_workspace())
    
    logger.info("Initializing database...")
    init_db()
    
    yield
    logger.info("Shutting down")


# ---------------------------------------------------------------------------
# Socket.IO server
# ---------------------------------------------------------------------------

sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins="*",
    logger=False,
    engineio_logger=False,
)

# Register agent event handlers on the default namespace
register_handlers(sio)


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Agentic Code Editor — Backend",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# REST request / response models
# ---------------------------------------------------------------------------

class FileEntry(BaseModel):
    name: str
    path: str
    type: str
    size: int = 0


class ListFilesResponse(BaseModel):
    path: str
    entries: list[FileEntry]


class ReadFileResponse(BaseModel):
    path: str
    content: str


class CreateFileRequest(BaseModel):
    path: str = Field(..., description="Relative path inside the workspace")
    content: str = Field("", description="Initial file content")


class UpdateFileRequest(BaseModel):
    content: str = Field(..., description="New file content")


class MessageResponse(BaseModel):
    message: str


class WorkspaceRequest(BaseModel):
    path: str = Field(..., description="Absolute path to the new workspace root")


class BrowseResponse(BaseModel):
    current_path: str
    parent_path: str | None
    entries: list[dict[str, Any]]


class LLMVerifyRequest(BaseModel):
    api_key: str | None = None
    model: str | None = None


class SettingRequest(BaseModel):
    key: str
    value: Any


class CreateSessionRequest(BaseModel):
    id: str
    title: str | None = None
    workspace_path: str
class AddMessageRequest(BaseModel):
    session_id: str
    role: str
    content: str
    payload: Any | None = None


class SessionStateUpdate(BaseModel):
    open_tabs: List[str] | None = None
    pending_changes: List[Any] | None = None
    current_plan: Dict[str, Any] | None = None


class SummaryFile(BaseModel):
    path: str
    status: str # 'added' | 'modified'


class SummaryRequest(BaseModel):
    changed_files: List[SummaryFile] | None = None


# ---------------------------------------------------------------------------
# Workspace & FS Browsing (Administrative - UI Only)
# ---------------------------------------------------------------------------

@app.get("/tree")
async def get_tree_endpoint(path: str = ""):
    """Get recursive file tree for the active workspace."""
    from agentic_code_editor.tools import get_file_tree
    result = get_file_tree(path)
    if not result.success:
        raise HTTPException(status_code=400, detail=result.error)
    return result.data


@app.get("/git/status")
async def get_git_status():
    """Get the git status of the workspace."""
    ws = get_workspace()
    try:
        # Check if it's a git repo first
        subprocess.check_call(["git", "rev-parse", "--is-inside-work-tree"], cwd=ws, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        
        # Get path from repo root to current workspace
        prefix = subprocess.check_output(["git", "rev-parse", "--show-prefix"], cwd=ws, text=True).strip()
        
        # Get status relative to repo root, using -uall to list all untracked files
        result = subprocess.check_output(
            ["git", "status", "--porcelain", "-uall"],
            cwd=ws,
            text=True
        )
        status_map = {}
        for line in result.splitlines():
            if len(line) > 3:
                code = line[:2].strip()
                path = line[3:]
                # git status --porcelain paths are relative to repo root
                if prefix and path.startswith(prefix):
                    path = path[len(prefix):].lstrip("/")
                status_map[path] = code
        return status_map
    except (subprocess.CalledProcessError, FileNotFoundError):
        return {}

@app.get("/git/diff")
async def get_git_diff(path: str):
    """Get the git diff for a specific file relative to HEAD."""
    ws = get_workspace()
    try:
        # Get repo relative path
        prefix = subprocess.check_output(["git", "rev-parse", "--show-prefix"], cwd=ws, text=True).strip()
        full_git_path = f"{prefix}{path}"
        
        # Get content from HEAD
        content = subprocess.check_output(
            ["git", "show", f"HEAD:{full_git_path}"],
            cwd=ws,
            text=True,
            stderr=subprocess.STDOUT
        )
        return {"content": content}
    except subprocess.CalledProcessError as e:
        # If file is untracked or new, return empty
        return {"content": ""}

@app.post("/session/summary")
async def generate_session_summary(req: SummaryRequest = None):
    """Generate a SESSION_SUMMARY.md file with all changes made in this session."""
    ws = get_workspace()
    summary_lines = ["# Session Summary\n", f"Generated on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n", "## Changed Files\n"]
    has_changes = False

    # 1. Try Git first
    try:
        status = subprocess.check_output(["git", "status", "--porcelain"], cwd=ws, text=True)
        if status:
            has_changes = True
            for line in status.splitlines():
                if len(line) > 3:
                    code = line[:2].strip()
                    path = line[3:]
                    try:
                        stats = subprocess.check_output(["git", "diff", "--shortstat", "HEAD", "--", path], cwd=ws, text=True).strip()
                    except:
                        stats = "New file" if code == "??" or code == "A" else ""
                    summary_lines.append(f"- **{path}** [{code}]: {stats}")

    except (subprocess.CalledProcessError, FileNotFoundError):
        # Not a git repo or git not installed
        pass

    # 2. Use provided session files if Git didn't find anything or is unavailable
    if not has_changes and req and req.changed_files:
        has_changes = True
        for f in req.changed_files:
            summary_lines.append(f"- **{f.path}** ({f.status})")

    if not has_changes:
        return {"success": False, "message": "No changes found to summarize."}

    full_summary = "\n".join(summary_lines)
    summary_path = Path(ws) / "SESSION_SUMMARY.md"
    try:
        with open(summary_path, "w") as f:
            f.write(full_summary)
        return {"success": True, "message": "Summary generated successfully.", "path": "SESSION_SUMMARY.md"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to write summary: {str(e)}")

@app.get("/workspace/current")
async def get_current_workspace():
    """Get the absolute path of the current workspace."""
    return {"path": str(get_workspace())}


@app.post("/llm/verify")
async def verify_llm_endpoint(req: LLMVerifyRequest):
    """Test LLM credentials."""
    return await CodeAgent.verify_credentials(req.api_key, req.model)


@app.post("/workspace")
async def set_workspace_endpoint(req: WorkspaceRequest):
    """Change the active workspace root at runtime."""
    new_path = Path(req.path).resolve()
    if not new_path.exists() or not new_path.is_dir():
        raise HTTPException(status_code=400, detail=f"Invalid directory: {req.path}")
    
    logger.info("Switching workspace to: %s", new_path)
    set_workspace(new_path)
    return {"status": "success", "workspace": str(get_workspace())}


@app.get("/browse", response_model=BrowseResponse)
async def browse_fs(path: str = "/"):
    """
    List contents of ANY directory on the host (for Folder Picker).
    This is NOT available to the agent.
    """
    target = Path(path).resolve()
    if not target.exists() or not target.is_dir():
        # Fallback to home or root if invalid
        target = Path.home()
        if not target.exists():
            target = Path("/")

    entries = []
    try:
        for child in sorted(target.iterdir()):
            # Only show directories for the picker
            if child.is_dir():
                entries.append({
                    "name": child.name,
                    "path": str(child.absolute()),
                    "type": "directory"
                })
    except PermissionError:
        pass # Skip unreadable dirs

    return BrowseResponse(
        current_path=str(target.absolute()),
        parent_path=str(target.parent.absolute()) if target.parent != target else None,
        entries=entries
    )


# ---------------------------------------------------------------------------
# Database & Session Management
# ---------------------------------------------------------------------------

@app.get("/sessions")
async def list_sessions(workspace: str | None = None):
    """List sessions, optionally filtered by workspace."""
    ws = workspace or str(get_workspace())
    return get_sessions(ws)


@app.post("/sessions")
async def create_session_endpoint(req: CreateSessionRequest):
    """Create a new chat session."""
    return create_session_record(req.id, req.workspace_path, req.title)


@app.get("/sessions/{session_id}/messages")
async def list_messages(session_id: str):
    """Get messages for a specific session."""
    return get_messages(session_id)


@app.post("/messages")
async def add_message_endpoint(req: AddMessageRequest):
    """Save a single message to a session."""
    msg = add_message_record(req.session_id, req.role, req.content, req.payload)
    
    # Intelligent Renaming:
    # If this is a user message and the session still has a default "Session X" title,
    # rename it to a snippet of the first message.
    if req.role == 'user':
        session_rec = get_session_by_id(req.session_id)
        if session_rec and (not session_rec.title or session_rec.title == 'New Session' or session_rec.title.startswith('Session ')):
            # Generate a title (simple first-message snippet for now, can be LLM later)
            new_title = req.content[:40].strip() + ("..." if len(req.content) > 40 else "")
            rename_session_record(req.session_id, new_title)
            
    return msg


@app.get("/settings/{key}")
async def get_setting_endpoint(key: str):
    """Get a global setting."""
    return {"value": get_setting(key)}


@app.post("/settings")
async def set_setting_endpoint(req: SettingRequest):
    """Set a global setting."""
    set_setting(req.key, req.value)
    return {"status": "success"}


@app.delete("/settings/{key}")
async def delete_setting_endpoint(key: str):
    """Delete a global setting."""
    delete_setting_record(key)
    return {"status": "success"}


@app.post("/database/reset")
async def reset_database_endpoint():
    """Wipe all sessions and messages."""
    reset_db_content()
    return {"status": "success", "message": "Database wiped successfully"}


@app.get("/sessions/{session_id}")
async def get_session_endpoint(session_id: str):
    """Get a specific session."""
    session = get_session_by_id(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@app.put("/sessions/{session_id}/state")
async def update_session_state_endpoint(session_id: str, req: SessionStateUpdate):
    """Update UI state (tabs, changes) for a session."""
    return update_session_state(session_id, req.open_tabs, req.pending_changes, req.current_plan)


@app.delete("/sessions/{session_id}")
async def delete_session_endpoint(session_id: str):
    """Delete a session."""
    delete_session_record(session_id)
    return {"status": "success"}


# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------

@app.get("/files", response_model=ListFilesResponse)
async def list_files_endpoint(path: str = ""):
    """List files in the workspace (or a subdirectory)."""
    result = list_files(path)
    if not result.success:
        raise HTTPException(status_code=400, detail=result.error)
    data = result.data  # type: ignore[assignment]
    return ListFilesResponse(
        path=data["path"],
        entries=[FileEntry(**e) for e in data["entries"]],
    )


@app.get("/files/{file_path:path}", response_model=ReadFileResponse)
async def read_file_endpoint(file_path: str):
    """Read a file from the workspace."""
    result = read_file(file_path)
    if not result.success:
        raise HTTPException(status_code=404, detail=result.error)
    data = result.data  # type: ignore[assignment]
    return ReadFileResponse(path=data["path"], content=data["content"])


@app.post("/files", response_model=MessageResponse, status_code=201)
async def create_file(req: CreateFileRequest):
    """Create a new file (and any missing parent directories)."""
    existing = read_file(req.path)
    if existing.success:
        raise HTTPException(status_code=409, detail=f"File already exists: {req.path}")

    result = write_file(req.path, req.content)
    if not result.success:
        raise HTTPException(status_code=400, detail=result.error)
    return MessageResponse(message=f"Created {req.path}")


@app.put("/files/{file_path:path}", response_model=MessageResponse)
async def update_file(file_path: str, req: UpdateFileRequest):
    """Overwrite an existing file."""
    existing = read_file(file_path)
    if not existing.success:
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")

    result = write_file(file_path, req.content)
    if not result.success:
        raise HTTPException(status_code=400, detail=result.error)
    return MessageResponse(message=f"Updated {file_path}")


@app.delete("/files/{file_path:path}", response_model=MessageResponse)
async def delete_file_endpoint(file_path: str):
    """Delete a file or directory."""
    result = delete_file(file_path)
    if not result.success:
        raise HTTPException(status_code=404, detail=result.error)
    return MessageResponse(message=f"Deleted {file_path}")


@app.get("/health")
async def health():
    return {"status": "ok", "workspace": str(get_workspace())}


# ---------------------------------------------------------------------------
# Static File Serving (UI)
# ---------------------------------------------------------------------------

# Locate static assets relative to this file
STATIC_DIR = Path(__file__).parent / "static"

# Only mount if the directory exists (it will be created during build)
if STATIC_DIR.exists():
    # Helper to check if a path should be served as a static file
    def is_static_file(path: str) -> bool:
        return "." in path and not path.startswith("api/")

    @app.get("/{rest_of_path:path}")
    async def serve_spa(rest_of_path: str):
        # Default to root index
        if not rest_of_path or rest_of_path == "/":
            return FileResponse(STATIC_DIR / "index.html")

        # Check if it's a known static file
        file_path = STATIC_DIR / rest_of_path
        if file_path.exists() and file_path.is_file():
            return FileResponse(file_path)
        
        # If it doesn't have an extension, it's likely a client-side route
        if "." not in rest_of_path:
            index_file = STATIC_DIR / "index.html"
            if index_file.exists():
                return FileResponse(index_file)
        
        # Finally, check for .html version (Next.js export behavior)
        html_version = STATIC_DIR / f"{rest_of_path}.html"
        if html_version.exists():
            return FileResponse(html_version)

        raise HTTPException(status_code=404, detail="Not found")

# ---------------------------------------------------------------------------
# Mount Socket.IO on FastAPI (ASGI)
# ---------------------------------------------------------------------------

socket_app = socketio.ASGIApp(sio, app)


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

def run_server():
    """CLI entry point — start the server."""
    import uvicorn

    logger.info(
        "Starting Agentic Code Editor backend at %s:%d (workspace: %s)",
        HOST, PORT, WORKSPACE_DIR,
    )
    # Corrected the module path for uvicorn
    uvicorn.run(
        "agentic_code_editor.main:socket_app",
        host=HOST,
        port=PORT,
        reload=True,
    )


if __name__ == "__main__":
    run_server()
