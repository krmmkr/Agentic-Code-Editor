# Agentic Code Editor — Backend

FastAPI + Socket.IO + LiteLLM backend for the agentic code editor.
Supports GLM, Gemini, OpenAI, DeepSeek, Claude, and 100+ LLM providers.

## Quick Start

```bash
cd backend

# 1. Create a virtual environment (recommended)
python -m venv .venv
source .venv/bin/activate          # Linux / macOS
# .venv\Scripts\activate           # Windows

# 2. Install dependencies
pip install -r requirements.txt

# 3. Configure environment
cp .env.example .env
# Edit .env — set your LLM API key (see LLM Providers section below)

# 4. Create the workspace directory
mkdir -p workspace

# 5. Run the server
python main.py
```

The server starts at **http://localhost:8000**.

- API docs: http://localhost:8000/docs (Swagger UI)
- Health check: http://localhost:8000/health
- Socket.IO: connects via the Caddy gateway (no direct URL needed in this env)

## LLM Providers

The backend supports three modes, auto-detected from environment variables:

### Mode 1: LiteLLM (recommended — supports GLM, Gemini, OpenAI, etc.)

Set `LITELLM_MODEL` to any model from [100+ providers](https://docs.litellm.ai/docs/providers):

```bash
# GLM (Zhipu)
LITELLM_MODEL=glm/glm-4-flash
LITELLM_API_KEY=your-glm-api-key-here

# Gemini (via LiteLLM)
LITELLM_MODEL=gemini/gemini-2.0-flash
GOOGLE_API_KEY=your-google-api-key

# OpenAI
LITELLM_MODEL=openai/gpt-4o
OPENAI_API_KEY=your-openai-key

# DeepSeek
LITELLM_MODEL=deepseek/deepseek-chat
DEEPSEEK_API_KEY=your-deepseek-key

# Anthropic Claude
LITELLM_MODEL=claude-3-5-sonnet-20241022
ANTHROPIC_API_KEY=your-anthropic-key

# Custom OpenAI-compatible endpoint
LITELLM_MODEL=openai/your-model-name
LITELLM_API_KEY=your-key
LITELLM_API_BASE=https://your-endpoint/v1
```

### Mode 2: Google ADK (Gemini-only, legacy)

```bash
GOOGLE_API_KEY=your-google-api-key
GOOGLE_MODEL=gemini-2.0-flash
```

### Mode 3: Mock (default, no API key needed)

Generates deterministic plans based on keyword matching. Great for development and testing.

To switch modes, just change the env vars and restart. No code changes needed.

## Running with the Frontend

The frontend (Next.js on port 3000) supports two modes:

### Mode 1: Mock Agent (default, no backend needed)

The frontend ships with a built-in mock agent service (port 3001) that simulates the full workflow.

```bash
# Frontend
cd /path/to/project
bun run dev

# Mock agent service (auto-connects)
cd mini-services/agent-service
bun run dev
```

### Mode 2: Real Backend

Set the environment variable to switch the frontend to use the real backend:

```bash
# Frontend
NEXT_PUBLIC_AGENT_MODE=real bun run dev

# Backend
cd backend
python main.py
```

The frontend connects to the backend via the Caddy gateway automatically.

## Architecture

```
backend/
├── pyproject.toml            Package metadata (pip install -e .)
├── main.py                   Entry point (CLI: agentic-editor)
├── agentic_code_editor/      Python package
│   ├── __init__.py           Package version
│   ├── agent.py              Agent orchestrator (LiteLLM multi-provider)
│   ├── protocol.py           Shared Pydantic types for WebSocket protocol
│   ├── tools.py              File-system and shell tools
│   └── ws_manager.py         Socket.IO event handlers
├── requirements.txt          Pinned dependencies
├── .env.example              Environment variable template
├── README.md                 This file
└── workspace/                Agent's working directory
```

### How It Works

1. The **frontend** (Next.js, port 3000) connects via Socket.IO.
2. The frontend sends a `client:command` with `{ type: "chat", payload: { message } }`.
3. The **agent** (`agent.py`) reads relevant files from the workspace, sends their
   content to the LLM, and generates a plan. The plan is sent back as an
   `agent:event` with `{ type: "plan", payload: {...} }`.
4. The agent **pauses** and waits for the user to approve or reject the plan.
5. Once approved, the agent executes each step:
   - **File reads** are sent immediately as `agent:event` with `type: "file_read"`.
   - **File changes** are sent as `type: "file_change"` and **wait for approval**.
     When an LLM is configured, the agent uses it to generate actual code diffs.
   - **Terminal commands** are sent as `type: "terminal_command"` and **wait for
     approval** before executing.
6. On completion, an `agent:event` with `type: "complete"` is sent.

## Socket.IO Protocol

### Event Envelope (Server → Client)

```
socket.emit('agent:event', { type: '<event_type>', payload: { ... } })
```

### Command Envelope (Client → Server)

```
socket.on('client:command', ({ type: '<command_type>', payload: { ... } }) => { ... })
```

### Event Types

| Type | Description | Payload Fields |
|------|-------------|----------------|
| `status` | Status update | `state`, `detail` |
| `message` | Free-form agent message | `content`, `reasoning` |
| `plan` | Proposed plan for approval | `id`, `title`, `description`, `reasoning`, `steps` |
| `file_read` | File content read by agent | `path`, `reason` |
| `file_change` | Proposed file change (needs approval) | `id`, `path`, `original`, `modified`, `description` |
| `terminal_command` | Proposed command (needs approval) | `id`, `command`, `description`, `working_dir` |
| `terminal_output` | Command execution result | `command_id`, `exit_code`, `stdout`, `stderr`, `duration_ms` |
| `step_update` | Plan step status change | `step_id`, `plan_id`, `status`, `detail` |
| `error` | Error occurred | `detail` |
| `complete` | Agent finished | *(empty)* |

### Command Types

| Type | Description | Payload |
|------|-------------|---------|
| `chat` | Send a user message to the agent | `message` |
| `approve_plan` | Approve the current plan | `plan_id` |
| `reject_plan` | Reject the current plan | `plan_id`, `reason` |
| `accept_change` | Accept a proposed file change | `change_id` |
| `reject_change` | Reject a proposed file change | `change_id`, `reason` |
| `approve_terminal` | Approve a proposed terminal command | `command_id` |
| `reject_terminal` | Reject a proposed terminal command | `command_id`, `reason` |
| `cancel` | Cancel the current agent run | *(empty)* |

## REST API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/files?path=` | List files in workspace |
| `GET` | `/files/{path}` | Read a file |
| `POST` | `/files` | Create a new file (`{path, content}`) |
| `PUT` | `/files/{path}` | Update a file (`{content}`) |
| `DELETE` | `/files/{path}` | Delete a file or directory |
| `GET` | `/health` | Health check |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LITELLM_MODEL` | *(none)* | Model name (e.g., `glm/glm-4-flash`, `gemini/gemini-2.0-flash`) |
| `LITELLM_API_KEY` | *(none)* | API key for the LLM provider |
| `LITELLM_API_BASE` | *(none)* | Custom API base URL (for self-hosted models) |
| `GOOGLE_API_KEY` | *(none)* | Google AI API key (for Gemini, used by both LiteLLM and ADK) |
| `GOOGLE_MODEL` | `gemini-2.0-flash` | Gemini model (ADK legacy mode) |
| `WORKSPACE_DIR` | `./workspace` | Root directory the agent can access |
| `HOST` | `0.0.0.0` | Server bind address |
| `PORT` | `8000` | Server port |

## Packaging as a Python Package

The backend is structured as a proper Python package (`agentic-code-editor`).

### Install as editable (development)

```bash
cd backend
pip install -e .
```

This installs the `agentic-editor` CLI command and makes the package importable.

### Run via CLI

```bash
agentic-editor
# or: python -m agentic_code_editor
```

### Build a distributable package

```bash
cd backend
pip install build
python -m build
# Produces dist/agentic_code_editor-0.1.0.tar.gz
#          dist/agentic_code_editor-0.1.0-py3-none-any.whl
```

### Install from wheel

```bash
pip install agentic_code_editor-0.1.0-py3-none-any.whl
agentic-editor
```

### Use as a library

```python
from agentic_code_editor import CodeAgent

agent = CodeAgent()
async for event in agent.run(user_message, command_queue):
    print(event.to_json())
```
