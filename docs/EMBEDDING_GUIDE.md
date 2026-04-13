# Embedding & Integration Guide

The Agentic Code Editor is designed as a standalone Python package, but its architectural choices (FastAPI + Socket.IO + Next.js) make it highly flexible for integration into existing projects.

## Architecture Overview
- **Backend**: FastAPI (Python) serving REST endpoints and a Socket.IO server for real-time agent updates.
- **Frontend**: Next.js (exported as static HTML/JS) served via FastAPI's `StaticFiles`.
- **Database**: SQLModel (SQLite) with automatic schema migration on startup.

---

## Integration Patterns

### 1. Reverse Proxy (Recommended)
This is the most stable method and is ideal for production environments where you have a main web server like Nginx or Caddy.

**Workflow**:
1. Run your main application (e.g., Flask) on port `5000`.
2. Run the Agentic Code Editor on port `8000` via `python3 -m agentic_code_editor`.
3. Configure Nginx to route `/editor` to port `8000`.

**Nginx Configuration Snippet**:
```nginx
server {
    listen 80;

    # Your main application
    location / {
        proxy_pass http://localhost:5000;
    }

    # The Agentic Code Editor
    location /editor/ {
        proxy_pass http://localhost:8000/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
    }
}
```

---

### 2. ASGI Sub-app Mounting (For FastAPI / Starlette)
If your main application is also built on an ASGI framework (like FastAPI), you can mount the editor directly. This allows them to share the same event loop and port.

```python
from fastapi import FastAPI
from agentic_code_editor.main import app as editor_app

main_app = FastAPI()

# Mount the editor at /editor
main_app.mount("/editor", editor_app)

@main_app.get("/")
def home():
    return {"message": "Main App Home"}
```

---

### 3. Flask Proxying (For Flask / WSGI)
Because Socket.IO requires an async connection (WebSockets or Long-Polling), you cannot easily "mount" the Editor directly inside a Flask WSGI process. Instead, you should run the Editor as a separate process and have Flask proxy the requests or simply embed it in an `<iframe>`.

**Flask Example (`flask_embedding.py`)**:
```python
from flask import Flask, render_template_string

app = Flask(__name__)

# Simple dashboard with the editor embedded as an iframe
LAYOUT = """
... (see examples/flask_embedding.py for full code) ...
"""

@app.route('/')
def index():
    return render_template_string(LAYOUT)

if __name__ == '__main__':
    app.run(port=5000)
```

---

## Customizing the Editor UI
If you want to customize the look and feel to match your parent app:
1.  **CSS Variable Overrides**: The frontend uses standard CSS variables for its dark theme. You can inject a custom stylesheet into the `index.html` located in the package's `static` folder.
2.  **Configuration**: You can pass custom environment variables like `WORKSPACE_DIR` and `AGENTIC_CONFIG_DIR` to control where the editor works.

> [!IMPORTANT]
> When embedding in an `<iframe>`, ensure that the Editor's `CORS_ALLOWED_ORIGINS` (configured in `main.py`) includes your parent app's domain, otherwise the Socket.IO connection will be blocked by the browser.
