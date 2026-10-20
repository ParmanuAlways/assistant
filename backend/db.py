"""SQLite storage for the demo. Swap for PostgreSQL in the office (the SQL is plain)."""
import hashlib
import json
import os
import sqlite3
import threading
from datetime import datetime, timezone

DB_PATH = os.environ.get("AGENT_DB", os.path.join(os.path.dirname(__file__), "agent.db"))
_chain_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  emp_id TEXT PRIMARY KEY, username TEXT, name TEXT, email TEXT, roles TEXT, last_login TEXT);

CREATE TABLE IF NOT EXISTS user_profile (
  emp_id TEXT, field TEXT, value TEXT, source TEXT, updated_at TEXT, PRIMARY KEY (emp_id, field));

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY, emp_id TEXT, user_name TEXT, prompt TEXT, site TEXT, status TEXT,
  summary TEXT, model TEXT, model_url TEXT, client_ip TEXT, user_agent TEXT, steps INTEGER DEFAULT 0,
  started_at TEXT, ended_at TEXT);

-- Append-only, hash-chained audit trail: every user request, page seen, model decision,
-- action result, question, confirmation, screenshot and settings change.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, emp_id TEXT, seq INTEGER, event_type TEXT,
  url TEXT, payload TEXT, screenshot TEXT, created_at TEXT, prev_hash TEXT, hash TEXT);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;

CREATE TABLE IF NOT EXISTS model_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, base_url TEXT, model TEXT, api_key_enc TEXT,
  supports_vision INTEGER DEFAULT 0, is_default INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1, note TEXT);

CREATE TABLE IF NOT EXISTS user_settings (
  emp_id TEXT PRIMARY KEY, provider_id INTEGER, custom_url TEXT, custom_model TEXT, custom_key_enc TEXT,
  temperature REAL DEFAULT 0.2, updated_at TEXT);

CREATE TABLE IF NOT EXISTS admin_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1), allow_custom_endpoints INTEGER DEFAULT 0,
  allowed_model_hosts TEXT, allowed_sites TEXT, max_steps INTEGER DEFAULT 25);

CREATE TABLE IF NOT EXISTS site_playbooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, site TEXT, task TEXT, steps TEXT, updated_by TEXT, updated_at TEXT);

-- How successful tasks were done (labels and buttons only, no values): replayed for similar requests
CREATE TABLE IF NOT EXISTS experiences (
  id INTEGER PRIMARY KEY AUTOINCREMENT, site TEXT, goal TEXT, steps TEXT, task_id TEXT, successes INTEGER DEFAULT 1,
  failures INTEGER DEFAULT 0, created_at TEXT, last_used TEXT);

-- Each user's own shortcuts to the sites they use ("Your apps" on the home screen)
CREATE TABLE IF NOT EXISTS user_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT, emp_id TEXT, title TEXT, url TEXT, created_at TEXT);

-- One row per finished task, for playbook/workflow health
CREATE TABLE IF NOT EXISTS task_outcomes (
  task_id TEXT PRIMARY KEY, site TEXT, workflow TEXT, status TEXT, summary TEXT, drift INTEGER DEFAULT 0, ended_at TEXT);
