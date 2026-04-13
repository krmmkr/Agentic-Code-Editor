import os
from flask import Flask, render_template_string

app = Flask(__name__)

# ---------------------------------------------------------------------------
# Simple landing page with the Editor embedded in an iframe.
# ---------------------------------------------------------------------------

LAYOUT = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>My Developer Dashboard</title>
    <style>
        :root {
            --bg: #0d1117;
            --sidebar: #161b22;
            --border: #30363d;
            --text: #c9d1d9;
        }
        body {
            margin: 0;
            padding: 0;
            height: 100vh;
            display: flex;
            background: var(--bg);
            color: var(--text);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
            overflow: hidden;
        }
        aside {
            width: 240px;
            background: var(--sidebar);
            border-right: 1px solid var(--border);
            display: flex;
            flex-direction: column;
            padding: 20px;
        }
        main {
            flex: 1;
            position: relative;
            display: flex;
            flex-direction: column;
        }
        header {
            padding: 12px 20px;
            background: var(--sidebar);
            border-bottom: 1px solid var(--border);
            font-weight: 600;
            font-size: 14px;
        }
        iframe {
            flex: 1;
            border: none;
            width: 100%;
            height: 100%;
        }
        h2 { font-size: 18px; margin-top: 0; }
        nav ul { list-style: none; padding: 0; margin: 20px 0; }
        nav li { padding: 10px 0; font-size: 14px; color: #8b949e; cursor: pointer; }
        nav li.active { color: #58a6ff; font-weight: 500; }
    </style>
</head>
<body>
    <aside>
        <h2>DevSuite</h2>
        <nav>
            <ul>
                <li>Project Overview</li>
                <li>Deployments</li>
                <li class="active">AI Coding Agent</li>
                <li>Settings</li>
            </ul>
        </nav>
    </aside>
    <main>
        <header>Agentic Code Editor — Connected to {{ editor_url }}</header>
        <!-- We embed the standalone editor here -->
        <iframe src="{{ editor_url }}"></iframe>
    </main>
</body>
</html>
"""

@app.route('/')
def index():
    # In production, this would be your public URL or local IP
    editor_url = os.getenv("EDITOR_URL", "http://localhost:8000")
    return render_template_string(LAYOUT, editor_url=editor_url)

if __name__ == '__main__':
    print("--- Flask Parent App Started ---")
    print("URL: http://localhost:5000")
    print("Make sure the Agentic Editor is running on http://localhost:8000")
    app.run(port=5000)
