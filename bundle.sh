#!/bin/bash
set -e

# Configuration
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$SCRIPT_DIR"
FRONTEND_DIR="$PROJECT_ROOT/frontend"
PACKAGE_DIR="$PROJECT_ROOT/agentic_code_editor"
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
cd "$PROJECT_ROOT"
# Use active python
python3 -m pip install build --quiet
python3 -m build

echo "✅ Bundle Complete!"
echo "📍 Artifacts located in: $PROJECT_ROOT/dist/"
echo "🚀 To run the packed app: python3 -m agentic_code_editor"