"""


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class _ThreadLocalConnection:
    """One SQLite connection per worker thread (FastAPI runs sync endpoints in a thread pool)."""

    def __init__(self):
        self._local = threading.local()

    def _con(self):
        if not hasattr(self._local, "con"):
            c = sqlite3.connect(DB_PATH, timeout=30)
            c.row_factory = sqlite3.Row
            c.execute("PRAGMA journal_mode=WAL")
            self._local.con = c
        return self._local.con

    def __getattr__(self, name):
        return getattr(self._con(), name)


def connect():
    return _ThreadLocalConnection()


def init(default_model_url: str, default_model_name: str | None = None):
    con = connect()
    con.executescript(SCHEMA)
    for table, col, ddl in (("site_playbooks", "status", "TEXT DEFAULT 'active'"),
                            ("site_playbooks", "source", "TEXT DEFAULT 'seed'"),
                            ("model_providers", "json_mode", "TEXT DEFAULT 'auto'"),        # auto|schema|object|none
                            ("model_providers", "context_tokens", "INTEGER DEFAULT 8192"),
                            ("site_playbooks", "macro", "TEXT")):
        if col not in [r[1] for r in con.execute(f"PRAGMA table_info({table})")]:
            con.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")
    if not con.execute("SELECT 1 FROM admin_policy").fetchone():
        con.execute("INSERT INTO admin_policy VALUES (1, 0, ?, ?, 25)", (
            json.dumps(["*.office.local", "127.0.0.1", "localhost", "10.0.0.0/8"]),
            json.dumps(["*.office.local"])))
        con.execute("UPDATE admin_policy SET max_steps=40")
    if not con.execute("SELECT 1 FROM model_providers").fetchone():
        con.execute("""INSERT INTO model_providers (name, base_url, model, is_default, note)
            VALUES (?,?,?,1,?)""", (f"{default_model_name} (llama.cpp, CPU)" if default_model_name else
                                    "Test stand-in model (rule-based, not AI)", default_model_url,
                                    default_model_name or "stand-in-v1", "Default model for this run."))
        con.execute("""INSERT INTO model_providers (name, base_url, model, supports_vision, note)
            VALUES (?,?,?,1,?)""", ("Gemma 3 12B (Office GPU)", "http://gpu1.office.local:11434/v1", "gemma3:12b",
                                    "Example entry for your office Ollama server."))
    if not con.execute("SELECT 1 FROM site_playbooks").fetchone():
        con.execute("INSERT INTO site_playbooks (site, task, steps, updated_by, updated_at) VALUES (?,?,?,?,?)", (
            "hr.office.local", "Leave applications",
            "Start URL: http://hr.office.local:8200/  Apply Leave.", "seed", now()))
        for site, task, steps in [
            ("helpdesk.office.local", "IT support tickets", "Start URL: http://helpdesk.office.local:8300/  Raise a Ticket for IT problems."),
            ("expenses.office.local", "Expense reimbursement claims", "Start URL: http://expenses.office.local:8300/  New Claim, then review and submit."),
            ("rooms.office.local", "Meeting room booking", "Start URL: http://rooms.office.local:8300/  Find a Room, pick one from the results, book it."),
            ("visitors.office.local", "Visitor passes", "Start URL: http://visitors.office.local:8300/  Register Visitor."),
            ("canteen.office.local", "Canteen food orders", "Start URL: http://canteen.office.local:8300/  Order Food."),
            ("mail.office.local", "Email (webmail)", "Start URL: http://mail.office.local:8400/  Read, search, send, reply, forward and move emails."),
            ("legacy.office.local", "Legacy ERP: travel requests, purchase requests, PO approvals, timesheet upload, contact details",
             "Start URL: http://legacy.office.local:8500/  Has its own sign-in page. Menu on the left (Requests, Approvals, My Profile)."),
        ]:
            con.execute("INSERT INTO site_playbooks (site, task, steps, updated_by, updated_at) VALUES (?,?,?,?,?)",
                        (site, task, steps, "seed", now()))
    con.commit()
    return con


def _hash(prev: str, record: dict) -> str:
    return hashlib.sha256((prev + json.dumps(record, sort_keys=True)).encode()).hexdigest()


def log_event(con, emp_id, event_type, payload, task_id=None, url=None, screenshot=None):
    """Append one event to the global hash chain."""
    with _chain_lock:
        last = con.execute("SELECT hash FROM events ORDER BY id DESC LIMIT 1").fetchone()
        prev = last["hash"] if last else "GENESIS"
        seq = 0
        if task_id:
            seq = con.execute("SELECT COALESCE(MAX(seq),0)+1 FROM events WHERE task_id=?", (task_id,)).fetchone()[0]
        created = now()
        payload_json = json.dumps(payload, sort_keys=True, default=str)
        record = {"task_id": task_id, "emp_id": emp_id, "seq": seq, "type": event_type, "url": url,
                  "payload": payload_json, "screenshot": screenshot, "time": created}
        h = _hash(prev, record)
        con.execute("""INSERT INTO events (task_id, emp_id, seq, event_type, url, payload, screenshot, created_at,
            prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?)""",
                    (task_id, emp_id, seq, event_type, url, payload_json, screenshot, created, prev, h))
        con.commit()
        return seq


def verify_chain(con):
    prev = "GENESIS"
    count = 0
    for r in con.execute("SELECT * FROM events ORDER BY id"):
        record = {"task_id": r["task_id"], "emp_id": r["emp_id"], "seq": r["seq"], "type": r["event_type"],
                  "url": r["url"], "payload": r["payload"], "screenshot": r["screenshot"], "time": r["created_at"]}
        if r["prev_hash"] != prev or _hash(prev, record) != r["hash"]:
            return {"ok": False, "checked": count, "broken_at_event_id": r["id"], "task_id": r["task_id"],
                    "seq": r["seq"], "event_type": r["event_type"]}
        prev = r["hash"]
        count += 1
    return {"ok": True, "checked": count}
