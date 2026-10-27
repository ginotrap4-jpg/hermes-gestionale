"""Gestionale Hermes — state layer (SQLite).

Persistent state for offices, agents, chats, automations, projects.
Thread-safe via check_same_thread=False + a lock.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path

DB_PATH = Path(__file__).parent / "state.db"

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS offices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT DEFAULT 'Building',
  color TEXT DEFAULT '#7aa2f7',
  role_instructions TEXT DEFAULT '',
  allowed_toolsets TEXT DEFAULT '[]',
  model TEXT DEFAULT '',
  kind TEXT DEFAULT 'worker'
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  office_id TEXT NOT NULL REFERENCES offices(id),
  mission_id TEXT DEFAULT '',
  state TEXT DEFAULT 'PENDING',
  goal TEXT DEFAULT '',
  started_at REAL DEFAULT 0,
  heartbeat_at REAL DEFAULT 0,
  progress REAL DEFAULT 0,
  model TEXT DEFAULT '',
  toolsets TEXT DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,             -- 'group' | 'dm'
  name TEXT DEFAULT '',
  participants TEXT DEFAULT '[]', -- json list of agent ids
  state TEXT DEFAULT 'open',      -- 'open' | 'closed' (v0.4: flag via codice)
  last_message_ts REAL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  from_agent_id TEXT NOT NULL,
  to_agent_ids TEXT DEFAULT '[]', -- json list ('[]' = whole chat)
  text TEXT NOT NULL,
  ts REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT DEFAULT 'engine',   -- 'hermes_cron' | 'engine'
  trigger TEXT DEFAULT 'interval',
  schedule_raw TEXT DEFAULT '',
  enabled INTEGER DEFAULT 1,
  next_run REAL,
  last_run_ts REAL,
  last_run_status TEXT DEFAULT '',
  last_run_duration_ms INTEGER,
  office_id TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS automation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  automation_id TEXT NOT NULL,
  ts REAL NOT NULL,
  status TEXT DEFAULT 'ok',
  duration_ms INTEGER DEFAULT 0,
  log TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  progress REAL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  title TEXT NOT NULL,
  office_id TEXT DEFAULT '',
  progress REAL DEFAULT 0,
  agent_ids TEXT DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT DEFAULT 'todo',   -- backlog|todo|in_progress|in_review|done|blocked|cancelled
  parent_id TEXT DEFAULT '',
  assignee_agent_id TEXT DEFAULT '',
  assignee_office_id TEXT DEFAULT '',
  priority TEXT DEFAULT 'p2',   -- p0|p1|p2|p3
  project_id TEXT DEFAULT '',
  created_at REAL DEFAULT 0,
  updated_at REAL DEFAULT 0,
  preview TEXT DEFAULT '',
  color TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS task_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  author TEXT DEFAULT '',
  author_kind TEXT DEFAULT 'agent',  -- agent|user
  text TEXT NOT NULL,
  ts REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS gatekeeper_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL,
  requesting_office TEXT DEFAULT '',
  request TEXT DEFAULT '',
  response_preview TEXT DEFAULT '',
  censored_note TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS gatekeeper_censors (
  pattern TEXT PRIMARY KEY,
  created_at REAL DEFAULT 0
);
"""


def get_conn() -> sqlite3.Connection:
    global _conn
    with _lock:
        if _conn is None:
            _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
            _conn.row_factory = sqlite3.Row
            _conn.executescript(SCHEMA)
            _conn.commit()
            _migrate_v03(_conn)
            _migrate_v04(_conn)
        return _conn


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    try:
        return {r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    except Exception:
        return set()


def _migrate_v03(conn: sqlite3.Connection) -> None:
    """v0.3: colonna profile + colonne engine su automations. Idempotente."""
    profile_tables = ("offices", "agents", "automations", "projects",
                      "missions", "tasks")
    for t in profile_tables:
        try:
            if "profile" not in _columns(conn, t):
                conn.execute(f"ALTER TABLE {t} ADD COLUMN profile TEXT DEFAULT 'default'")
        except Exception:
            pass
    engine_cols = {
        "script_path": "TEXT DEFAULT ''",
        "command": "TEXT DEFAULT ''",
        "schedule_kind": "TEXT DEFAULT ''",
        "schedule_expr": "TEXT DEFAULT ''",
        "last_run_output_path": "TEXT DEFAULT ''",
        "migration_note": "TEXT DEFAULT ''",
    }
    try:
        existing = _columns(conn, "automations")
        for col, ddl in engine_cols.items():
            if col not in existing:
                conn.execute(f"ALTER TABLE automations ADD COLUMN {col} {ddl}")
        conn.commit()
    except Exception:
        pass


def _migrate_v04(conn: sqlite3.Connection) -> None:
    """v0.4: kind uffici speciali, state+last_message_ts chat, preview+color task,
    tabelle gatekeeper. Idempotente, solo detection via codice (no agenti)."""
    try:
        if "kind" not in _columns(conn, "offices"):
            conn.execute("ALTER TABLE offices ADD COLUMN kind TEXT DEFAULT 'worker'")
        # normalizza eventuali NULL legacy
        conn.execute("UPDATE offices SET kind='worker' WHERE kind IS NULL OR kind=''")
    except Exception:
        pass
    try:
        ccols = _columns(conn, "chats")
        if "state" not in ccols:
            conn.execute("ALTER TABLE chats ADD COLUMN state TEXT DEFAULT 'open'")
        if "last_message_ts" not in ccols:
            conn.execute("ALTER TABLE chats ADD COLUMN last_message_ts REAL DEFAULT 0")
        conn.execute("UPDATE chats SET state='open' WHERE state IS NULL OR state=''")
    except Exception:
        pass
    try:
        tcols = _columns(conn, "tasks")
        if "preview" not in tcols:
            conn.execute("ALTER TABLE tasks ADD COLUMN preview TEXT DEFAULT ''")
        if "color" not in tcols:
            conn.execute("ALTER TABLE tasks ADD COLUMN color TEXT DEFAULT ''")
    except Exception:
        pass
    try:
        conn.execute("""CREATE TABLE IF NOT EXISTS gatekeeper_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL,
          requesting_office TEXT DEFAULT '', request TEXT DEFAULT '',
          response_preview TEXT DEFAULT '', censored_note TEXT DEFAULT '')""")
        conn.execute("""CREATE TABLE IF NOT EXISTS gatekeeper_censors (
          pattern TEXT PRIMARY KEY, created_at REAL DEFAULT 0)""")
        conn.commit()
    except Exception:
        pass
    # backfill last_message_ts dai messaggi (logico anche dopo open/close)
    try:
        for r in conn.execute("SELECT id FROM chats").fetchall():
            cid = r[0]
            mx = conn.execute("SELECT MAX(ts) FROM chat_messages WHERE chat_id=?",
                              (cid,)).fetchone()[0] or 0
            conn.execute("UPDATE chats SET last_message_ts=? WHERE id=?", (mx, cid))
        conn.commit()
    except Exception:
        pass


def query(sql: str, args: tuple = ()) -> list[dict]:
    with _lock:
        rows = get_conn().execute(sql, args).fetchall()
        return [dict(r) for r in rows]


def execute(sql: str, args: tuple = ()) -> int:
    with _lock:
        c = get_conn()
        cur = c.execute(sql, args)
        c.commit()
        return cur.rowcount


def jload(s, default="[]"):
    try:
        return json.loads(s)
    except (TypeError, ValueError):
        return json.loads(default)


def jdump(v) -> str:
    return json.dumps(v, ensure_ascii=False)


def now() -> float:
    return time.time()
