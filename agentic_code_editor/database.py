import os
import logging
from datetime import datetime
from pathlib import Path
from typing import List, Optional
import json

from sqlmodel import Field, Relationship, Session, SQLModel, create_engine, select

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

logger = logging.getLogger(__name__)

HOME_DIR = Path.home()
CONFIG_DIR = Path(os.getenv("AGENTIC_CONFIG_DIR", str(HOME_DIR / ".agentic_editor")))
DATABASE_URL = f"sqlite:///{CONFIG_DIR}/agentic.db"

# Ensure config directory exists
CONFIG_DIR.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class SessionBase(SQLModel):
    title: Optional[str] = None
    workspace_path: str
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    
    # Extended state
    open_tabs: str = Field(default="[]")  # JSON list of strings
    pending_changes: str = Field(default="[]")  # JSON list of DiffChange objects

class SessionGroup(SessionBase, table=True):
    id: Optional[str] = Field(default=None, primary_key=True)
    messages: List["Message"] = Relationship(back_populates="session", cascade_delete=True)

class MessageBase(SQLModel):
    role: str  # 'user' | 'assistant'
    content: str
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    session_id: str = Field(foreign_key="sessiongroup.id")
    payload: Optional[str] = None  # JSON serialized data (Plan, Command, etc.)

class Message(MessageBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    session: SessionGroup = Relationship(back_populates="messages")

class Setting(SQLModel, table=True):
    key: str = Field(primary_key=True)
    value: str  # JSON string

# ---------------------------------------------------------------------------
# Database Engine & Initialization
# ---------------------------------------------------------------------------

# Use WAL mode for better concurrency in multi-process/venv setups
engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False}
)

def init_db():
    SQLModel.metadata.create_all(engine)
    # Perform one-time migrations
    migrate_workspace_paths()
    migrate_message_payload_column()
    with engine.connect() as connection:
        # Enable WAL mode for high-concurrency (multiple instances)
        connection.exec_driver_sql("PRAGMA journal_mode=WAL;")
        connection.exec_driver_sql("PRAGMA synchronous=NORMAL;")

def reset_db_content():
    """Wipe all session data but keep settings."""
    with Session(engine) as session:
        # Delete messages first (foreign key)
        session.exec("DELETE FROM message")
        session.exec("DELETE FROM sessiongroup")
        session.commit()

def migrate_workspace_paths():
    """Consolidate relative workspace paths into absolute ones."""
    logger.info("Starting workspace path migration...")
    with Session(engine) as session:
        sessions = session.exec(select(SessionGroup)).all()
        updated_count = 0
        for s in sessions:
            if s.workspace_path:
                try:
                    # Resolve to absolute path
                    abs_path = os.path.abspath(s.workspace_path)
                    if s.workspace_path != abs_path:
                        logger.info("Migrating session '%s' path: %s -> %s", s.id, s.workspace_path, abs_path)
                        s.workspace_path = abs_path
                        updated_count += 1
                except Exception as e:
                    logger.warning("Could not migrate path for session %s: %s", s.id, e)
        
        if updated_count > 0:
            session.commit()
            logger.info("Successfully migrated %d session paths to absolute.", updated_count)
        else:
            logger.info("No relative session paths found for migration.")

def migrate_message_payload_column():
    """Manually add 'payload' column to 'message' table if it's missing (SQLite migration)."""
    with engine.connect() as connection:
        try:
            # Check if payload column exists
            result = connection.exec_driver_sql("PRAGMA table_info(message);").all()
            columns = [row[1] for row in result]
            if "payload" not in columns:
                logger.info("Migrating schema: adding 'payload' column to 'message' table...")
                connection.exec_driver_sql("ALTER TABLE message ADD COLUMN payload TEXT;")
                connection.commit()
                logger.info("Successfully added 'payload' column.")
            else:
                logger.debug("'payload' column already exists in 'message' table.")
        except Exception as e:
            logger.error("Failed to migrate 'message' table schema: %s", e)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def get_sessions(workspace_path: str) -> List[SessionGroup]:
    # Always normalize path to absolute
    abs_workspace = os.path.abspath(workspace_path) if workspace_path else None
    
    with Session(engine) as session:
        # If workspace_path is provided, filter by it, otherwise return all
        statement = select(SessionGroup)
        if abs_workspace:
            statement = statement.where(SessionGroup.workspace_path == abs_workspace)
        statement = statement.order_by(SessionGroup.updated_at.desc())
        return session.exec(statement).all()

def get_session_by_id(session_id: str) -> Optional[SessionGroup]:
    with Session(engine) as session:
        return session.get(SessionGroup, session_id)

def create_session_record(session_id: str, workspace_path: str, title: Optional[str] = None) -> SessionGroup:
    # Always normalize path to absolute
    abs_workspace = os.path.abspath(workspace_path)
    
    with Session(engine) as session:
        db_session = SessionGroup(id=session_id, workspace_path=abs_workspace, title=title)
        session.add(db_session)
        session.commit()
        session.refresh(db_session)
        return db_session

def delete_session_record(session_id: str):
    with Session(engine) as session:
        db_session = session.get(SessionGroup, session_id)
        if db_session:
            session.delete(db_session)
            session.commit()

def rename_session_record(session_id: str, new_title: str):
    with Session(engine) as session:
        db_session = session.get(SessionGroup, session_id)
        if db_session:
            db_session.title = new_title
            session.add(db_session)
            session.commit()
            return db_session
    return None

def update_session_state(session_id: str, open_tabs: List[str] = None, pending_changes: List[dict] = None):
    with Session(engine) as session:
        db_session = session.get(SessionGroup, session_id)
        if db_session:
            if open_tabs is not None:
                db_session.open_tabs = json.dumps(open_tabs)
            if pending_changes is not None:
                db_session.pending_changes = json.dumps(pending_changes)
            db_session.updated_at = datetime.utcnow()
            session.add(db_session)
            session.commit()
            session.refresh(db_session)
            return db_session

def add_message_record(session_id: str, role: str, content: str, payload: any = None) -> Message:
    with Session(engine) as session:
        payload_str = json.dumps(payload) if payload is not None else None
        db_message = Message(session_id=session_id, role=role, content=content, payload=payload_str)
        session.add(db_message)
        
        # Update session timestamp
        statement = select(SessionGroup).where(SessionGroup.id == session_id)
        db_session = session.exec(statement).one_or_none()
        if db_session:
            db_session.updated_at = datetime.utcnow()
            session.add(db_session)
        
        session.commit()
        session.refresh(db_message)
        return db_message

def get_messages(session_id: str) -> List[Message]:
    with Session(engine) as session:
        statement = select(Message).where(Message.session_id == session_id).order_by(Message.timestamp.asc())
        return session.exec(statement).all()

def set_setting(key: str, value: any):
    with Session(engine) as session:
        db_setting = session.get(Setting, key)
        if db_setting:
            db_setting.value = json.dumps(value)
        else:
            db_setting = Setting(key=key, value=json.dumps(value))
        session.add(db_setting)
        session.commit()

def delete_setting_record(key: str):
    with Session(engine) as session:
        db_setting = session.get(Setting, key)
        if db_setting:
            session.delete(db_setting)
            session.commit()

def get_setting(key: str, default=None) -> any:
    with Session(engine) as session:
        db_setting = session.get(Setting, key)
        if db_setting:
            return json.loads(db_setting.value)
        return default
