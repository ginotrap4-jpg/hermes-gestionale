"""Gestionale Hermes — Automation Engine v0.3.

Esegue automazioni deterministiche (script shell/python, no agent) migrate
dai cron jobs di Hermes. Una sola tabella `automations` fa da unica fonte.

- Thread daemon avviato SOLO nel processo del web server (guardia in
  maybe_start: env GESTIONALE_ENGINE=1, oppure argv con uvicorn/hermes/web;
  mai se GESTIONALE_ENGINE=0).
- Loop ogni 30s: cerca automazioni engine dovute (enabled=1, source='engine',
  comando o script presenti, next_run superato o mai eseguite con schedule),
  le esegue in subprocess con timeout, scrive stdout/stderr in
  /opt/data/output/gestionale/engine-logs/<jobid>/<ts>.log e aggiorna
  last_run_ts / last_run_status / last_run_duration_ms / last_run_output_path.
- Resistente al restart: scadenze calcolate da last_run_ts persistito in db.
"""
from __future__ import annotations

import calendar
import json
import os
import re
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import state

LOG_DIR = Path("/opt/data/output/gestionale/engine-logs")
PROFILES_DIR = Path("/opt/data/profiles")
HERMES_HOME = Path(os.environ.get("HERMES_HOME", "/opt/data"))
HERMES_BIN = "/opt/hermes/.venv/bin/hermes"

INTERVAL_RE = re.compile(r"every\s+(\d+)\s*([mhd])", re.IGNORECASE)
RUN_TIMEOUT_S = 180
LOOP_S = 30

# Cron Hermes MIGRABILI (deterministici: script no_agent) -> automazioni engine.
# Agent-driven (es. infra-audit-settimanale) e cron di profilo (cron-lezioni)
# restano nei cron Hermes e NON vengono migrati.
MIGRATED_JOBS: list[dict] = [
    {
        "id": "cron-watchdog",
        "name": "watchdog/go-proxy",
        "cron_name": "watchdog/go-proxy",
        "profile": "default",
        "script_path": "/opt/data/scripts/go_proxy_watchdog.sh",
        "command": "bash /opt/data/scripts/go_proxy_watchdog.sh",
        "schedule_kind": "cron",
        "schedule_expr": "*/5 * * * *",
        "schedule_raw": "*/5 * * * *",
        "office_id": "operations",
    },
    {
        "id": "cron-muse-bridge",
        "name": "muse-bridge-watchdog",
        "cron_name": "muse-bridge-watchdog",
        "profile": "default",
        "script_path": "/opt/data/scripts/bridge_watchdog.py",
        "command": "python3 /opt/data/scripts/bridge_watchdog.py",
        "schedule_kind": "interval",
        "schedule_expr": "every 15m",
        "schedule_raw": "every 15m",
        "office_id": "operations",
    },
    {
        "id": "cron-gomodel",
        "name": "gomodel-monitor",
        "cron_name": "gomodel-monitor",
        "profile": "default",
        "script_path": "/opt/data/scripts/gomodel_monitor.py",
        "command": "python3 /opt/data/scripts/gomodel_monitor.py",
        "schedule_kind": "interval",
        "schedule_expr": "every 180m",
        "schedule_raw": "every 180m",
        "office_id": "operations",
    },
    {
        "id": "cron-security",
        "name": "verifica-sicurezza-mensile",
        "cron_name": "verifica-sicurezza-mensile",
        "profile": "default",
        "script_path": "/opt/data/scripts/security_check.py",
        "command": "python3 /opt/data/scripts/security_check.py",
        "schedule_kind": "cron",
        "schedule_expr": "0 9 1 * *",
        "schedule_raw": "0 9 1 * *",
        "office_id": "operations",
    },
]


def list_profiles() -> list[str]:
    """Profili Hermes reali: directory in /opt/data/profiles/* + 'default'."""
    names = ["default"]
    try:
        for p in sorted(PROFILES_DIR.iterdir()):
            if p.is_dir() and not p.name.startswith("."):
                names.append(p.name)
    except OSError:
        pass
    return names


# --- scheduling ------------------------------------------------------------

def _interval_seconds(expr: str) -> float | None:
    m = INTERVAL_RE.search(expr or "")
    if not m:
        return None
    n, unit = int(m.group(1)), m.group(2).lower()
    return n * {"m": 60, "h": 3600, "d": 86400}[unit]


