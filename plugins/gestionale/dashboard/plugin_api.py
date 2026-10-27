"""Gestionale Hermes — dashboard plugin backend, mounted at /api/plugins/gestionale/.

Thin wrappers over the shared SQLite state in /opt/data/output/gestionale/backend/
(``state.py`` — same DB file the standalone prototype uses, so data is shared).
Demo seed is idempotent (INSERT OR REPLACE / count guards, copied from
``demo_feed.py``); NO background animation thread here — agent ``activity`` is
computed deterministically from ``time.time()`` at fetch time.
"""

from __future__ import annotations

import json
import logging
import math
import os
import sys
import threading
import time
import uuid
import zlib
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

sys.path.insert(0, "/opt/data/output/gestionale/backend")

import state  # noqa: E402
import demo_feed as _demo  # noqa: E402  (constants + idempotent seed only)
import engine as _engine  # noqa: E402  (automation engine: schedule + run)

log = logging.getLogger(__name__)

router = APIRouter()

# Automation Engine: thread daemon solo nel processo del web server
# (guardia dentro maybe_start: non parte mai con GESTIONALE_ENGINE=0
# né dallo standalone server.py:8790).
try:
    _engine_started = _engine.maybe_start()
except Exception as exc:  # mai rompere l'import del plugin
    log.warning("gestionale engine not started: %s", exc)
    _engine_started = False

_seed_lock = threading.Lock()


def _ensure_seed() -> None:
    """Idempotent demo seed (offices/automations/projects/missions/tasks always;
    agents+chats only when the agents table is empty)."""
    with _seed_lock:
        try:
            _demo.seed()
        except Exception as exc:
            log.warning("gestionale seed failed: %s", exc)
            return
        try:
            if state.query("SELECT COUNT(*) c FROM agents")[0]["c"] == 0:
                _demo.seed_agents()
        except Exception as exc:
            log.warning("gestionale seed_agents failed: %s", exc)


def _db():
    _ensure_seed()
    return state


# --- Agents activity (deterministic, no animation thread) --------------------

_ACTIVITY_POOL = [
    "thinking: comparing 3 sources…",
    "output: writing chapter 2 draft",
    "thinking: checking gateway latency…",
    "output: updating slide deck layout",
    "thinking: reviewing test failures…",
    "output: pushing commit with fixes",
    "thinking: searching docs for API limits…",
    "output: summarizing chat highlights",
]


