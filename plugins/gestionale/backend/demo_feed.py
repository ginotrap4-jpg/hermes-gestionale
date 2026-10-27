"""Gestionale Hermes — demo feed.

Popola SQLite con dati demo realistici (uffici, agenti finti in missioni,
chat di gruppo/DM tra agenti, automazioni con cron reali dell'istanza)
e poi liAnima: progressi, heartbeat, nuovi messaggi — così l'interfaccia
si vede "viva" in tempo reale anche prima dell'integrazione con la
Subagent Lifecycle API (F3).
"""
from __future__ import annotations

import itertools
import random
import threading
import time
import uuid

import state

_agent_counter = itertools.count(1)

OFFICES = [
    {"id": "ricerca",  "name": "Ricerca",    "icon": "search",  "color": "#7aa2f7",
     "role_instructions": "Trovi fonti, verifichi, riporti fatti con riferimenti.", "allowed_toolsets": ["web", "browser"], "model": "default"},
    {"id": "sviluppo", "name": "Sviluppo",   "icon": "code",    "color": "#9ece6a",
     "role_instructions": "Scrivi e testi codice; piccoli commit verificati.", "allowed_toolsets": ["terminal", "file"], "model": "default"},
    {"id": "produzione", "name": "Produzione", "icon": "layers", "color": "#e0af68",
     "role_instructions": "Produce deliverable (slide, PDF, report).", "allowed_toolsets": ["file", "tools"], "model": "default"},
    {"id": "operations", "name": "Operations", "icon": "activity", "color": "#bb9af7",
     "role_instructions": "Monitori sistemi, cron e watchdog.", "allowed_toolsets": ["terminal"], "model": "default"},
]

AGENT_NAMES = {"ricerca": ["Scout", "Explorer"], "sviluppo": ["Forgia", "Refactor"],
               "produzione": ["Compositore", "Redattore"], "operations": ["Sentinella"]}

CHAT_MESSAGES_POOL = [
    "Ho trovato 3 fonti valide per la sezione 2, ti le giro nel file.",
    "Confermo: la tabella va rifatta con i dati Q4.",
    "Build verde, test passati. Procedo con la review.",
    "Il PDF ora rispetta il layout richiesto, lo carico.",
    "Watchdog verde, gateway su, nessun allarme.",
    "Attenzione: la API del provider ha inflitto 429 due volte — retry configurato.",
    "Aggiorno il draft con le tue note, 5 minuti.",
    "Benchmark pronto, te lo salvo negli output.",
    "Bozza capitolo 1 finita, round di revisione prima di mandarla al compositore.",
    "Nuova versione on line, la trovi su /opt/data/output/lezioni/.",
]

AUTOMATIONS = [
    # Demo non migrata (le 4 deterministiche vivono nell'engine, v. engine.py).
    # I cron agent-driven (es. infra-audit) restano SOLO nei cron Hermes.
    {"id": "auto-quote-check", "name": "opencode-go-quota-check", "source": "engine",
     "trigger": "interval", "schedule_raw": "every 30m", "enabled": 0,
     "next_run": None, "last_run_ts": None, "last_run_status": "never",
     "last_run_duration_ms": None, "office_id": "operations", "profile": "default",
     "schedule_kind": "interval", "schedule_expr": "every 30m",
     "script_path": "", "command": "", "migration_note": "demo, mai migrata: nessun comando"},
]

# Seed sensato per il profilo docente-sf (docente di scienze, Accademia SF):
# uffici didattici, progetto lezioni, task reali, automazione agent-driven
# 'cron-lezioni' che resta nei cron Hermes (NON engine: richiede agente LLM).
DOCENTE_OFFICES = [
    {"id": "didattica", "name": "Didattica", "icon": "book", "color": "#7aa2f7",
     "role_instructions": "Prepara lezioni di scienze: contenuti accurati, linguaggio per ragazzi di 13 anni.", "allowed_toolsets": ["file", "tools"], "model": "default"},
    {"id": "laboratorio", "name": "Laboratorio", "icon": "flask", "color": "#9ece6a",
     "role_instructions": "Esperimenti e schede operative per la classe.", "allowed_toolsets": ["file", "tools"], "model": "default"},
    {"id": "valutazione", "name": "Valutazione", "icon": "check", "color": "#e0af68",
     "role_instructions": "Verifiche, griglie di valutazione, recuperi.", "allowed_toolsets": ["file"], "model": "default"},
]

