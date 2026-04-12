#!/bin/bash
set -e

# Configuration
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$( dirname "$SCRIPT_DIR" )"
BACKEND_DIR="$SCRIPT_DIR"
FRONTEND_DIR="$PROJECT_ROOT/frontend"
PACKAGE_DIR="$BACKEND_DIR/agentic_code_editor"
STATIC_DIR="$PACKAGE_DIR/static"

echo "🚀 Starting Unified Bundle Process..."

# 1. Install frontend dependencies
echo "📦 Installing Frontend Dependencies..."
cd "$FRONTEND_DIR"
npm install --no-fund --no-audit

# 2. Build the Next.js frontend
echo "🏗️ Building Frontend (Static Export)..."
# Force non-turbo build to avoid root inference issues
npx -y next build

# 3. Prepare the static directory in the Python package
echo "📂 Preparing static directory..."
rm -rf "$STATIC_DIR"
mkdir -p "$STATIC_DIR"

# 4. Copy the exported files
echo "🚚 Copying assets to Python package..."
if [ -d "$FRONTEND_DIR/out" ]; then
    cp -r "$FRONTEND_DIR/out/"* "$STATIC_DIR/"
else
    echo "❌ Error: Frontend build did not produce an 'out' directory."
    exit 1
fi

# 5. Build the Python package
echo "🐍 Building Python Package..."
cd "$BACKEND_DIR"
# Ensure build is installed in the venv
./.venv/bin/python3 -m pip install build --quiet
./.venv/bin/python3 -m build

echo "✅ Bundle Complete!"
echo "📍 Artifacts located in: $BACKEND_DIR/dist/"
echo "🚀 To run the packed app: python3 -m agentic_code_editor"
