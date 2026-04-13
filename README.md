# Agentic Code Editor

A next-generation, agentic code editor featuring a **Human-in-the-Loop AI workflow**. This project combines a high-performance Next.js frontend with a powerful Python backend orchestrating LLMs (LiteLLM) to perform autonomous coding tasks with user-approved gates.

![Banner](https://github.com/user-attachments/assets/placeholder)

## 🚀 Features

- **Autonomous Agent**: Research, plan, and implement code changes across your repository.
- **Architect-Implementer Flow**: The agent proposes a plan, you approve it, and then it implements changes step-by-step.
- **Human-in-the-Loop**: Every major action (terminal commands, file changes) requires your approval.
- **LiteLLM Integration**: Support for 100+ LLMs (OpenAI, Claude, Gemini, etc.) with standardized API usage.
- **Real-time Terminal**: Watch the agent execute commands and inspect logs in a live terminal.

## 🏗 Project Structure

```text
.
├── agentic_code_editor/ # Core Python package (Backend & Agent)
├── frontend/           # Next.js + Tailwind UI (Source)
├── pyproject.toml      # Packaging metadata
├── bundle.sh           # Unified build script
└── workspace/          # Default directory for agent operations
```

## 🛠 Setup

### Prerequisites

- Node.js 18+
- Python 3.10+
- [LiteLLM Supported API Keys](https://docs.litellm.ai/docs/providers)

### Backend Installation

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
# Add your API keys to .env
python -m agentic_code_editor.main
```

### Frontend Installation

```bash
cd frontend
npm install
npm run dev
```

The app will be available at `http://localhost:3000`.

## 📦 Package

```bash
pip install agentic-code-editor
agentic-editor
```

## 📚 Documentation

- [Embedding & Integration Guide](docs/EMBEDDING_GUIDE.md) — Learn how to embed the editor in your own Flask or FastAPI applications.

## 📄 License

MIT © Kohul