DOCENTE_AUTOMATIONS = [
    {"id": "cron-lezioni-docente", "name": "Preparazione lezioni settimana successiva",
     "source": "hermes_cron", "trigger": "cron", "schedule_raw": "every thursday 15:00",
     "enabled": 1, "next_run": None, "last_run_ts": None, "last_run_status": "",
     "last_run_duration_ms": None, "office_id": "didattica", "profile": "docente-sf",
     "schedule_kind": "cron", "schedule_expr": "0 15 * * 4",
     "script_path": "", "command": "",
     "migration_note": "agent-driven (richiede LLM): resta nei cron Hermes, non migrata"},
]

DOCENTE_PROJECTS = [
    {"id": "p-lezioni-2627", "name": "Lezioni 2026-27", "description": "Pacchetti PDF settimanali L1+L2+L3+riassunto per l'Accademia San Francesco.", "progress": 0.10},
]

DOCENTE_TASKS = [
    {"id": "t-doc1", "title": "Programma settimanale v17 — verifica slot", "description": "Allineare gli 84 slot con i deliverable in /opt/data/output/accademia-sf/lezioni/2026-27/.",
     "status": "in_progress", "parent_id": "", "assignee_office_id": "didattica", "priority": "p1", "project_id": "p-lezioni-2627"},
    {"id": "t-doc2", "title": "Prossima settimana senza deliverable — pacchetto PDF", "description": "Produrre L1+L2+L3+riassunto per la prima settimana scoperta (run cron del giovedì).",
     "status": "todo", "parent_id": "", "assignee_office_id": "didattica", "priority": "p1", "project_id": "p-lezioni-2627"},
]

# Seed minima per n8nops (specialista workflow n8n su istanza sandbox).
N8NOPS_OFFICES = [
    {"id": "flussi", "name": "Flussi n8n", "icon": "workflow", "color": "#bb9af7",
     "role_instructions": "Costruisci e testa workflow n8n nella sandbox.", "allowed_toolsets": ["terminal", "file"], "model": "default"},
]

N8NOPS_PROJECTS = [
    {"id": "p-sandbox", "name": "Workflow sandbox", "description": "Build e test di workflow n8n per Leonardo.", "progress": 0.0},
]

N8NOPS_TASKS = [
    {"id": "t-n8n1", "title": "Primo workflow di prova in sandbox", "description": "Verificare connessione istanza sandbox e creare un workflow minimo.",
     "status": "backlog", "parent_id": "", "assignee_office_id": "flussi", "priority": "p2", "project_id": "p-sandbox"},
]

DEMO_TASKS = [
    # parent + subtasks (progetto lezioni)
    {"id": "t-lez12", "title": "Lezione 12 — pacchetto slide completo", "description": "Capitoli 1-3, layout PDF, invio giovedì.",
     "status": "in_progress", "parent_id": "", "assignee_office_id": "produzione", "priority": "p1", "project_id": "p-lezioni"},
    {"id": "t-lez12a", "title": "Raccogliere fonti case studies B2B", "description": "Minimo 5 fonti verificate con riferimenti.",
     "status": "done", "parent_id": "t-lez12", "assignee_office_id": "ricerca", "priority": "p1", "project_id": "p-lezioni"},
    {"id": "t-lez12b", "title": "Bozza capitoli 1-3", "description": "Draft da passare al compositore.",
     "status": "in_review", "parent_id": "t-lez12", "assignee_office_id": "produzione", "priority": "p1", "project_id": "p-lezioni"},
    {"id": "t-lez12c", "title": "Tabella dati Q4", "description": "Rifare tabella con dati Q4.",
     "status": "todo", "parent_id": "t-lez12", "assignee_office_id": "produzione", "priority": "p2", "project_id": "p-lezioni"},
    # progetto gestionale
    {"id": "t-ges1", "title": "Endpoint /graph per canvas uffici", "description": "Nodi uffici + archi da chat_messages.",
     "status": "done", "parent_id": "", "assignee_office_id": "sviluppo", "priority": "p1", "project_id": "p-gestionale"},
    {"id": "t-ges2", "title": "Board task stile paperclip", "description": "CRUD task + commenti.",
     "status": "in_progress", "parent_id": "", "assignee_office_id": "sviluppo", "priority": "p1", "project_id": "p-gestionale"},
    {"id": "t-ges3", "title": "Verifica gateway e watchdog", "description": "Controllo periodico 429 provider.",
     "status": "blocked", "parent_id": "", "assignee_office_id": "operations", "priority": "p0", "project_id": "p-gestionale"},
    {"id": "t-ges4", "title": "Report mensile sicurezza", "description": "Da schedulare a novembre.",
     "status": "backlog", "parent_id": "", "assignee_office_id": "operations", "priority": "p3", "project_id": "p-gestionale"},
]