def _activity_for(agent_id: str, now: float) -> str:
    slot = int(now // 8) + zlib.crc32(agent_id.encode())
    return _ACTIVITY_POOL[slot % len(_ACTIVITY_POOL)]


# --- Profiles (profili Hermes reali da filesystem) --------------------------

@router.get("/profiles")
def profiles():
    _db()
    return {"profiles": _engine.list_profiles()}


def _profile_filter(profile: str | None) -> tuple[str, tuple]:
    if profile:
        return " WHERE profile=?", (profile,)
    return "", ()


# --- Offices / agents / chats / automations ----------------------------------

CHAT_ACTIVE_WINDOW_S = 5 * 60
BORDO_FLASH_WINDOW_S = 10

_TASK_PALETTE = ["#7aa2f7", "#89b4fa", "#8aadf4", "#7dcfff", "#6d9dff", "#a5b4fc"]


def _task_preview_for(t: dict) -> str:
    if (t.get("preview") or "").strip():
        return t["preview"]
    desc = (t.get("description") or "").strip()
    base = desc if desc else (t.get("title") or "")
    pv = base[:140]
    return pv + ("…" if len(base) > 140 else "")


def _task_color_for(t: dict) -> str:
    if (t.get("color") or "").strip():
        return t["color"]
    key = (t.get("project_id") or "") + "|" + (t.get("id") or "")
    return _TASK_PALETTE[zlib.crc32(key.encode()) % len(_TASK_PALETTE)]


def _offices_enriched(profile: str | None):
    """Arricchisce uffici via codice al fetch: kind, agents, active_task_ids,
    chat_active (chat aperta inter-ufficio con msg ultimi 5min),
    bordo_flash (msg chat interna ultimi 10s). Nessun thread."""
    st = _db()
    where, args = _profile_filter(profile)
    offices = st.query(f"SELECT * FROM offices{where} ORDER BY kind, id", args)
    now = time.time()
    agents_all = st.query("SELECT * FROM agents" + where + " ORDER BY started_at DESC", args)
    agent_office_all = {a["id"]: a["office_id"]
                        for a in st.query("SELECT id, office_id FROM agents")}
    # tasks attivi (non done/cancelled), filtro profilo coerente
    if profile:
        active_tasks = st.query(
            "SELECT id, assignee_agent_id, assignee_office_id FROM tasks"
            " WHERE profile=? AND status NOT IN ('done','cancelled')", (profile,))
    else:
        active_tasks = st.query(
            "SELECT id, assignee_agent_id, assignee_office_id FROM tasks"
            " WHERE status NOT IN ('done','cancelled')")
    chat_rows = st.query("SELECT * FROM chats")
    chat_parts: dict[str, list] = {}
    chat_state: dict[str, str] = {}
    chat_last: dict[str, float] = {}
    for c in chat_rows:
        try:
            parts = st.jload(c.get("participants"))
        except Exception:
            parts = []
        chat_parts[c["id"]] = parts if isinstance(parts, list) else []
        chat_state[c["id"]] = c.get("state") or "open"
        chat_last[c["id"]] = c.get("last_message_ts") or 0
    # messaggi recenti: una sola query per finestra
    recent: dict[str, float] = {}
    for r in st.query("SELECT chat_id, MAX(ts) m FROM chat_messages WHERE ts > ? GROUP BY chat_id",
                      (now - CHAT_ACTIVE_WINDOW_S,)):
        recent[r["chat_id"]] = r["m"] or 0
    # sincronizza last_message_ts in memoria se colonna a 0 (logico)
    for cid, mx in recent.items():
        if not chat_last.get(cid):
            chat_last[cid] = mx
    flash: dict[str, float] = {}
    for r in st.query("SELECT chat_id, MAX(ts) m FROM chat_messages WHERE ts > ? GROUP BY chat_id",
                      (now - BORDO_FLASH_WINDOW_S,)):
        flash[r["chat_id"]] = r["m"] or 0
    agents_by_office: dict[str, list] = {}
    for a in agents_all:
        agents_by_office.setdefault(a["office_id"], []).append(a)
    out = []
    for o in offices:
        oid = o["id"]
        o_agents = agents_by_office.get(oid, [])
        o_agent_ids = {a["id"] for a in o_agents}
        o["allowed_toolsets"] = st.jload(o.get("allowed_toolsets"))
        o.setdefault("kind", "worker")
        agents_lite = [{"id": a["id"], "name": a["name"], "model": a.get("model", ""),
                        "activity": _activity_for(a["id"], now),
                        "state": a.get("state", "")} for a in o_agents]
        tids = [t["id"] for t in active_tasks
                if t.get("assignee_office_id") == oid or t.get("assignee_agent_id") in o_agent_ids]
        # chat_active: chat aperta che collega questo ufficio a un altro + msg 5min
        chat_active = False
        bordo_flash = False
        for cid, parts in chat_parts.items():
            if chat_state.get(cid) != "open":
                continue
            offices_set = {agent_office_all.get(p) for p in parts}
            offices_set.discard(None)
            if oid not in offices_set:
                continue
            if len(offices_set) >= 2 and recent.get(cid):
                chat_active = True
            if offices_set == {oid} and flash.get(cid):
                bordo_flash = True
        out.append({**o, "agents": agents_lite, "active_task_ids": tids,
                    "chat_active": chat_active, "bordo_flash": bordo_flash})
    return out


@router.get("/offices")
def offices(profile: str | None = None):
    return {"offices": _offices_enriched(profile)}


@router.get("/offices/{office_id}/detail")
def office_detail(office_id: str):
    st = _db()
    rows = st.query("SELECT * FROM offices WHERE id=?", (office_id,))
    if not rows:
        raise HTTPException(status_code=404, detail="office not found")
    o = rows[0]
    o["allowed_toolsets"] = st.jload(o.get("allowed_toolsets"))
    now = time.time()
    agents = st.query("SELECT * FROM agents WHERE office_id=? ORDER BY started_at DESC", (office_id,))
    for a in agents:
        a["toolsets"] = st.jload(a.get("toolsets"))
        a["activity"] = _activity_for(a["id"], now)
    agent_ids = {a["id"] for a in agents}
    tasks = st.query("SELECT * FROM tasks WHERE assignee_office_id=? OR assignee_agent_id IN"
                     " (SELECT id FROM agents WHERE office_id=?) ORDER BY created_at",
                     (office_id, office_id))
    tasks_out = []
    for t in tasks:
        t["preview"] = _task_preview_for(t)
        t["color"] = _task_color_for(t)
        kids = st.query("SELECT COUNT(*) c FROM tasks WHERE parent_id=?", (t["id"],))[0]["c"]
        t["children_count"] = kids
        tasks_out.append(t)
    # chat interna (tutti i partecipanti dello stesso ufficio) + collegate
    agent_office = {a["id"]: a["office_id"]
                    for a in st.query("SELECT id, office_id FROM agents")}
    internal = None
    linked = []
    chat_rows = st.query("SELECT * FROM chats")
    best_internal_ts = -1.0
    for c in chat_rows:
        parts = st.jload(c.get("participants"))
        offices_set = {agent_office.get(p) for p in parts if agent_office.get(p)}
        if office_id not in offices_set and not (not offices_set and any(
                a in agent_ids for a in parts)):
            continue
        msgs = st.query("SELECT * FROM chat_messages WHERE chat_id=? ORDER BY ts DESC LIMIT 20",
                        (c["id"],))
        msgs = list(reversed(msgs))
        for m in msgs:
            m["to_agent_ids"] = st.jload(m.get("to_agent_ids"))
        mx = msgs[-1]["ts"] if msgs else 0
        entry = {**c, "participants": parts, "messages": msgs,
                 "last_message_ts": c.get("last_message_ts") or mx}
        if offices_set == {office_id} or (not offices_set - {office_id} and offices_set):
            if mx >= best_internal_ts:
                best_internal_ts = mx
                internal = entry
        else:
            linked.append(entry)
    # se nessuna interna ma l'ufficio ha agenti, esponi comunque None (frontend friendly)
    return {"office": o, "agents": agents, "tasks": tasks_out,
            "internal_chat": internal, "linked_chats": linked}


@router.get("/agents")
def agents(profile: str | None = None):
    st = _db()
    where, args = _profile_filter(profile)
    rows = st.query(
        "SELECT * FROM agents" + where + " ORDER BY started_at DESC", args)
    now = time.time()
    for r in rows:
        r["toolsets"] = st.jload(r["toolsets"])
        r["activity"] = _activity_for(r["id"], now)
    return {"agents": rows}


@router.get("/chats")
def chats():
    st = _db()
    chat_rows = st.query("SELECT * FROM chats")
    out = []
    for c in chat_rows:
        msgs = st.query("SELECT * FROM chat_messages WHERE chat_id=? ORDER BY ts", (c["id"],))
        for m in msgs:
            m["to_agent_ids"] = st.jload(m["to_agent_ids"])
        mx = msgs[-1]["ts"] if msgs else 0
        last_ts = c.get("last_message_ts") or mx
        if not c.get("last_message_ts") and mx:
            try:
                st.execute("UPDATE chats SET last_message_ts=? WHERE id=?", (mx, c["id"]))
            except Exception:
                pass
        out.append({**c, "state": c.get("state") or "open",
                    "last_message_ts": last_ts,
                    "participants": st.jload(c["participants"]), "messages": msgs})
    return {"chats": out}


@router.post("/chats/{chat_id}/close")
def chat_close(chat_id: str):
    st = _db()
    rows = st.query("SELECT * FROM chats WHERE id=?", (chat_id,))
    if not rows:
        raise HTTPException(status_code=404, detail="chat not found")
    mx = st.query("SELECT MAX(ts) m FROM chat_messages WHERE chat_id=?", (chat_id,))[0]["m"] or 0
    st.execute("UPDATE chats SET state='closed', last_message_ts=? WHERE id=?", (mx, chat_id))
    return {"id": chat_id, "state": "closed", "last_message_ts": mx}


@router.post("/chats/{chat_id}/open")
def chat_open(chat_id: str):
    st = _db()
    rows = st.query("SELECT * FROM chats WHERE id=?", (chat_id,))
    if not rows:
        raise HTTPException(status_code=404, detail="chat not found")
    mx = st.query("SELECT MAX(ts) m FROM chat_messages WHERE chat_id=?", (chat_id,))[0]["m"] or 0
    st.execute("UPDATE chats SET state='open', last_message_ts=? WHERE id=?", (mx, chat_id))
    return {"id": chat_id, "state": "open", "last_message_ts": mx}


@router.get("/automations")
def automations(profile: str | None = None):
    st = _db()
    where, args = _profile_filter(profile)
    rows = st.query("SELECT * FROM automations" + where, args)
    now = time.time()
    for r in rows:  # next_run_at calcolato, mai persistito qui
        try:
            r["next_run_at"] = _engine.next_run_at(r, now)
        except Exception:
            r["next_run_at"] = r.get("next_run")
    return {"automations": rows}


@router.get("/automations/{automation_id}/toggle")
@router.post("/automations/{automation_id}/toggle")
def automation_toggle(automation_id: str, enabled: bool = Query(...)):
    st = _db()
    st.execute("UPDATE automations SET enabled=? WHERE id=?", (int(enabled), automation_id))
    row = st.query("SELECT * FROM automations WHERE id=?", (automation_id,))
    if not row:
        raise HTTPException(status_code=404, detail="automation not found")
    return {"id": automation_id, "enabled": bool(enabled)}


@router.get("/files")
def files(path: str = "/opt/data/output"):
    p = Path(path).resolve()
    if not p.exists():
        return JSONResponse({"error": "not found", "path": str(p)}, status_code=404)
    entries = []
    try:
        for e in sorted(p.iterdir(), key=lambda x: x.name)[:200]:
            entries.append({"name": e.name, "type": "dir" if e.is_dir() else "file",
                            "size": e.stat().st_size if e.is_file() else 0,
                            "mtime": e.stat().st_mtime})
    except PermissionError:
        pass
    return {"path": str(p), "entries": entries}


@router.get("/projects")
def projects(profile: str | None = None):
    st = _db()
    where, args = _profile_filter(profile)
    prows = st.query("SELECT * FROM projects" + where, args)
    if profile:
        mrows = st.query("SELECT * FROM missions WHERE profile=?", (profile,))
    else:
        mrows = st.query("SELECT * FROM missions")
    for m in mrows:
        m["agent_ids"] = st.jload(m["agent_ids"])
    for pr in prows:
        pr["missions"] = [m for m in mrows if m["project_id"] == pr["id"]]
    return {"projects": prows}


# --- Graph: offices (nodes) + recent message exchanges (edges) ----------------

GRAPH_WINDOW_S = 15 * 60


@router.get("/graph")
def graph():
    st = _db()
    offices = st.query("SELECT id, name, color FROM offices")
    nodes = []
    n = max(len(offices), 1)
    for i, o in enumerate(offices):
        angle = 2 * 3.141592653589793 * i / n
        nodes.append({"id": o["id"], "label": o["name"], "color": o["color"],
                      "x": round(200 * math.cos(angle), 2),
                      "y": round(200 * math.sin(angle), 2),
                      "vx": 0.0, "vy": 0.0})
    agent_office = {a["id"]: a["office_id"]
                    for a in st.query("SELECT id, office_id FROM agents")}
    chat_parts = {c["id"]: st.jload(c["participants"])
                  for c in st.query("SELECT id, participants FROM chats")}
    since = time.time() - GRAPH_WINDOW_S
    pair_count: dict[tuple[str, str], int] = {}
    pair_last: dict[tuple[str, str], float] = {}
    for m in st.query("SELECT chat_id, from_agent_id, to_agent_ids, ts FROM chat_messages WHERE ts > ?", (since,)):
        src = agent_office.get(m["from_agent_id"])
        if not src:
            continue
        targets = st.jload(m["to_agent_ids"])
        if targets:
            dsts = {agent_office.get(t) for t in targets if agent_office.get(t)}
        else:
            dsts = {agent_office.get(p) for p in chat_parts.get(m["chat_id"], [])
                    if agent_office.get(p)}
        dsts.discard(src)
        dsts.discard(None)
        for dst in dsts:
            key = tuple(sorted((src, dst)))
            pair_count[key] = pair_count.get(key, 0) + 1
            pair_last[key] = max(pair_last.get(key, 0.0), m["ts"])
    links = [{"source_office": a, "target_office": b, "weight": c,
              "message_count": c, "last_ts": pair_last[(a, b)]}
             for (a, b), c in sorted(pair_count.items())]
    return {"nodes": nodes, "links": links}


# --- Automation detail (Italian composition) ----------------------------------

_CRON_JOBS_CACHE: list[dict] | None = None


def _cron_jobs() -> list[dict]:
    global _CRON_JOBS_CACHE
    if _CRON_JOBS_CACHE is None:
        home = os.environ.get("HERMES_HOME") or str(Path.home())
        jobs_file = Path(home) / "cron" / "jobs.json"
        try:
            _CRON_JOBS_CACHE = json.loads(jobs_file.read_text()).get("jobs", [])
        except (OSError, ValueError):
            _CRON_JOBS_CACHE = []
    return _CRON_JOBS_CACHE


_SCRIPT_DIRS = ["scripts", "cron"]


def _resolve_script(script_name: str) -> str | None:
    home = os.environ.get("HERMES_HOME") or str(Path.home())
    candidates = [Path(home) / d / script_name for d in _SCRIPT_DIRS]
    candidates += [Path("/opt/data/scripts") / script_name,
                   Path("/opt/data/infra/opencode-go") / script_name,
                   Path("/opt/hermes/cron") / script_name]
    for p in candidates:
        if p.is_file():
            return str(p.resolve())
    return None


@router.get("/automations/{automation_id}/detail")
def automation_detail(automation_id: str):
    st = _db()
    rows = st.query("SELECT * FROM automations WHERE id=?", (automation_id,))
    if not rows:
        raise HTTPException(status_code=404, detail="automation not found")
    a = rows[0]
    home = os.environ.get("HERMES_HOME") or str(Path.home())
    job = next((j for j in _cron_jobs() if j.get("name") == a["name"]), None)
    script = (job or {}).get("script") if job else None
    if script:
        real = _resolve_script(script)
        if real:
            steps = [{"kind": "script", "path_or_name": real,
                      "description": "script eseguito dal cron di sistema"}]
            files = [real]
        else:
            guess = str(Path(home) / "cron" / script)
            steps = [{"kind": "script", "path_or_name": guess,
                      "description": "definito dal cron di sistema"}]
            files = [guess]
        ctype = "single"
    elif job:
        skill = job.get("skill") or (job.get("skills") or [None])[0] or a["name"]
        steps = [{"kind": "agent", "path_or_name": skill,
                  "description": "definito dal cron di sistema"}]
        files = []
        ctype = "single"
    else:
        guess = str(Path(home) / "cron" / a["id"])
        outdir = Path("/opt/data/output") / a["id"].removeprefix("cron-")
        if a["id"] == "cron-lezioni" and Path("/opt/data/output/lezioni").is_dir():
            guess = "/opt/data/output/lezioni"
        elif outdir.is_dir():
            guess = str(outdir)
        steps = [{"kind": "cron", "path_or_name": guess,
                  "description": "definito dal cron di sistema"}]
        files = [guess]
        ctype = "single"
    stato = "attiva" if a["enabled"] else "in pausa"
    esito = a.get("last_run_status") or "mai eseguita"
    summary = (f"L'automazione '{a['name']}' ({a['source']}) si attiva "
               f"con schedulazione '{a['schedule_raw']}', è {stato} "
               f"e l'ultima esecuzione risulta: {esito}.")
    out = {"id": a["id"], "name": a["name"], "source": a["source"],
           "trigger": a["trigger"], "schedule_raw": a["schedule_raw"],
           "enabled": bool(a["enabled"]),
           "composition": {"type": ctype, "steps": steps, "files": files},
           "summary_italian": summary}
    # Campi engine quando presenti (unica fonte: tabella automations)
    if a.get("command") or a.get("script_path"):
        try:
            out["next_run_at"] = _engine.next_run_at(a)
        except Exception:
            out["next_run_at"] = a.get("next_run")
        out.update({
            "schedule_kind": a.get("schedule_kind", ""),
            "schedule_expr": a.get("schedule_expr", ""),
            "script_path": a.get("script_path", ""),
            "command": a.get("command", ""),
            "last_run_at": a.get("last_run_ts"),
            "last_run_status": a.get("last_run_status", ""),
            "last_run_output_path": a.get("last_run_output_path", ""),
            "migration_note": a.get("migration_note", ""),
            "profile": a.get("profile", "default"),
        })
        if a.get("command"):
            out["composition"] = {
                "type": "single",
                "steps": [{"kind": "script",
                           "path_or_name": a.get("script_path") or a["command"],
                           "description": "eseguito dall'Automation Engine (subprocess con timeout)"}],
                "files": [a["script_path"]] if a.get("script_path") else [],
            }
    return out


@router.post("/automations/{automation_id}/run-now")
def automation_run_now(automation_id: str):
    """Esecuzione immediata ad hoc di un'automazione engine."""
    st = _db()
    if not st.query("SELECT id FROM automations WHERE id=?", (automation_id,)):
        raise HTTPException(status_code=404, detail="automation not found")
    try:
        return _engine.run_job(automation_id)
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/automations/{automation_id}/logs")
def automation_logs(automation_id: str, tail: int = 60):
    """Ultimo output dell'automazione (file in engine-logs/)."""
    _db()
    try:
        return _engine.read_log_tail(automation_id, tail=tail)
    except KeyError:
        raise HTTPException(status_code=404, detail="automation not found")


# --- Tasks (paperclip-style board) --------------------------------------------

TASK_STATUSES = {"backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"}


def _task_row(tid: str) -> dict | None:
    rows = state.query("SELECT * FROM tasks WHERE id=?", (tid,))
    return rows[0] if rows else None


def _task_enrich(t: dict) -> dict:
    kids = state.query("SELECT COUNT(*) c FROM tasks WHERE parent_id=?", (t["id"],))[0]["c"]
    last = state.query("SELECT author, author_kind, text, ts FROM task_comments "
                       "WHERE task_id=? ORDER BY ts DESC LIMIT 1", (t["id"],))
    ncom = state.query("SELECT COUNT(*) c FROM task_comments WHERE task_id=?", (t["id"],))[0]["c"]
    return {**t, "preview": _task_preview_for(t), "color": _task_color_for(t),
            "children_count": kids, "comments_count": ncom,
            "last_comment": last[0] if last else None}


@router.get("/tasks")
def tasks_list(profile: str | None = None):
    _db()
    where, args = _profile_filter(profile)
    rows = state.query("SELECT * FROM tasks" + where + " ORDER BY created_at", args)
    return {"tasks": [_task_enrich(t) for t in rows]}


@router.get("/tasks/{task_id}")
def task_get(task_id: str):
    _db()
    t = _task_row(task_id)
    if not t:
        raise HTTPException(status_code=404, detail="task not found")
    comments = state.query("SELECT id, author, author_kind, text, ts FROM task_comments "
                           "WHERE task_id=? ORDER BY ts", (task_id,))
    return {**_task_enrich(t), "comments": comments}


@router.post("/tasks")
def task_create(payload: dict):
    _db()
    title = (payload.get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="title required")
    status = payload.get("status", "todo")
    if status not in TASK_STATUSES:
        raise HTTPException(status_code=400, detail=f"bad status: {status}")
    parent = payload.get("parent_id") or ""
    if parent and not _task_row(parent):
        raise HTTPException(status_code=400, detail="parent not found")
    now = time.time()
    tid = payload.get("id") or f"t-{uuid.uuid4().hex[:8]}"
    profile = (payload.get("profile") or "default").strip() or "default"
    preview = (payload.get("preview") or "").strip() or _task_preview_for(
        {"id": tid, "title": title, "description": payload.get("description", ""),
         "project_id": payload.get("project_id", ""), "preview": ""})
    color = (payload.get("color") or "").strip() or _task_color_for(
        {"id": tid, "project_id": payload.get("project_id", ""), "color": ""})
    state.execute("INSERT INTO tasks (id,title,description,status,parent_id,assignee_agent_id,"
                  "assignee_office_id,priority,project_id,created_at,updated_at,profile,preview,color)"
                  " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                  (tid, title, payload.get("description", ""), status, parent,
                   payload.get("assignee_agent_id", ""), payload.get("assignee_office_id", ""),
                   payload.get("priority", "p2"), payload.get("project_id", ""), now, now, profile,
                   preview, color))
    return _task_enrich(_task_row(tid))


