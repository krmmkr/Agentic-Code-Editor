import os
import logging
import json
from pathlib import Path
from typing import List, Dict, Any, Optional

import duckdb
import numpy as np
import litellm
from .database import get_setting

logger = logging.getLogger(__name__)

class VectorDB:
    def __init__(self, db_path: str = None):
        if db_path is None:
            home = Path.home()
            config_dir = Path(os.getenv("AGENTIC_CONFIG_DIR", str(home / ".agentic_editor")))
            config_dir.mkdir(parents=True, exist_ok=True)
            db_path = str(config_dir / "vector_store.duckdb")
        
        self.db_path = db_path
        self.conn = duckdb.connect(db_path)
        self._local_model = None
        self._init_db()

    def _init_db(self):
        """Initialize DuckDB tables for vector storage."""
        self.conn.execute("INSTALL vss;")
        self.conn.execute("LOAD vss;")
        
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS documents (
                id VARCHAR PRIMARY KEY,
                path VARCHAR,
                content TEXT,
                embedding FLOAT[1536], -- Default to OpenAI/LiteLLM standard 1536
                metadata JSON
            )
        """)
        # We can't easily create a VSS index via SQL in all versions, 
        # so we'll rely on linear search (very fast in DuckDB for small/medium repos)
        # or just raw cosine similarity.

    async def add_documents(self, docs: List[Dict[str, Any]], model: str = None):
        """Embed and add documents to the store."""
        contents = [d["content"] for d in docs]
        
        if model is None:
            # Try to get from config
            from .agent import _load_config
            cfg = _load_config()
            model = cfg.get("vector_db", {}).get("embedding_model", "text-embedding-3-small")
        
        try:
            settings = get_setting("llm_settings", {})
            api_key = settings.get("apiKey") or get_setting("llm_api_key") or os.getenv("LITELLM_API_KEY") or os.getenv("OPENAI_API_KEY")
            api_base = settings.get("apiBase") or get_setting("llm_api_base") or os.getenv("LITELLM_API_BASE")
            
            # Smart Routing: If using default OpenAI model but base is non-OpenAI (e.g. DeepSeek), drop the base
            if model.startswith("text-embedding-") and api_base and "openai.com" not in api_base:
                logger.info(f"Custom api_base '{api_base}' detected for OpenAI model '{model}'. Suppressing base for routing.")
                api_base = None

            try:
                # We use litellm.embedding to get vectors
                response = await litellm.aembedding(
                    model=model,
                    input=contents,
                    api_key=api_key,
                    api_base=api_base
                )
                embeddings = [r["embedding"] for r in response.data]
            except Exception as le:
                logger.warning(f"LiteLLM embedding failed, falling back to local model: {le}")
                embeddings = await self._get_local_embeddings(contents)
            
            for doc, emb in zip(docs, embeddings):
                doc_id = doc.get("id", str(hash(doc["path"] + doc["content"])))
                metadata = json.dumps(doc.get("metadata", {}))
                
                self.conn.execute(
                    "INSERT OR REPLACE INTO documents (id, path, content, embedding, metadata) VALUES (?, ?, ?, ?, ?)",
                    (doc_id, doc["path"], doc["content"], emb, metadata)
                )
        except Exception as e:
            logger.error(f"Failed to add documents to VectorDB: {e}")
            raise

    async def search(self, query: str, limit: int = 5, model: str = None) -> List[Dict[str, Any]]:
        """Perform semantic search."""
        if model is None:
            # Try to get from config
            from .agent import _load_config
            cfg = _load_config()
            model = cfg.get("vector_db", {}).get("embedding_model", "text-embedding-3-small")
        try:
            settings = get_setting("llm_settings", {})
            api_key = settings.get("apiKey") or get_setting("llm_api_key") or os.getenv("LITELLM_API_KEY") or os.getenv("OPENAI_API_KEY")
            api_base = settings.get("apiBase") or get_setting("llm_api_base") or os.getenv("LITELLM_API_BASE")

            # Smart Routing
            if model.startswith("text-embedding-") and api_base and "openai.com" not in api_base:
                api_base = None

            try:
                response = await litellm.aembedding(
                    model=model,
                    input=[query],
                    api_key=api_key,
                    api_base=api_base
                )
                query_emb = response.data[0]["embedding"]
            except Exception:
                # Fallback to local
                embs = await self._get_local_embeddings([query])
                query_emb = embs[0]
            
            # Use DuckDB's native array distance (cosine similarity)
            # array_cosine_similarity returns 1.0 for exact match, 0.0 for orthogonal
            res = self.conn.execute(
                f"""
                SELECT path, content, metadata, 
                       array_cosine_similarity(embedding, ?::FLOAT[1536]) as score
                FROM documents
                ORDER BY score DESC
                LIMIT ?
                """,
                (query_emb, limit)
            ).fetchall()
            
            results = []
            for path, content, metadata_json, score in res:
                results.append({
                    "path": path,
                    "content": content,
                    "metadata": json.loads(metadata_json) if metadata_json else {},
                    "score": float(score)
                })
            return results
        except Exception as e:
            logger.error(f"Vector search failed: {e}")
            return []

    def clear(self):
        self.conn.execute("DELETE FROM documents")

    async def _get_local_embeddings(self, texts: List[str]) -> List[List[float]]:
        """Fallback to local sentence-transformers if cloud fails."""
        if self._local_model is None:
            logger.info("Initializing local SentenceTransformer (all-MiniLM-L6-v2)...")
            from sentence_transformers import SentenceTransformer
            # This is a small, fast 384-dim model. 
            # Note: We use 1536 in DB schema, so we'll pad or we might need to change schema.
            # Actually, let's use a 1536-dim local model if possible, or just re-init table.
            # For simplicity, we'll use 384 and DuckDB doesn't strictly enforce size beyond what we declared.
            self._local_model = SentenceTransformer('all-MiniLM-L6-v2')
        
        embeddings = self._local_model.encode(texts).tolist()
        
        # If the DB expected 1536 but we got 384, we pad with zeros to avoid schema mismatch
        # in some strict vector database versions. DuckDB FLOAT[N] is usually strict.
        # But we can also just cast it in the query.
        padded = []
        for emb in embeddings:
            if len(emb) < 1536:
                emb = emb + [0.0] * (1536 - len(emb))
            padded.append(emb[:1536])
        return padded

_instance = None

def get_vector_db() -> VectorDB:
    global _instance
    if _instance is None:
        _instance = VectorDB()
    return _instance