DEMO_COMMENTS = [
    ("t-lez12b", "Compositore", "agent", "Bozza capitoli 1-2 pronta, manca il 3."),
    ("t-lez12b", "Leonardo", "user", "Aggiungi la tabella Q4 prima di chiudere."),
    ("t-lez12a", "Scout", "agent", "5 fonti verificate, link nel file."),
    ("t-ges3", "Sentinella", "agent", "Bloccato: 429 dal provider, retry configurato."),
]


def seed_tasks():
    """v0.4 sviluppo reale: niente task/commenti demo. Se il DB è vuoto resta vuoto."""
    return
    if state.query("SELECT COUNT(*) c FROM tasks")[0]["c"]:
        return
    now = state.now()
    for t in DEMO_TASKS:
        state.execute("INSERT OR IGNORE INTO tasks (id,title,description,status,parent_id,"
                      "assignee_agent_id,assignee_office_id,priority,project_id,created_at,updated_at)"
                      " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                      (t["id"], t["title"], t["description"], t["status"], t["parent_id"], "",
                       t["assignee_office_id"], t["priority"], t["project_id"], now, now))
    for i, (tid, author, kind, text) in enumerate(DEMO_COMMENTS):
        state.execute("INSERT INTO task_comments (task_id,author,author_kind,text,ts)"
                      " VALUES (?,?,?,?,?)", (tid, author, kind, text, now - (len(DEMO_COMMENTS) - i) * 60))


PROJECTS = [
    {"id": "p-lezioni", "name": "Lezioni giovedì", "description": "Produzione settimanale slide lezione (PDF) da cron del giovedì.", "progress": 0.72},
    {"id": "p-gestionale", "name": "Gestionale Hermes", "description": "Plugin desktop + backend per uffici/automazioni/chat di questa istanza.", "progress": 0.30},
    {"id": "p-muse", "name": "Muse Bridge", "description": "Bridge in background verso il piano musicale.", "progress": 0.90},
]


def seed():
    with state._lock:
        for o in OFFICES:
            state.execute(
                "INSERT OR REPLACE INTO offices (id,name,icon,color,role_instructions,allowed_toolsets,model,profile,kind)"
                " VALUES (?,?,?,?,?,?,?,?,?)",
                (o["id"], o["name"], o["icon"], o["color"], o["role_instructions"], state.jdump(o["allowed_toolsets"]), o["model"], "default", o.get("kind", "worker")))
        for a in AUTOMATIONS:
            state.execute(
                "INSERT OR REPLACE INTO automations (id,name,source,trigger,schedule_raw,enabled,next_run,last_run_ts,last_run_status,last_run_duration_ms,office_id,profile,"
                "schedule_kind,schedule_expr,script_path,command,migration_note)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (a["id"], a["name"], a["source"], a["trigger"], a["schedule_raw"], a["enabled"],
                 a["next_run"], a["last_run_ts"], a["last_run_status"], a["last_run_duration_ms"], a["office_id"], a.get("profile", "default"),
                 a.get("schedule_kind", ""), a.get("schedule_expr", ""), a.get("script_path", ""), a.get("command", ""), a.get("migration_note", "")))
        # v0.4 sviluppo reale: niente progetti/missioni demo — questi INSERT erano seed prototipo.
        # Peraprojectsmessagesrmesso omissions.
        # v0.4 sviluppo reale: niente missioni demo puntate a progetti mock.
        _demo_missions_done = True
    seed_tasks()
    seed_docente()
    seed_n8nops()
    seed_special_offices()
    _reconcile_chats()
    # Pulizia riga demo obsoleta: le lezioni ora vivono nel profilo docente-sf
    # (cron-lezioni-docente, source hermes_cron) e nei cron Hermes reali.
    state.execute("DELETE FROM automations WHERE id='cron-lezioni'")