def _cron_next(expr: str, after: float) -> float | None:
    """Prossimo match di un'espressione cron a 5 campi (min hour dom mon dow)."""
    try:
        fields = expr.split()
        if len(fields) != 5:
            return None
        mins, hours, doms, mons, dows = (_parse_field(f, lo, hi) for f, (lo, hi) in
                                         zip(fields, [(0, 59), (0, 23), (1, 31), (1, 12), (0, 6)]))
        t = int(after) // 60 * 60 + 60
        for _ in range(366 * 24 * 60):  # max 1 anno di minuti
            dt = datetime.fromtimestamp(t, tz=timezone.utc)
            dow = (dt.weekday() + 1) % 7  # cron: 0=domenica
            if (dt.minute in mins and dt.hour in hours and dt.day in doms
                    and dt.month in mons and dow in dows):
                return float(t)
            # salta in avanti di 1h quando il minuto non conta
            t += 60 if len(mins) < 60 else 3600
        return None
    except Exception:
        return None


def _parse_field(f: str, lo: int, hi: int) -> set[int]:
    vals: set[int] = set()
    for part in f.split(","):
        step = 1
        if "/" in part:
            part, step_s = part.split("/", 1)
            step = int(step_s)
        if part in ("*", ""):
            vals.update(range(lo, hi + 1, step))
        elif "-" in part:
            a, b = part.split("-", 1)
            vals.update(range(int(a), int(b) + 1, step))
        else:
            v = int(part)
            if lo <= v <= hi:
                vals.add(v)
    return vals or set(range(lo, hi + 1))


def next_run_at(row: dict, now: float | None = None) -> float | None:
    """Calcola il prossimo run da schedule_kind/expr + last_run_ts."""
    now = now if now is not None else time.time()
    kind = (row.get("schedule_kind") or row.get("trigger") or "").lower()
    expr = row.get("schedule_expr") or row.get("schedule_raw") or ""
    last = row.get("last_run_ts") or row.get("next_run") or None
    if kind == "one_shot":
        try:
            ts = float(expr)
            return ts if ts > now else None
        except (TypeError, ValueError):
            return None
    if kind == "interval":
        secs = _interval_seconds(expr)
        if not secs:
            return None
        base = last or now
        nxt = base + secs
        while nxt <= now:  # recupera il ritardo senza accumulare backlog
            nxt += secs
        return nxt
    if kind in ("cron", "daily", "weekly", "monthly"):
        nxt = _cron_next(expr, now)
        return nxt
    return None


def is_due(row: dict, now: float | None = None) -> bool:
    if not row.get("enabled"):
        return False
    if (row.get("source") or "engine") != "engine":
        return False
    if not (row.get("command") or row.get("script_path")):
        return False
    now = now if now is not None else time.time()
    nxt = next_run_at(row, now)
    last = row.get("last_run_ts")
    if nxt is None:
        return last is None  # mai eseguita e senza schedule -> dovuta una volta
    return nxt <= now


# --- esecuzione ------------------------------------------------------------

def run_job(automation_id: str, timeout: int = RUN_TIMEOUT_S) -> dict:
    """Esegue subito un'automazione engine, scrive il log, aggiorna il db."""
    rows = state.query("SELECT * FROM automations WHERE id=?", (automation_id,))
    if not rows:
        raise KeyError(f"automation not found: {automation_id}")
    row = rows[0]
    cmd = (row.get("command") or "").strip()
    if not cmd and row.get("script_path"):
        sp = row["script_path"]
        cmd = f"bash {sp}" if sp.endswith(".sh") else f"python3 {sp}"
    if not cmd:
        raise ValueError("automation has no command/script_path")
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    jobdir = LOG_DIR / automation_id
    jobdir.mkdir(parents=True, exist_ok=True)
    ts = time.time()
    log_path = jobdir / f"{datetime.fromtimestamp(ts, tz=timezone.utc):%Y%m%dT%H%M%SZ}.log"
    t0 = time.monotonic()
    try:
        proc = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                              timeout=timeout, cwd=str(HERMES_HOME))
        status = "ok" if proc.returncode == 0 else "error"
        body = (f"$ {cmd}\nrc={proc.returncode}\n"
                f"--- stdout ---\n{proc.stdout[-20000:]}"
                f"\n--- stderr ---\n{proc.stderr[-20000:]}")
    except subprocess.TimeoutExpired as exc:
        status = "timeout"
        body = (f"$ {cmd}\nTIMEOUT dopo {timeout}s\n"
                f"--- stdout (parziale) ---\n{(exc.stdout or '')[-20000:]}")
    dur_ms = int((time.monotonic() - t0) * 1000)
    log_path.write_text(body, encoding="utf-8", errors="replace")
    state.execute(
        "UPDATE automations SET last_run_ts=?, last_run_status=?, "
        "last_run_duration_ms=?, last_run_output_path=?, next_run=? WHERE id=?",
        (ts, status, dur_ms, str(log_path),
         next_run_at({**row, "last_run_ts": ts}),
         automation_id))
    return {"id": automation_id, "status": status, "duration_ms": dur_ms,
            "log_path": str(log_path)}