@router.post("/tasks/{task_id}/comment")
def task_comment(task_id: str, payload: dict):
    _db()
    t = _task_row(task_id)
    if not t:
        raise HTTPException(status_code=404, detail="task not found")
    text = (payload.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text required")
    kind = payload.get("author_kind", "agent")
    if kind not in ("agent", "user"):
        kind = "agent"
    now = time.time()
    state.execute("INSERT INTO task_comments (task_id,author,author_kind,text,ts)"
                  " VALUES (?,?,?,?,?)",
                  (task_id, payload.get("author", ""), kind, text, now))
    state.execute("UPDATE tasks SET updated_at=? WHERE id=?", (now, task_id))
    row = state.query("SELECT id, author, author_kind, text, ts FROM task_comments "
                      "WHERE task_id=? ORDER BY id DESC LIMIT 1", (task_id,))[0]
    return row


# --- Orchestratore (aggregato via SQL, nessun agente) ---------------------------

@router.get("/orchestrator")
def orchestrator(profile: str = "default"):
    st = _db()
    orch = st.query("SELECT * FROM offices WHERE profile=? AND kind='orchestrator' LIMIT 1",
                    (profile,))
    if not orch:
        # fallback: ufficio orchestratore senza filtro profilo (DB legacy)
        orch = st.query("SELECT * FROM offices WHERE kind='orchestrator' LIMIT 1")
    if not orch:
        raise HTTPException(status_code=404, detail="orchestrator office not found")
    o = orch[0]
    goal = o.get("role_instructions") or f"Coordina gli uffici del profilo {profile}."
    projects = st.query("SELECT * FROM projects WHERE profile=?", (profile,))
    proj_out = []
    for p in projects:
        pid = p["id"]
        tot = st.query("SELECT COUNT(*) c FROM tasks WHERE project_id=?", (pid,))[0]["c"]
        done = st.query("SELECT COUNT(*) c FROM tasks WHERE project_id=? AND status='done'",
                        (pid,))[0]["c"]
        by_status = {r["status"]: r["c"] for r in st.query(
            "SELECT status, COUNT(*) c FROM tasks WHERE project_id=? GROUP BY status", (pid,))}
        roots = st.query("SELECT COUNT(*) c FROM tasks WHERE project_id=? AND (parent_id='' OR parent_id IS NULL)",
                         (pid,))[0]["c"]
        subtasks = tot - roots
        times = st.query("SELECT MIN(created_at) cmin, MAX(updated_at) umax FROM tasks WHERE project_id=?",
                         (pid,))[0]
        proj_out.append({"id": pid, "name": p["name"], "description": p.get("description", ""),
                         "progress": p.get("progress", 0),
                         "total": tot, "done": done, "open": tot - done,
                         "by_status": by_status, "roots": roots, "subtasks": subtasks,
                         "created_min": times["cmin"], "updated_max": times["umax"]})
    active = max(proj_out, key=lambda x: (x["open"], -x["done"]), default=None)
    agents_per_office = {}
    for r in st.query("SELECT office_id, COUNT(*) total, "
                      "SUM(CASE WHEN state='RUNNING' THEN 1 ELSE 0 END) running "
                      "FROM agents WHERE profile=? OR office_id IN "
                      "(SELECT id FROM offices WHERE profile=?) GROUP BY office_id", (profile, profile)):
        agents_per_office[r["office_id"]] = {"total": r["total"], "running": r["running"] or 0}
    # tempistiche globali profilo
    tglob = st.query("SELECT MIN(created_at) cmin, MAX(updated_at) umax FROM tasks WHERE profile=?",
                     (profile,))[0] if st.query("SELECT COUNT(*) c FROM tasks WHERE profile=?", (profile,))[0]["c"] else {"cmin": None, "umax": None}
    return {"profile": profile, "orchestrator_office_id": o["id"], "goal": goal,
            "projects": proj_out, "active_project": active,
            "agents_per_office": agents_per_office,
            "tempistiche": {"earliest_task": tglob["cmin"], "latest_update": tglob["umax"]}}


# --- Gatekeeper (log richieste + censure, solo codice) ---------------------------

def _gatekeeper_state() -> dict:
    st = _db()
    log_rows = st.query("SELECT * FROM gatekeeper_log ORDER BY ts DESC LIMIT 100")
    censors = [r["pattern"] for r in st.query("SELECT pattern FROM gatekeeper_censors ORDER BY pattern")]
    keepers = st.query("SELECT * FROM offices WHERE kind='gatekeeper'")
    for k in keepers:
        k["allowed_toolsets"] = st.jload(k.get("allowed_toolsets"))
    return {"log": log_rows, "censors": censors, "knowledge_keepers": keepers}


@router.get("/gatekeeper/state")
def gatekeeper_state():
    return _gatekeeper_state()


@router.get("/gatekeeper/stato")
def gatekeeper_stato():
    # alias italiano
    return _gatekeeper_state()


@router.post("/gatekeeper/censor")
def gatekeeper_censor(payload: dict):
    st = _db()
    pats = payload.get("patterns", payload.get("censors", []))
    if isinstance(payload.get("pattern"), str):
        pats = pats + [payload["pattern"]] if isinstance(pats, list) else [payload["pattern"]]
    if isinstance(pats, str):
        pats = [pats]
    pats = [str(p).strip() for p in (pats or []) if str(p).strip()]
    if not pats and not isinstance(payload.get("patterns"), list):
        raise HTTPException(status_code=400, detail="patterns required (lista di pattern)")
    now = time.time()
    st.execute("DELETE FROM gatekeeper_censors")
    for p in sorted(set(pats)):
        st.execute("INSERT OR IGNORE INTO gatekeeper_censors (pattern, created_at) VALUES (?,?)", (p, now))
    return {"censors": sorted(set(pats))}


@router.post("/gatekeeper/log")
def gatekeeper_log(payload: dict):
    """Registra una richiesta dati al knowledge-keeper (detection via codice)."""
    st = _db()
    now = time.time()
    st.execute("INSERT INTO gatekeeper_log (ts, requesting_office, request, response_preview, censored_note)"
               " VALUES (?,?,?,?,?)",
               (now, payload.get("requesting_office", ""), payload.get("request", ""),
                payload.get("response_preview", ""), payload.get("censored_note", "")))
    row = st.query("SELECT * FROM gatekeeper_log ORDER BY id DESC LIMIT 1")[0]
    return row