def _reconcile_chats() -> None:
    """Riallinea via codice i partecipanti delle chat demo agli agenti esistenti.

    Se una chat cita solo agent-id sconosciuti (DB resettato/riseminato dagli
    agenti nel frattempo), i partecipanti vengono riscritti con un agente reale
    per ufficio worker; i messaggi storici restano, last_message_ts ricalcolato.
    Non tocca mai chat sane. Nessun agente coinvolto.
    """
    try:
        agents = state.query("SELECT id, office_id FROM agents ORDER BY started_at DESC")
        if not agents:
            return
        known = {a["id"] for a in agents}
        by_office: dict[str, str] = {}
        for a in agents:
            by_office.setdefault(a["office_id"], a["id"])
        offices = [o for o in ("ricerca", "sviluppo", "produzione", "operations") if o in by_office]
        if not offices:
            offices = list(by_office)[:4]
        for c in state.query("SELECT id, type, participants FROM chats"):
            try:
                parts = state.jload(c.get("participants"))
            except Exception:
                parts = []
            if any(p in known for p in parts):
                continue
            if c["type"] == "dm":
                new_parts = [by_office[o] for o in offices[:2]]
            else:
                new_parts = [by_office[o] for o in offices]
            state.execute("UPDATE chats SET participants=? WHERE id=?",
                          (state.jdump(new_parts), c["id"]))
        for c in state.query("SELECT id FROM chats"):
            mx = state.query("SELECT MAX(ts) m FROM chat_messages WHERE chat_id=?",
                             (c["id"],))[0]["m"] or 0
            if mx:
                state.execute("UPDATE chats SET last_message_ts=? WHERE id=?", (mx, c["id"]))
    except Exception:
        pass


def _seed_offices(rows: list[dict], profile: str) -> None:
    for o in rows:
        state.execute(
            "INSERT OR REPLACE INTO offices (id,name,icon,color,role_instructions,allowed_toolsets,model,profile,kind)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (o["id"], o["name"], o["icon"], o["color"], o["role_instructions"], state.jdump(o["allowed_toolsets"]), o["model"], profile, o.get("kind", "worker")))


def _special_offices_for(profile: str) -> list[dict]:
    """Uffici speciali v0.4: orchestratore + knowledge-keeper per OGNI profilo."""
    suffix = "" if profile == "default" else f"-{profile}"
    return [
        {"id": f"orchestratore{suffix}", "name": "Orchestratore",
         "icon": "crown", "color": "#f7768e",
         "role_instructions": "Coordina gli uffici worker del profilo, aggrega progressi e tempistiche via SQL, non esegue task direttamente.",
         "allowed_toolsets": [], "model": "default", "kind": "orchestrator"},
        {"id": f"knowledge-keeper{suffix}", "name": "Knowledge Keeper",
         "icon": "shield", "color": "#7dcfff",
         "role_instructions": "Custodisce i dati sensibili del profilo, applica le censure prima di rispondere ai worker.",
         "allowed_toolsets": [], "model": "default", "kind": "gatekeeper"},
    ]


def seed_special_offices() -> None:
    """Assicura orchestratore + knowledge-keeper per ogni profilo noto. Idempotente."""
    try:
        profiles: set[str] = {"default"}
        try:
            import engine as _eng
            for p in _eng.list_profiles():
                profiles.add(p)
        except Exception:
            pass
        for r in state.query("SELECT DISTINCT profile FROM offices"):
            if r.get("profile"):
                profiles.add(r["profile"])
        for r in state.query("SELECT DISTINCT profile FROM projects"):
            if r.get("profile"):
                profiles.add(r["profile"])
        for profile in sorted(profiles):
            for o in _special_offices_for(profile):
                # INSERT OR IGNORE per non sovrascrivere personalizzazioni,
                # poi normalizza kind (coerente anche su DB legacy).
                state.execute(
                    "INSERT OR IGNORE INTO offices (id,name,icon,color,role_instructions,allowed_toolsets,model,profile,kind)"
                    " VALUES (?,?,?,?,?,?,?,?,?)",
                    (o["id"], o["name"], o["icon"], o["color"], o["role_instructions"],
                     state.jdump(o["allowed_toolsets"]), o["model"], profile, o["kind"]))
                state.execute("UPDATE offices SET kind=? WHERE id=?", (o["kind"], o["id"]))
    except Exception:
        pass


def _seed_automations(rows: list[dict]) -> None:
    for a in rows:
        state.execute(
            "INSERT OR REPLACE INTO automations (id,name,source,trigger,schedule_raw,enabled,next_run,last_run_ts,last_run_status,last_run_duration_ms,office_id,profile,"
            "schedule_kind,schedule_expr,script_path,command,migration_note)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (a["id"], a["name"], a["source"], a["trigger"], a["schedule_raw"], a["enabled"],
             a["next_run"], a["last_run_ts"], a["last_run_status"], a["last_run_duration_ms"], a["office_id"], a.get("profile", "default"),
             a.get("schedule_kind", ""), a.get("schedule_expr", ""), a.get("script_path", ""), a.get("command", ""), a.get("migration_note", "")))