def read_log_tail(automation_id: str, tail: int = 60) -> dict:
    rows = state.query("SELECT last_run_output_path FROM automations WHERE id=?",
                       (automation_id,))
    if not rows:
        raise KeyError(f"automation not found: {automation_id}")
    p = rows[0].get("last_run_output_path") or ""
    if not p or not Path(p).is_file():
        return {"id": automation_id, "log_path": p or None, "tail": []}
    lines = Path(p).read_text(encoding="utf-8", errors="replace").splitlines()
    return {"id": automation_id, "log_path": p, "tail": lines[-max(tail, 1):]}


# --- migrazione dai cron Hermes --------------------------------------------

def _hermes_cron_pause(job_id: str) -> bool:
    try:
        r = subprocess.run([HERMES_BIN, "cron", "pause", job_id],
                           capture_output=True, text=True, timeout=30,
                           env={**os.environ, "HERMES_HOME": str(HERMES_HOME)})
        return r.returncode == 0
    except Exception:
        return False


def ensure_engine_jobs(pause_origins: bool = True) -> list[dict]:
    """Crea/aggiorna le automazioni engine migrate (solo colonne statiche),
    e disabilita (pause) i cron Hermes di origine. Idempotente."""
    try:
        jobs = json.loads((HERMES_HOME / "cron" / "jobs.json").read_text()).get("jobs", [])
    except (OSError, ValueError):
        jobs = []
    by_name = {j.get("name"): j for j in jobs}
    out = []
    for spec in MIGRATED_JOBS:
        origin = by_name.get(spec["cron_name"])
        note = (f"migrato da hermes cron '{spec['cron_name']}' "
                f"(id {origin.get('id') if origin else 'n/d'}); "
                f"esecuzione via Automation Engine, cron origine in pause")
        existing = state.query("SELECT * FROM automations WHERE id=?", (spec["id"],))
        if existing:
            state.execute(
                "UPDATE automations SET name=?, source='engine', trigger=?, "
                "schedule_raw=?, schedule_kind=?, schedule_expr=?, script_path=?, "
                "command=?, enabled=1, profile=?, office_id=?, migration_note=? "
                "WHERE id=?",
                (spec["name"],
                 "cron" if spec["schedule_kind"] == "cron" else "interval",
                 spec["schedule_raw"], spec["schedule_kind"], spec["schedule_expr"],
                 spec["script_path"], spec["command"], spec["profile"],
                 spec["office_id"], note, spec["id"]))
        else:
            state.execute(
                "INSERT INTO automations (id,name,source,trigger,schedule_raw,enabled,"
                "office_id,profile,script_path,command,schedule_kind,schedule_expr,"
                "migration_note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (spec["id"], spec["name"], "engine",
                 "cron" if spec["schedule_kind"] == "cron" else "interval",
                 spec["schedule_raw"], 1, spec["office_id"], spec["profile"],
                 spec["script_path"], spec["command"], spec["schedule_kind"],
                 spec["schedule_expr"], note))
        if pause_origins and origin and origin.get("enabled"):
            _hermes_cron_pause(origin["id"])
        out.append({**spec, "migration_note": note,
                    "origin_enabled_before": bool(origin.get("enabled")) if origin else None})
    return out


# --- thread daemon (solo processo web server) --------------------------------

_engine_thread: threading.Thread | None = None
_engine_stop = threading.Event()


def _loop() -> None:
    while not _engine_stop.wait(LOOP_S):
        try:
            rows = state.query("SELECT * FROM automations WHERE enabled=1")
            now = time.time()
            for r in rows:
                try:
                    if is_due(r, now):
                        run_job(r["id"])
                except Exception:
                    continue
        except Exception:
            continue


def maybe_start() -> bool:
    """Avvia il thread engine solo nel processo del web server.

    Guardia: parte solo se GESTIONALE_ENGINE != '0' E (GESTIONALE_ENGINE == '1'
    oppure argv/processo indica il web server Hermes: uvicorn, hermes, web).
    Mai nel worker standalone server.py:8790 (argv contiene 'server.py').
    """
    global _engine_thread
    if _engine_thread and _engine_thread.is_alive():
        return True
    if os.environ.get("GESTIONALE_ENGINE", "") == "0":
        return False
    argv = " ".join(sys.argv).lower()
    forced = os.environ.get("GESTIONALE_ENGINE", "") == "1"
    looks_like_web = any(k in argv for k in ("uvicorn", "hermes", "web", "gunicorn", "hypercorn"))
    standalone = "server.py" in argv and "uvicorn" not in argv
    if standalone and not forced:
        return False
    if not (forced or looks_like_web or os.environ.get("HERMES_HOME")):
        return False
    try:
        ensure_engine_jobs()
    except Exception:
        pass
    _engine_stop.clear()
    _engine_thread = threading.Thread(target=_loop, daemon=True,
                                      name="gestionale-engine")
    _engine_thread.start()
    return True
