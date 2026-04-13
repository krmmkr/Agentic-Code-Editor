import os
import sqlite3
import logging
from pathlib import Path
from sqlmodel import SQLModel, create_engine, Session, select

# Setup minimal logging to avoid mess
logging.basicConfig(level=logging.INFO)

# 1. Create a dummy stale database
DB_PATH = "repro_stale.db"
if os.path.exists(DB_PATH):
    os.remove(DB_PATH)

print(f"--- 1. Creating stale database at {DB_PATH} ---")
conn = sqlite3.connect(DB_PATH)
cursor = conn.cursor()
# Create sessiongroup table WITHOUT current_plan, and other modern columns
cursor.execute("""
CREATE TABLE sessiongroup (
    id TEXT PRIMARY KEY,
    title TEXT,
    workspace_path TEXT NOT NULL,
    created_at DATETIME,
    updated_at DATETIME
)
""")
conn.commit()
conn.close()

# 2. Patch DATABASE_URL in the module so it uses our temp DB
import agentic_code_editor.database as db_module
original_url = db_module.DATABASE_URL
db_module.DATABASE_URL = f"sqlite:///{DB_PATH}"
# Re-create engine with the new URL
db_module.engine = create_engine(db_module.DATABASE_URL)

print("--- 2. Running init_db() ---")
db_module.init_db()

# 3. Verify columns exist
print("--- 3. Verifying schema ---")
conn = sqlite3.connect(DB_PATH)
cursor = conn.cursor()
cursor.execute("PRAGMA table_info(sessiongroup)")
columns = [row[1] for row in cursor.fetchall()]
conn.close()

expected_cols = ["open_tabs", "pending_changes", "current_plan"]
missing = [c for c in expected_cols if c not in columns]

if not missing:
    print("SUCCESS: All missing columns were added correctly!")
else:
    print(f"FAILURE: Missing columns: {missing}")
    exit(1)

# Cleanup
if os.path.exists(DB_PATH):
    os.remove(DB_PATH)
    # Also cleanup WAL files if they exist
    for suffix in ["-shm", "-wal"]:
        if os.path.exists(DB_PATH + suffix):
            os.remove(DB_PATH + suffix)