def seed_docente() -> None:
    """v0.4: disabilitato — nessun mock."""
    return
    if state.query("SELECT COUNT(*) c FROM offices WHERE profile='docente-sf'")[0]["c"]:
        return
    with state._lock:
        _seed_offices(DOCENTE_OFFICES, "docente-sf")
        _seed_automations(DOCENTE_AUTOMATIONS)
        for p in DOCENTE_PROJECTS:
            state.execute("INSERT OR REPLACE INTO projects (id,name,description,progress,profile) VALUES (?,?,?,?,?)",
                          (p["id"], p["name"], p["description"], p["progress"], "docente-sf"))
        now = state.now()
        for t in DOCENTE_TASKS:
            state.execute("INSERT OR IGNORE INTO tasks (id,title,description,status,parent_id,"
                          "assignee_agent_id,assignee_office_id,priority,project_id,created_at,updated_at,profile)"
                          " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                          (t["id"], t["title"], t["description"], t["status"], t["parent_id"], "",
                           t["assignee_office_id"], t["priority"], t["project_id"], now, now, "docente-sf"))


def seed_n8nops() -> None:
    """v0.4: disabilitato — nessun mock."""
    return
    if state.query("SELECT COUNT(*) c FROM offices WHERE profile='n8nops'")[0]["c"]:
        return
    with state._lock:
        _seed_offices(N8NOPS_OFFICES, "n8nops")
        for p in N8NOPS_PROJECTS:
            state.execute("INSERT OR REPLACE INTO projects (id,name,description,progress,profile) VALUES (?,?,?,?,?)",
                          (p["id"], p["name"], p["description"], p["progress"], "n8nops"))
        now = state.now()
        for t in N8NOPS_TASKS:
            state.execute("INSERT OR IGNORE INTO tasks (id,title,description,status,parent_id,"
                          "assignee_agent_id,assignee_office_id,priority,project_id,created_at,updated_at,profile)"
                          " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                          (t["id"], t["title"], t["description"], t["status"], t["parent_id"], "",
                           t["assignee_office_id"], t["priority"], t["project_id"], now, now, "n8nops"))


def seed_agents():
    """Disabilitato in sviluppo reale: nessun agente finto (v0.4+). Le UI
    mostrano uffici vuoti finché non spawniamo agenti veri via /test/spawn-team."""
    return []


def _dead_seed_agents():
    agents = []
    for office_id in ["ricerca", "sviluppo", "produzione", "operations"]:
        name = AGENT_NAMES[office_id][0]
        aid = f"ag-{uuid.uuid4().hex[:8]}"
        agents.append({"id": aid, "name": f"{name} ({office_id})", "office_id": office_id,
                       "mission_id": {"ricerca": "m-1", "sviluppo": "m-2", "produzione": "m-1", "operations": ""}[office_id],
                       "state": "RUNNING", "goal": _goal_for(office_id),
                       "started_at": state.now(), "heartbeat_at": state.now(),
                       "progress": random.uniform(0.1, 0.9), "model": "default", "toolsets": []})
    group_chat = {"id": "chat-team", "type": "group", "name": "Squadra Sprint", "participants": [a["id"] for a in agents]}
    dm = {"id": "chat-dm1", "type": "dm", "name": "Ricerca→Sviluppo", "participants": [agents[0]["id"], agents[1]["id"]]}

    with state._lock:
        for a in agents:
            state.execute("INSERT INTO agents (id,name,office_id,mission_id,state,goal,started_at,heartbeat_at,progress,model,toolsets)"
                          " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                          (a["id"], a["name"], a["office_id"], a["mission_id"], a["state"], a["goal"],
                           a["started_at"], a["heartbeat_at"], a["progress"], a["model"], state.jdump(a["toolsets"])))
        for c in [group_chat, dm]:
            state.execute("INSERT OR REPLACE INTO chats (id,type,name,participants,state,last_message_ts) VALUES (?,?,?,?,?,?)",
                          (c["id"], c["type"], c["name"], state.jdump(c["participants"]), "open", 0))
        for i in range(6):
            state.execute("INSERT INTO chat_messages (chat_id,from_agent_id,to_agent_ids,text,ts) VALUES (?,?,?,?,?)",
                          ("chat-team", agents[i % 4]["id"], "[]", CHAT_MESSAGES_POOL[i % len(CHAT_MESSAGES_POOL)], state.now() - (6 - i) * 25))
        state.execute("INSERT INTO chat_messages (chat_id,from_agent_id,to_agent_ids,text,ts) VALUES (?,?,?,?,?)",
                      ("chat-dm1", agents[0]["id"], state.jdump([agents[1]["id"]]), CHAT_MESSAGES_POOL[7], state.now() - 40))
        for c in [group_chat, dm]:
            mx = state.query("SELECT MAX(ts) m FROM chat_messages WHERE chat_id=?", (c["id"],))[0]["m"] or 0
            state.execute("UPDATE chats SET last_message_ts=? WHERE id=?", (mx, c["id"]))
    for a in agents:
        _emit_lazy("agent_update", a)
    for c in [group_chat, dm]:
        _emit_lazy("chat_update", c)
    return agents


def _goal_for(office_id):
    return {
        "ricerca": "Raccogliere fonti per sezione 'Case studies B2B'",
        "sviluppo": "Implementare plugin desktop + backend /api/gestionale",
        "produzione": "Generare capitoli slide lezione 12",
        "operations": "Verificare gateway, cron e watchdog attivi",
    }[office_id]


def _emit_lazy(event, data):
    try:
        import server as _server
        _server.emit(event, data)
    except Exception:
        pass


def _tick(agents):
    """Animazione demo: progressi, heartbeat, messaggi casuali."""
    with state._lock:
        for a in agents:
            if a["state"] != "RUNNING":
                continue
            a["progress"] = min(1.0, a["progress"] + random.uniform(0.005, 0.02))
            a["heartbeat_at"] = state.now()
            state.execute("UPDATE agents SET progress=?, heartbeat_at=? WHERE id=?",
                          (a["progress"], a["heartbeat_at"], a["id"]))
        if random.random() < 0.35:
            chat_id, from_agent = random.choice([("chat-team", [a for a in agents if a["state"] == "RUNNING"][0]),
                                                 ("chat-dm1", agents[0])])
            participants = state.jload(state.query("SELECT participants FROM chats WHERE id=?", (chat_id,))[0]["participants"])
            msg = {"id": None, "chat_id": chat_id, "from_agent_id": from_agent["id"],
                   "to_agent_ids": [], "text": random.choice(CHAT_MESSAGES_POOL), "ts": state.now()}
            msg["id"] = state.execute("INSERT INTO chat_messages (chat_id,from_agent_id,to_agent_ids,text,ts) VALUES (?,?,?,?,?)",
                                      (msg["chat_id"], msg["from_agent_id"], state.jdump(msg["to_agent_ids"]), msg["text"], msg["ts"]))
            state.execute("UPDATE chats SET last_message_ts=? WHERE id=?", (msg["ts"], msg["chat_id"]))
            _emit_lazy("chat_message", msg)


def start_demo_loop():
    """Popola dati e poi anima in background ogni 2s."""
    seed()
    agents = seed_agents()

    def loop():
        while True:
            time.sleep(2)
            try:
                _tick(agents)
            except Exception as e:  # noqa
                print("demo tick err:", e)

    threading.Thread(target=loop, daemon=True).start()
    print("[gestionale] demo feed started")
