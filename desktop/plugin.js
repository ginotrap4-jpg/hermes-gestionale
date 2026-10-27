/** Gestionale Hermes — desktop plugin v0.4.4.
 * Sidebar /gestionale con tab: Uffici (top row Orchestratore + Knowledge Keeper,
 * worker force-directed con card rettangolari, glifi, mini-task, elbow lines),
 * Chat, Automazioni (last_run_at + Esegui ora + Log), Output (file explorer),
 * Progetti (kanban read-only + commenti). Selettore profili in basso (?profile=).
 * Dati: ctx.rest verso /api/plugins/gestionale/ quando disponibile,
 * fallback a fetch http://127.0.0.1:8790 + polling (3s, 2s per il grafo).
 * Robusto a backend offline (EmptyState). Stile: solo variabili tema,
 * mai colori hardcoded (canvas: toni di blu derivati da --accent).
 * v0.4.4: (1) drag stabile: card in drag/inerzia esclusa da OGNI fisica e
 * anti-overlap (flag frozenId), mai rAF concorrente che la sposta; (2) inerzia
 * leggera al lancio (velocity media ~80ms, damping 0.82/frame, cutoff
 * ~0.02px/frame, clamp 28px/frame), decelerazione libera senza forze, una sola
 * passata anti-overlap soft dopo il fermo; (3) no-vibra: soglia morta <2px
 * negli spostamenti reflow, il loop si ferma; (4) niente drag se il mousedown
 * e su input/textarea/select/contenteditable o con selezione testo attiva.
 * v0.4.3: (1) NESSUNO scale()/zoom sul contenitore: posizioni snap a px
 * interi (Math.round), misure via offsetWidth/offsetHeight (non getBoundingRect
 * su elemento trasformato), SVG in spazio pixel 1:1 (no viewBox stretch) +
 * non-scaling-stroke, keyframes solo box-shadow (mai scale). (2) card base
 * 250px / espansa 420px con contenuto completo, reflow anti-overlap multiplo.
 * (3) motore neutro: uffici inattivi fermi (zero forze, zero confini), solo drag;
 * zero rAF quando tutti inattivi; worker centrati piu in basso (y~60).
 * (4) multi-espansione: Set di id espansi, zIndex crescente per card, collapse
 * solo da header/chiudi, mai da click esterno.
 * v0.4.2: (1) icone ufficiali SDK: officeHead usa <Codicon name> via
 * iconFor() (mapping per ufficio), fallback a glyphFor unicode se Codicon
 * non disponibile; cerchietti restano trasparenti con bordo. (2) sezione
 * task in card: SOLO task dell'ufficio con status in_progress/blocked
 * (i t-ges* sono task reali, non mock); altrimenti riga
 * '— Task: niente in esecuzione ora'. Board completo in tab Progetti.
 * v0.4.1: (1) zero collegamenti fantasma — linee solo se chat live <5min o
 * flag backend, mai fallback tenue; stub orchestratore solo se agenti presenti.
 * (2) card espansa opaca + shadow + anti-overlap con misure DOM (adiacenti si
 * spostano), focus singolo. (3) engine: 1 iter/frame, rAF solo su kick,
 * early-exit, translate3d GPU via refs, niente setState per tick. (4) popover
 * sessione click-only ancorato alla card: nome, modello, activity (ultima
 * riga), task corrente, ultime righe output.
 */
import { cn, host, Button, Badge, EmptyState, StatusDot, Tip, Codicon } from '@hermes/plugin-sdk'
import { ROUTES_AREA, SIDEBAR_NAV_AREA, PALETTE_AREA } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useState, useEffect, useRef, useMemo } from 'react'

const ID = 'gestionale'
const API = 'http://127.0.0.1:8790'
let pluginCtx = null
const ROOT = '/opt/data/output'
const KANBAN = ['backlog', 'todo', 'in_progress', 'in_review', 'done']
const KANBAN_LABEL = { backlog: 'Backlog', todo: 'Da fare', in_progress: 'In corso', in_review: 'In revisione', done: 'Fatti' }
const TABS = [['uffici', 'Uffici'], ['chat', 'Chat'], ['automazioni', 'Automazioni'], ['output', 'Output'], ['progetti', 'Progetti']]

async function api(path, opts) {
  try {
    if (pluginCtx && pluginCtx.rest) {
      const method = (opts && opts.method) || 'GET'
      let body
      if (opts && opts.body !== undefined) {
        try { body = typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body }
        catch (e) { body = opts.body }
      }
      return await pluginCtx.rest(path, body !== undefined ? { method, body } : { method })
    }
  } catch (e) {
    lastErr = 'ctx.rest: ' + ((e && (e.message || e.detail || String(e))) || 'sconosciuto')
    throw new Error(lastErr)
  }
  try {
    const res = await fetch(API + path, opts)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return res.json()
  } catch (e) {
    lastErr = 'fetch 8790: ' + ((e && (e.message || String(e))) || 'sconosciuto')
    throw new Error(lastErr)
  }
}
let lastErr = 'nessun tentativo ancora'

function usePoll(path, intervalMs) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => {
    let alive = true
    const tick = () => {
      api(path)
        .then((d) => { if (alive) { setData(d); setErr(null) } })
        .catch((e) => { if (alive) setErr(e.message || 'errore') })
    }
    tick()
    const t = setInterval(tick, intervalMs || 3000)
    return () => { alive = false; clearInterval(t) }
  }, [path, intervalMs])
  return { data, err }
}

function pctOf(p) {
  return Math.min(100, Math.max(0, Math.round((p || 0) * 100)))
}

function dotFor(state) {
  if (state === 'RUNNING') return 'online'
  if (state === 'FAILED') return 'error'
  return 'idle'
}

function fmtKB(size) {
  if (!size) return '0 KB'
  return (size / 1024).toFixed(1) + ' KB'
}

function fmtAgo(ts) {
  if (!ts) return 'mai'
  const s = Math.max(0, Date.now() / 1000 - ts)
  if (s < 60) return Math.floor(s) + 's fa'
  if (s < 3600) return Math.floor(s / 60) + 'm fa'
  if (s < 86400) return Math.floor(s / 3600) + 'h fa'
  return Math.floor(s / 86400) + 'g fa'
}

function agentName(byId, id) {
  return ((byId || {})[id] && (byId || {})[id].name) || id || '—'
}

/* Ultima esecuzione leggibile in italiano ('—' se assente) -------------- */
function fmtLastRunIt(v) {
  if (v === null || v === undefined || v === '') return '—'
  try {
    let d = null
    if (typeof v === 'number') d = new Date(v < 1e12 ? v * 1000 : v)
    else if (typeof v === 'string' && /^[0-9]+$/.test(v.trim())) {
      const n = Number(v.trim())
      d = new Date(n < 1e12 ? n * 1000 : n)
    } else d = new Date(v)
    if (!d || isNaN(d.getTime())) return String(v)
    try {
      return d.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    } catch (e2) {
      try { return d.toLocaleString() } catch (e3) { return String(v) }
    }
  } catch (e) { return String(v) }
}

/* Palette monocromatica blu derivata da --accent --------------------------
 * hue estratto dall'accent esadecimale (fallback 217 = blu Hermes),
 * lightness variabile per indice: toni di blu, niente altri colori. */
function accentHue(accent) {
  try {
    const m = /^#([0-9a-f]{6})$/i.exec((accent || '').trim())
    if (!m) return 217
    const r = parseInt(m[1].slice(0, 2), 16) / 255
    const g = parseInt(m[1].slice(2, 4), 16) / 255
    const b = parseInt(m[1].slice(4, 6), 16) / 255
    const mx = Math.max(r, g, b)
    const mn = Math.min(r, g, b)
    if (mx === mn) return 217
    const d = mx - mn
    let h = 0
    if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60
    else if (mx === g) h = ((b - r) / d + 2) * 60
    else h = ((r - g) / d + 4) * 60
    return Math.round(h) || 217
  } catch (e) { return 217 }
}

function monoBlue(i, accent) {
  const h = accentHue(accent)
  const l = 34 + ((Number(i) || 0) * 9) % 28 // 34%..61%
  return 'hsl(' + h + ', 58%, ' + l + '%)'
}

/* Tab Uffici v0.4.3 ----------------------------------------------------------
 * Top row: Orchestratore (sempre presente) + Knowledge Keeper (fissi in alto,
 * non partecipano alle forze). Bottom: worker con layout force-directed SOLO
 * tra loro. Card rettangolari con glifi, agenti in mini-anteprima, mini-task
 * colorati, linee elbow ortogonali, pulse azzurre attive, flash verde su chat
 * interna, expand in place opaco anti-overlap, popover sessione agente.
 * Linee SOLO per chat vive (<5min o flag backend): zero fallback tenue.
 * Fallback sicuri se campi/API mancano: la UI resta grafica anche con dati vuoti.
 */
const UFF_GREEN = '#4cc38a'

/* Icona ufficiale SDK per ufficio (Codicon) + fallback unicode -------------
 * Mapping: sviluppo=code, ricerca=search, produzione=tools, operations=shield,
 * orchestratore=organization, knowledge-keeper=database, didattica=book,
 * laboratorio=beaker, valutazione=checklist, flussi=play. Se Codicon non è
 * disponibile nell'host, officeHead usa il glifo unicode di glyphFor. */
function iconFor(name) {
  const n = (typeof name === 'string' ? name : '').toLowerCase()
  if (/orchestrat/.test(n)) return 'organization'
  if (/keeper|gatekeeper|knowledge|archiv/.test(n)) return 'database'
  if (/didatt|teach|tutor|learn|cors|formazione|scuola/.test(n)) return 'book'
  if (/lab|beaker|speriment/.test(n)) return 'beaker'
  if (/valut|checklist|review|qa|test|bug|pest/.test(n)) return 'checklist'
  if (/fluss|workflow|pipeline|\bwf\b/.test(n)) return 'play'
  if (/operations|ops\b|deploy|infra|server|sre/.test(n)) return 'shield'
  if (/sviluppo|dev|code|front|back|software|app/.test(n)) return 'code'
  if (/research|ricerca|search|studio|insight/.test(n)) return 'search'
  if (/produz|tools|wrench|fabbr|maker/.test(n)) return 'tools'
  if (/design|grafic|ui|ux|brand/.test(n)) return 'paintcan'
  if (/data|db|database|analytic/.test(n)) return 'database'
  if (/doc|writ|testi|content|blog/.test(n)) return 'book'
  if (/market|growth|ads|social|seo/.test(n)) return 'megaphone'
  if (/support|help|care|client/.test(n)) return 'heart'
  return 'window'
}

function glyphFor(name) {
  const n = (typeof name === 'string' ? name : '').toLowerCase()
  if (/orchestrat/.test(n)) return '⬢'
  if (/keeper|gatekeeper|knowledge|archiv/.test(n)) return '▣'
  if (/dev|code|front|back|software|app/.test(n)) return '</>'
  if (/qa|test|bug|virus|pest/.test(n)) return '☣'
  if (/research|ricerca|search|studio|insight/.test(n)) return '⚲'
  if (/design|grafic|ui|ux|brand/.test(n)) return '✎'
  if (/data|db|database|analytic/.test(n)) return '▤'
  if (/doc|writ|testi|content|blog/.test(n)) return '☰'
  if (/ops|deploy|infra|server|sre/.test(n)) return '⚙'
  if (/market|growth|ads|social|seo/.test(n)) return '◈'
  if (/support|help|care|client/.test(n)) return '♡'
  return '○'
}

/* Keyframes iniettati in document.head una unica volta (via useMemo) -------- */
function useUfficiStyles() {
  useMemo(() => {
    try {
      if (typeof document === 'undefined') return null
      if (document.getElementById('uffici-v043-style')) return null
      const st = document.createElement('style')
      st.id = 'uffici-v043-style'
      st.textContent =
        '@keyframes uffPulse{0%,100%{box-shadow:0 0 0 0 transparent}50%{box-shadow:0 0 10px 0 var(--accent)}}' +
        '@keyframes uffGreenFlash{0%,100%{box-shadow:0 0 0 0 transparent}50%{box-shadow:0 0 12px 0 var(--ui-success,#4cc38a)}}' +
        '@keyframes uffDash{to{stroke-dashoffset:-14}}' +
        '.uff-active{animation:uffPulse 2.4s ease-in-out infinite}' +
        '.uff-flash{animation:uffGreenFlash 1.1s ease-in-out infinite}' +
        '.uff-chatline{stroke-dasharray:6 4;animation:uffDash 1.2s linear infinite}' +
        '.uff-card{transition:width .25s ease,border-color .2s ease,box-shadow .2s ease}' +
        '.uff-card{cursor:grab}' +
        '.uff-card.uff-drag{cursor:grabbing}' +
        '.uff-pop{box-shadow:0 12px 32px rgba(0,0,0,.30)}' +
        '.uff-agent{cursor:pointer}'
      document.head.appendChild(st)
      return null
    } catch (e) { return null }
  }, [])
}

function kindOf(o) {
  const k = (o && o.kind) || ''
  if (k === 'orchestrator' || k === 'gatekeeper' || k === 'worker') return k
  const n = ((o && (o.name || o.id)) || '').toLowerCase()
  if (/orchestrat/.test(n)) return 'orchestrator'
  if (/keeper|gatekeeper|knowledge/.test(n)) return 'gatekeeper'
  return 'worker'
}

function agentsOf(office, allAgents) {
  if (office && Array.isArray(office.agents) && office.agents.length) return office.agents
  const id = office && (office.id || office.name)
  return (allAgents || []).filter((a) => a && (a.office_id === id || a.office === id))
}

function msgTs(m) {
  let t = Number((m && (m.ts || m.timestamp || m.created_at)) || 0) || 0
  if (t > 1e12) t = t / 1000
  return t
}

/* Layout force-directed v0.4.4 in spazio 0..100 (solo worker) ----------------
 * (0) DRAG STABILE: card in drag/inerzia esclusa da ogni forza e reflow via
 * frozenId; inerzia post-lancio (damping 0.82, cutoff ~0.02px/frame, clamp);
 * soglia morta <2px nel reflow (niente vibrazione); no-drag su input/selezione.
 * (1) NESSUNO scale()/zoom: posizioni scritte come translate3d con px INTERI
 * (Math.round) + translate(-50%,-50%) su larghezze pari (250/420) -> testo
 * nitido, niente subpixel blur; misure via offsetWidth/offsetHeight (layout
 * reale, non trasformato), mai getBoundingClientRect per il reflow.
 * (2) Motore NEUTRO: uffici inattivi non-espansi = zero forze (no gravita,
 * repulsione, attrazione edge, confini) e velocita zero; solo drag mouse +
 * spinta reflow one-shot quando una espansa li copre. Zero rAF quando nessun
 * ufficio e effettivamente attivo (pose statiche, solo applyToDom).
 * (3) Worker centrati piu in BASSO (gravita y~60, init y 28..86) per lasciare
 * aria in alto verso la top row. (4) Drag su tutte le card con deadzone
 * 5px base / 10px espansa; oltre la deadzone il click viene soppresso.
 * (5) SVG in spazio PIXEL 1:1 (niente viewBox stretch): path elbow in px
 * interi + vector-effect non-scaling-stroke, nessuna rasterizzazione. */
function useWorkerLayout(ids, edges, expandedIds, activeIds) {
  const posRef = useRef({})
  const cardEls = useRef({})
  const wireEls = useRef({})
  const areaEl = useRef(null)
  const areaSize = useRef({ w: 800, h: 500 })
  const edgesRef = useRef(edges || [])
  edgesRef.current = edges || []
  const expSet = {}
  ;(expandedIds || []).forEach((id) => { expSet[id] = true })
  const expandedRef = useRef(expSet)
  expandedRef.current = expSet
  const actSet = {}
  ;(activeIds || []).forEach((id) => { actSet[id] = true })
  const activeRef = useRef(actSet)
  activeRef.current = actSet
  const rafRef = useRef(0)
  const framesRef = useRef(0)
  const dragRef = useRef(null)
  const inertiaRef = useRef({})
  const suppressRef = useRef({})
  const [, setStruct] = useState(0)
  const idsKey = (ids || []).join(',')
  function isExp(id) { try { return !!expandedRef.current[id] } catch (e) { return false } }
  function isAct(id) { try { return !!activeRef.current[id] } catch (e) { return false } }
  function effActive(id) { return isAct(id) || isExp(id) }
  function hasEffActive() {
    try {
      const list = ids || []
      for (let k = 0; k < list.length; k++) { if (effActive(list[k])) return true }
      return false
    } catch (e) { return false }
  }
  function hasInertia() {
    try { return Object.keys(inertiaRef.current || {}).length > 0 } catch (e) { return false }
  }
  function frozenId(id) {
    // card in drag o in inerzia: esclusa da OGNI fisica e anti-overlap
    try {
      if (dragRef.current && dragRef.current.id === id) return true
      if (inertiaRef.current && inertiaRef.current[id]) return true
    } catch (e) { /* noop */ }
    return false
  }
  function kick() {
    framesRef.current = 0
    if (!hasEffActive() && !hasInertia()) {
      try { resolveOverlapOnce(false); applyToDom() } catch (e) { /* pose statiche */ }
      return // ZERO rAF quando tutti inattivi e niente inerzia
    }
    if (!rafRef.current && typeof requestAnimationFrame !== 'undefined') {
      try { rafRef.current = requestAnimationFrame(frame) } catch (e) { rafRef.current = 0 }
    }
  }
  function sizeOf(id) {
    const s = areaSize.current || { w: 800, h: 500 }
    let w = isExp(id) ? 420 : 250
    let h = isExp(id) ? 380 : 170
    try {
      const el = cardEls.current[id]
      if (el) {
        const ow = el.offsetWidth || 0
        const oh = el.offsetHeight || 0
        if (ow > 20 && s.w > 50) { w = ow; h = oh || h }
        else {
          const r = el.getBoundingClientRect()
          if (r && r.width > 20 && s.w > 50) { w = r.width; h = r.height }
        }
      }
    } catch (e) { /* misura best-effort su layout reale */ }
    return { hw: ((w / 2 + 16) / s.w) * 100, hh: ((h / 2 + 16) / s.h) * 100 }
  }
  function applyToDom() {
    const s = areaSize.current || { w: 800, h: 500 }
    const p = posRef.current
    Object.keys(p).forEach((id) => {
      const el = cardEls.current[id]
      const P = p[id]
      if (!el || !P) return
      try {
        const X = Math.round((P.x / 100) * s.w)
        const Y = Math.round((P.y / 100) * s.h)
        el.style.transform = 'translate3d(' + X + 'px,' + Y + 'px,0) translate(-50%,-50%)'
      } catch (e) { /* dom non pronto */ }
    })
    ;(edgesRef.current || []).forEach((e) => {
      const path = wireEls.current[e.key]
      const A = p[e.a]
      const B = p[e.b]
      if (!path || !A || !B) return
      try {
        const ax = Math.round((A.x / 100) * s.w)
        const ay = Math.round((A.y / 100) * s.h)
        const bx = Math.round((B.x / 100) * s.w)
        const by = Math.round((B.y / 100) * s.h)
        path.setAttribute('d', elbowPx(ax, ay, bx, by))
      } catch (e2) { /* noop */ }
    })
    Object.keys(p).forEach((id) => {
      const path = wireEls.current['a-' + id]
      const P = p[id]
      if (!path || !P) return
      try {
        const px = Math.round((P.x / 100) * s.w)
        const py = Math.round((Math.max(1, P.y - 6) / 100) * s.h)
        const tx = Math.round(s.w / 2)
        const ty = Math.max(0, Math.round(s.h * 0.005))
        path.setAttribute('d', elbowPx(px, py, tx, ty))
      } catch (e2) { /* noop */ }
    })
  }
  function resolveOverlapOnce(soft) {
    const p = posRef.current
    const list = Object.keys(p)
    const s = areaSize.current || { w: 800, h: 500 }
    const cap = soft ? 1.5 : 6 // passata soft post-inerzia: spostamento leggero
    let i, j
    for (i = 0; i < list.length; i++) {
      for (j = i + 1; j < list.length; j++) {
        const Aid = list[i]
        const Bid = list[j]
        const A = p[Aid]
        const B = p[Bid]
        if (!A || !B) continue
        if (frozenId(Aid) || frozenId(Bid)) continue // drag/inerzia: mai toccare
        const ea = effActive(Aid)
        const eb = effActive(Bid)
        if (!ea && !eb) continue // entrambi fermi: nessuna forza
        const sa = sizeOf(Aid)
        const sb = sizeOf(Bid)
        const ox = (sa.hw + sb.hw) - Math.abs(A.x - B.x)
        const oy = (sa.hh + sb.hh) - Math.abs(A.y - B.y)
        if (ox > 0 && oy > 0) {
          if (ox < oy) {
            const sgn = (A.x >= B.x ? 1 : -1) || 1
            const sh = Math.min(ox / 2 + 0.4, cap)
            if ((sh / 100) * (s.w || 800) < 2) continue // soglia morta <2px: niente vibrazione
            if (ea && eb) { A.x += sgn * sh; B.x -= sgn * sh }
            else if (ea) { A.x += sgn * sh * 2 }
            else { B.x -= sgn * sh * 2 }
          } else {
            const sgn = (A.y >= B.y ? 1 : -1) || 1
            const sh = Math.min(oy / 2 + 0.4, cap)
            if ((sh / 100) * (s.h || 500) < 2) continue // soglia morta <2px: niente vibrazione
            if (ea && eb) { A.y += sgn * sh; B.y -= sgn * sh }
            else if (ea) { A.y += sgn * sh * 2 }
            else { B.y -= sgn * sh * 2 }
          }
          try { A.vx = 0; A.vy = 0; B.vx = 0; B.vy = 0 } catch (e) { /* noop */ }
        }
      }
    }
  }
  function frame() {
    rafRef.current = 0
    const p = posRef.current
    const list = Object.keys(p)
    if (!list.length) return
    if (++framesRef.current > 600) { try { inertiaRef.current = {} } catch (e) { /* noop */ } return } // guardia anti-loop
    if (!hasEffActive() && !hasInertia()) { try { applyToDom() } catch (e) { /* noop */ } return } // pose statiche
    const edgeList = edgesRef.current || []
    const linked = {}
    edgeList.forEach((e) => { linked[e.a + '|' + e.b] = e; linked[e.b + '|' + e.a] = e })
    const area = areaSize.current || { w: 800, h: 500 }
    let i, j
    for (i = 0; i < list.length; i++) {
      const Aid = list[i]
      if (!effActive(Aid) || frozenId(Aid)) continue // drag/inerzia: zero forze
      const A = p[Aid]
      if (!A) continue
      for (j = i + 1; j < list.length; j++) {
        const Bid = list[j]
        if (frozenId(Bid)) continue // mai spingere contro la card in drag/inerzia
        if (!effActive(Bid) && !effActive(Aid)) continue
        const B = p[Bid]
        if (!B) continue
        const bothEff = effActive(Aid) && effActive(Bid)
        const e = linked[Aid + '|' + Bid]
        let dx = A.x - B.x
        let dy = A.y - B.y
        let d2 = dx * dx + dy * dy
        if (d2 < 0.5) { dx = (i - j) || 0.5; dy = (i % 2 ? 1 : -1) * 0.5; d2 = dx * dx + dy * dy }
        const d = Math.sqrt(d2) || 1
        const rep = e ? 26 : 90 // non comunicano -> repulsione maggiore
        const f = Math.min(4, rep / d2)
        const ux = (dx / d) * f
        const uy = (dy / d) * f
        if (bothEff) { A.vx += ux; A.vy += uy; B.vx -= ux; B.vy -= uy }
        else if (effActive(Aid)) { A.vx += ux; A.vy += uy }
        else { B.vx -= ux; B.vy -= uy }
      }
    }
    edgeList.forEach((e) => {
      if (!effActive(e.a) || !effActive(e.b) || frozenId(e.a) || frozenId(e.b)) return // edge solo tra effettivi liberi
      const A = p[e.a]
      const B = p[e.b]
      if (!A || !B) return
      const w = Math.min(30, Number(e.weight) || 1)
      const rest = Math.max(14, 44 - w * 1.1)
      const k = 0.02 * (1 + w * 0.15) // attrazione proporzionale al peso live
      const dx = B.x - A.x
      const dy = B.y - A.y
      const d = Math.sqrt(dx * dx + dy * dy) || 1
      const f = (d - rest) * k
      const ux = (dx / d) * f
      const uy = (dy / d) * f
      A.vx += ux; A.vy += uy; B.vx -= ux; B.vy -= uy
    })
    let pushed = false
    for (i = 0; i < list.length; i++) {
      for (j = i + 1; j < list.length; j++) {
        const Aid = list[i]
        const Bid = list[j]
        const A = p[Aid]
        const B = p[Bid]
        if (!A || !B) continue
        const ea = effActive(Aid)
        const eb = effActive(Bid)
        if (!ea && !eb) continue
        if (frozenId(Aid) || frozenId(Bid)) continue // anti-overlap mai sulla card in drag/inerzia
        const sa = sizeOf(Aid)
        const sb = sizeOf(Bid)
        const ox = (sa.hw + sb.hw) - Math.abs(A.x - B.x)
        const oy = (sa.hh + sb.hh) - Math.abs(A.y - B.y)
        if (ox > 0 && oy > 0) {
          if (ox < oy) {
            const sgn = (A.x >= B.x ? 1 : -1) || 1
            const sh = Math.min(ox / 2 + 0.4, 6)
            if ((sh / 100) * (area.w || 800) < 2) continue // soglia morta <2px: niente vibrazione
            pushed = true
            if (ea && eb) { A.x += sgn * sh; B.x -= sgn * sh; A.vx *= 0.6; B.vx *= 0.6 }
            else if (ea) { A.x += sgn * sh * 2; A.vx *= 0.6 }
            else { B.x -= sgn * sh * 2; B.vx *= 0.6 }
          } else {
            const sgn = (A.y >= B.y ? 1 : -1) || 1
            const sh = Math.min(oy / 2 + 0.4, 6)
            if ((sh / 100) * (area.h || 500) < 2) continue // soglia morta <2px: niente vibrazione
            pushed = true
            if (ea && eb) { A.y += sgn * sh; B.y -= sgn * sh; A.vy *= 0.6; B.vy *= 0.6 }
            else if (ea) { A.y += sgn * sh * 2; A.vy *= 0.6 }
            else { B.y -= sgn * sh * 2; B.vy *= 0.6 }
          }
        }
      }
    }
    let maxD = 0
    list.forEach((id) => {
      const P = p[id]
      if (!P) return
      const ine = (inertiaRef.current || {})[id]
      if (ine) {
        // inerzia post-lancio: scorrimento libero decelerato, NESSUNA forza della fisica
        P.x = Math.min(97, Math.max(1, P.x + ine.vx))
        P.y = Math.min(97, Math.max(1, P.y + ine.vy))
        if (P.x <= 1 || P.x >= 97) ine.vx = 0
        if (P.y <= 1 || P.y >= 97) ine.vy = 0
        ine.vx *= 0.82; ine.vy *= 0.82 // damping lancio
        return
      }
      if (frozenId(id)) { P.vx = 0; P.vy = 0; return } // in drag: scrive solo il mousemove
      if (!effActive(id)) { P.vx = 0; P.vy = 0; return } // fermi: niente gravita/confini
      P.vx += (50 - P.x) * 0.004
      P.vy += (60 - P.y) * 0.004 // centro piu in basso: aria verso la top row
      P.vx *= 0.88; P.vy *= 0.88
      const nx = Math.min(94, Math.max(4, P.x + P.vx))
      const ny = Math.min(93, Math.max(14, P.y + P.vy))
      const dd = Math.max(Math.abs(nx - P.x), Math.abs(ny - P.y))
      if (dd > maxD) maxD = dd
      P.x = nx; P.y = ny
    })
    // inerzia esaurita (soglia ~0.02px/frame): una sola passata anti-overlap soft, poi stop
    let stoppedInertia = false
    try {
      Object.keys(inertiaRef.current || {}).forEach((id) => {
        const ine = inertiaRef.current[id]
        if (!ine) return
        const spx = Math.max(Math.abs(ine.vx) / 100 * (area.w || 800), Math.abs(ine.vy) / 100 * (area.h || 500))
        if (spx < 0.05) {
          delete inertiaRef.current[id]
          stoppedInertia = true
          if (posRef.current[id]) { posRef.current[id].vx = 0; posRef.current[id].vy = 0 }
        }
      })
    } catch (e) { /* inerzia mai fatale */ }
    if (stoppedInertia) { try { resolveOverlapOnce(true) } catch (e) { /* una sola passata soft */ } }
    applyToDom()
    if (pushed || maxD > 0.08 || hasInertia()) {
      try { rafRef.current = requestAnimationFrame(frame) } catch (e) { rafRef.current = 0 }
    }
  }
  function startDrag(id, ev) {
    try {
      if (ev && ev.button !== undefined && ev.button !== 0) return
      try {
        // selezione testo: niente drag se il mousedown e su input/testo selezionabile (click ok)
        const t = ev && ev.target
        if (t && t.closest && t.closest('input,textarea,select,[contenteditable]')) return
        const sel = (typeof window !== 'undefined' && window.getSelection) ? window.getSelection() : null
        if (sel && !sel.isCollapsed) return
      } catch (e) { /* check best-effort: drag normale */ }
      const P = posRef.current[id]
      const s = areaSize.current || { w: 800, h: 500 }
      if (!P || !s.w) return
      try { if (inertiaRef.current && inertiaRef.current[id]) delete inertiaRef.current[id] } catch (e) { /* il drag cancella l'inerzia */ }
      const sx = (ev && ev.clientX !== undefined) ? ev.clientX : 0
      const sy = (ev && ev.clientY !== undefined) ? ev.clientY : 0
      const dead = isExp(id) ? 10 : 5
      dragRef.current = { id, sx, sy, ox: P.x, oy: P.y, dead, moved: false, hist: [] }
      try {
        if (ev && ev.currentTarget && ev.currentTarget.classList) ev.currentTarget.classList.add('uff-drag')
      } catch (e) { /* noop */ }
      const onMove = (me) => {
        try {
          const dr = dragRef.current
          if (!dr || dr.id !== id) return
          const dxPx = (me.clientX || 0) - dr.sx
          const dyPx = (me.clientY || 0) - dr.sy
          const dist = Math.sqrt(dxPx * dxPx + dyPx * dyPx)
          if (!dr.moved && dist < dr.dead) return // deadzone: ancora click
          dr.moved = true
          try {
            // campiona gli ultimi spostamenti (~80ms) per la velocity al rilascio
            const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()
            dr.hist.push({ t: now, x: me.clientX || 0, y: me.clientY || 0 })
            while (dr.hist.length > 8) dr.hist.shift()
            while (dr.hist.length > 2 && (now - dr.hist[0].t) > 120) dr.hist.shift()
          } catch (e) { /* campionamento best-effort */ }
          const Q = posRef.current[id]
          if (!Q) return
          Q.x = Math.min(97, Math.max(1, dr.ox + (dxPx / s.w) * 100))
          Q.y = Math.min(97, Math.max(1, dr.oy + (dyPx / s.h) * 100))
          Q.vx = 0; Q.vy = 0
          suppressRef.current[id] = Date.now()
          applyToDom()
          if (me.preventDefault) me.preventDefault()
        } catch (e) { /* drag best-effort */ }
      }
      const onUp = () => {
        try {
          const dr = dragRef.current
          const wasMoved = !!(dr && dr.moved)
          dragRef.current = null
          try {
            if (ev && ev.currentTarget && ev.currentTarget.classList) ev.currentTarget.classList.remove('uff-drag')
          } catch (e2) { /* noop */ }
          try { window.removeEventListener('mousemove', onMove) } catch (e2) { /* noop */ }
          try { window.removeEventListener('mouseup', onUp) } catch (e2) { /* noop */ }
          if (wasMoved) {
            suppressRef.current[id] = Date.now()
            // inerzia leggera: velocity media degli ultimi campioni (~80ms), clamp anti-lanci
            try {
              const h = (dr && dr.hist) || []
              if (h.length >= 2 && posRef.current[id]) {
                const a = h[0]
                const b = h[h.length - 1]
                const dt = Math.max(1, b.t - a.t)
                if (dt >= 8) {
                  let vx = (((b.x - a.x) / dt) * 16.7) // px/frame
                  let vy = (((b.y - a.y) / dt) * 16.7)
                  const sp = Math.sqrt(vx * vx + vy * vy)
                  const MAXV = 28 // clamp: niente lanci violenti
                  if (sp > MAXV) { vx *= MAXV / sp; vy *= MAXV / sp }
                  if (sp >= 1.5) {
                    const s2 = areaSize.current || { w: 800, h: 500 }
                    inertiaRef.current[id] = { vx: (vx / (s2.w || 800)) * 100, vy: (vy / (s2.h || 500)) * 100 }
                  }
                }
              }
            } catch (e) { /* niente inerzia: drop secco */ }
            kick() // loop per l'inerzia, o un solo reflow dopo il drop secco
          }
        } catch (e) { /* noop */ }
      }
      try { window.addEventListener('mousemove', onMove) } catch (e) { /* noop */ }
      try { window.addEventListener('mouseup', onUp) } catch (e) { /* noop */ }
    } catch (e) { /* drag mai fatale */ }
  }
  function consumeSuppress(id) {
    try {
      const t = suppressRef.current[id] || 0
      if (Date.now() - t < 350) { suppressRef.current[id] = 0; return true }
      return false
    } catch (e) { return false }
  }
  useEffect(() => {
    const pr = posRef.current
    ;(ids || []).forEach((id, i) => {
      if (!pr[id]) {
        pr[id] = { x: 10 + 80 * (((i + 1) * 0.61803) % 1), y: 28 + 58 * (((i + 1) * 0.38197) % 1), vx: 0, vy: 0 }
      }
    })
    Object.keys(pr).forEach((k) => { if ((ids || []).indexOf(k) < 0) delete pr[k] })
    Object.keys(inertiaRef.current || {}).forEach((k) => { if ((ids || []).indexOf(k) < 0) delete inertiaRef.current[k] })
    setStruct((v) => v + 1)
    kick()
    return undefined
  }, [idsKey])
  useEffect(() => {
    const el = areaEl.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    let ro = null
    try {
      const measure = () => {
        try {
          const r = el.getBoundingClientRect()
          if (r && r.width > 50) areaSize.current = { w: r.width, h: r.height }
        } catch (e) { /* noop */ }
      }
      measure()
      ro = new ResizeObserver(() => { measure(); kick() })
      ro.observe(el)
    } catch (e) { /* observer non disponibile */ }
    return () => { try { if (ro) ro.disconnect() } catch (e) { /* noop */ } }
  }, [])
  useEffect(() => () => { try { if (rafRef.current) cancelAnimationFrame(rafRef.current) } catch (e) { /* noop */ } }, [])
  return { pos: posRef.current, cardEls, wireEls, areaEl, kick, startDrag, consumeSuppress }
}

/* Segmento elbow ortogonale in PIXEL interi (spazio 1:1, niente viewBox) ---- */
function elbowPx(x1, y1, x2, y2) {
  const a = Math.round(x1)
  const b = Math.round(y1)
  const c = Math.round(x2)
  const d = Math.round(y2)
  const mid = Math.round((b + d) / 2)
  return 'M ' + a + ' ' + b + ' V ' + mid + ' H ' + c + ' V ' + d
}

/* Compat: elbow in spazio 0..100 solo per path iniziali pre-misura --------- */
function elbow(x1, y1, x2, y2) {
  const s = 8
  return elbowPx(x1 * s, y1 * (s * 0.625), x2 * s, y2 * (s * 0.625))
}


function officeHead(o, st) {
  const nm = (o && (o.name || o.id)) || ''
  const useCod = (typeof Codicon !== 'undefined' && Codicon) ? true : false
  return jsxs('div', {
    key: 'h', className: 'flex items-center gap-1.5',
    children: [
      jsx('span', {
        key: 'g',
        className: 'inline-flex items-center justify-center rounded-full shrink-0',
        style: {
          width: 22, height: 22, background: 'transparent', fontSize: 12,
          border: '1px solid var(--border, var(--ui-stroke-secondary))',
          color: 'var(--muted-foreground, var(--ui-text-tertiary))',
        },
        children: useCod ? jsx(Codicon, { name: iconFor(nm) }) : glyphFor(nm),
      }),
      jsx('span', { key: 'n', className: 'text-xs font-medium truncate flex-1', children: nm || '—' }),
      jsx(StatusDot, { key: 'd', state: st.flash ? 'online' : (st.active ? 'online' : 'idle') }),
    ],
  })
}

/* Task corrente in card: SOLO task dell'ufficio con status in_progress o
 * blocked. Gli altri (todo/done/...) NON compaiono nella card universo;
 * il board completo resta nella tab Progetti. I task t-ges* sono reali. */
function isCurrentTask(t) {
  const s = String((t && (t.status || t.state)) || '').toLowerCase()
  return s === 'in_progress' || s === 'blocked'
}

function agentMini(a, onPick) {
  const m = (a && typeof a === 'object') ? a : {}
  const model = m.model || m.llm || m.engine || ''
  let lastOut = ''
  try {
    const lines = String(m.last_output || m.output || '').split('\n').map((s) => (s || '').trim()).filter(Boolean)
    if (lines.length) lastOut = lines[lines.length - 1]
  } catch (e) { lastOut = '' }
  const rawPrev = m.activity || m.goal || m.current_task || m.task || lastOut || 'in attesa di mansione'
  return jsxs('button', {
    key: m.id || m.name, type: 'button', title: 'Apri sessione agente',
    onClick: (ev) => { ev.stopPropagation(); if (onPick) onPick(m) },
    className: 'uff-agent w-full text-left rounded-md px-1.5 py-1 hover:bg-(--chrome-action-hover) transition-colors flex flex-col gap-px',
    children: [
      jsxs('div', {
        key: 'r', className: 'flex items-baseline gap-1.5',
        children: [
          jsx('span', { key: 'n', className: 'text-[0.72rem] font-medium truncate', children: m.name || m.id || '—' }),
          model ? jsx('span', { key: 'mo', className: 'ml-auto text-[0.6rem] text-(--ui-text-quaternary) truncate shrink-0', children: String(model).slice(0, 18) }) : null,
        ],
      }),
      jsx('div', { key: 'p', className: 'text-[0.65rem] text-(--ui-text-tertiary) truncate', children: String(rawPrev || '').slice(0, 80) }),
    ],
  })
}

function taskMini(t) {
  const m = (t && typeof t === 'object') ? t : {}
  const color = m.color || 'var(--accent, var(--ui-accent))'
  const prev = m.preview || m.description || m.status || ''
  return jsxs('div', {
    key: m.id || m.title, className: 'rounded px-1.5 py-1 border border-(--ui-stroke-secondary)',
    style: { borderLeft: '3px solid ' + color },
    children: [
      jsx('div', { key: 't', className: 'text-[0.68rem] font-medium truncate', children: m.title || m.id || '—' }),
      prev ? jsx('div', { key: 'p', className: 'text-[0.62rem] text-(--ui-text-tertiary) truncate', children: String(prev).slice(0, 70) }) : null,
    ],
  })
}

function agentByIdSafe(allAgents, m) {
  try {
    const pid = m && m.from_agent_id
    const found = (allAgents || []).find((a) => a && a.id === pid)
    return (found && found.name) || pid || '—'
  } catch (e) { return '—' }
}

function UfficiTab(props) {
  useUfficiStyles()
  const offices = (props && props.offices) || []
  const agents = (props && props.agents) || []
  const chats = (props && props.chats) || []
  const tasksData = (props && props.tasksData) || null
  const orchRaw = (props && props.orchData) || null
  const keeperRaw = (props && props.keeperData) || null
  const profile = (props && props.profile) || 'default'
  const [expandedIds, setExpandedIds] = useState([])
  const [zMap, setZMap] = useState({})
  const zCounter = useRef(40)
  const [selAgent, setSelAgent] = useState(null) // {officeId, agentId}
  const [orchOpen, setOrchOpen] = useState(false)
  const [keeperOpen, setKeeperOpen] = useState(false)
  const [details, setDetails] = useState({})
  const q = '?profile=' + encodeURIComponent(profile)

  const list = Array.isArray(offices) ? offices.filter((o) => o && (o.id || o.name)) : []
  const orchOffice = list.find((o) => kindOf(o) === 'orchestrator') || null
  const keeperOffice = list.find((o) => kindOf(o) === 'gatekeeper') || null
  const workers = list.filter((o) => kindOf(o) === 'worker')
  const orch = orchOffice || { id: 'orchestrator', name: 'Orchestratore' }
  const orchId = orch.id || orch.name || 'orchestrator'

  const agentOffice = useMemo(() => {
    const m = {}
    ;(agents || []).forEach((a) => { if (a && a.id) m[a.id] = a.office_id || a.office || null })
    return m
  }, [agents])

  const info = useMemo(() => {
    const m = {}
    const allAgents = agents || []
    const allChats = chats || []
    const allTasks = (tasksData && tasksData.tasks) || []
    const now = Date.now() / 1000
    const targets = workers.slice()
    if (orchOffice) targets.push(orchOffice)
    if (keeperOffice) targets.push(keeperOffice)
    targets.forEach((o) => {
      const oid = (o && (o.id || o.name)) || ''
      const ags = agentsOf(o, allAgents)
      const tids = (o && (o.active_task_ids || o.task_ids)) || null
      const tks = (allTasks || []).filter((t) => {
        if (!t || typeof t !== 'object') return false
        if (Array.isArray(tids) && tids.indexOf(t.id) >= 0) return true
        return t.office_id === oid || t.office === oid
      })
      const idset = {}
      ags.forEach((a) => { if (a && a.id) idset[a.id] = true })
      const lch = (allChats || []).filter((c) => ((c && c.participants) || []).some((pid) => idset[pid]))
      let live = false
      lch.forEach((c) => {
        const msgs = (c && c.messages) || []
        if (!msgs.length) return
        if ((now - msgTs(msgs[msgs.length - 1])) < 10) live = true
      })
      const flash = Boolean((o && (o.bench_flash || o.chat_active || o.flash)) || live)
      const active = ags.length > 0 || (o && o.status === 'active') || flash
      m[oid] = { agents: ags, tasks: tks, chats: lch, flash, active }
    })
    return m
  }, [offices, agents, chats, tasksData])

  const stOf = (oid) => (info && info[oid]) || { agents: [], tasks: [], chats: [], flash: false, active: false }

  /* Edge v0.4.1 — SOLO connessioni vive, zero collegamenti fantasma --------
   * Una linea esiste solo se: chat OPEN con ultimo messaggio <5min, oppure
   * flag live dal backend (chat_active/live/is_active/active). Coppie non
   * attive = NESSUN path (nemmeno tratteggiato tenue). */
  const edges = useMemo(() => {
    const wids = {}
    workers.forEach((w) => { wids[w.id || w.name] = true })
    const pairs = {}
    const pairChat = {}
    ;(chats || []).forEach((c) => {
      const msgs = (c && c.messages) || []
      if (!msgs.length) return
      const offs = {}
      ;((c && c.participants) || []).forEach((pid) => { if (agentOffice[pid] && wids[agentOffice[pid]]) offs[agentOffice[pid]] = true })
      const l = Object.keys(offs)
      for (let i = 0; i < l.length; i++) {
        for (let j = i + 1; j < l.length; j++) {
          const k = l[i] < l[j] ? l[i] + '|' + l[j] : l[j] + '|' + l[i]
          pairs[k] = (pairs[k] || 0) + msgs.length
          if (!pairChat[k]) pairChat[k] = c
        }
      }
    })
    const now = Date.now() / 1000
    const out = []
    Object.keys(pairs).forEach((k, i) => {
      const parts = k.split('|')
      const c = pairChat[k] || {}
      const msgs = (c && c.messages) || []
      const lastT = msgs.length ? msgTs(msgs[msgs.length - 1]) : 0
      const recent = lastT > 0 && (now - lastT) < 300 // ultimo messaggio <5min
      const closed = Boolean(c && (c.closed === true || c.open === false || c.status === 'closed' || c.state === 'closed'))
      const backendLive = Boolean(c && (c.chat_active === true || c.live === true || c.is_active === true || c.active === true))
      if (!((!closed && recent) || backendLive)) return // uffici sconnessi: zero collegamenti
      out.push({ a: parts[0], b: parts[1], weight: pairs[k], chatId: (c && c.id) || null, label: (c && c.name) || '', key: 'e' + i, active: true })
    })
    return out
  }, [chats, agentOffice, offices])

  const wids = workers.map((w) => w.id || w.name)
  const activeIds = wids.filter((id) => stOf(id).active)
  const layout = useWorkerLayout(wids, edges, expandedIds, activeIds)
  const pos = layout.pos
  const expandedKey = (expandedIds || []).slice().sort().join(',')
  const activeSig = (activeIds || []).slice().sort().join(',')
  const isExpanded = (oid) => (expandedIds || []).indexOf(oid) >= 0
  const toggleExpand = (oid) => {
    try {
      const has = (expandedIds || []).indexOf(oid) >= 0
      if (has) setExpandedIds((prev) => (prev || []).filter((x) => x !== oid))
      else {
        setExpandedIds((prev) => [...(prev || []), oid])
        zCounter.current += 1
        const z = zCounter.current
        setZMap((prev) => ({ ...(prev || {}), [oid]: z }))
        setSelAgent(null)
      }
      setTimeout(() => { try { layout.kick() } catch (e) { /* motore non pronto */ } }, 30)
    } catch (e) { /* toggle mai fatale */ }
  }
  const collapse = (oid) => {
    try {
      setExpandedIds((prev) => (prev || []).filter((x) => x !== oid))
      setTimeout(() => { try { layout.kick() } catch (e) { /* noop */ } }, 30)
    } catch (e) { /* noop */ }
  }

  useEffect(() => {
    const missing = (expandedIds || []).filter((id) => !(details && details[id]))
    if (!missing.length) return undefined
    let alive = true
    missing.forEach((id) => {
      api('/offices/' + encodeURIComponent(id) + '/detail' + q)
        .then((d) => { if (alive) setDetails((prev) => ({ ...(prev || {}), [id]: d })) })
        .catch(() => { if (alive) setDetails((prev) => ({ ...(prev || {}), [id]: { _missing: true } })) })
    })
    return () => { alive = false }
  }, [expandedKey, q])

  /* Firma dati leggera: kick motore solo su cambi reali, mai ricalcolo su poll */
  const edgesSig = (edges || []).map((e) => e.a + '|' + e.b).join(',')
  const dataSig = (agents || []).length + ':' + (chats || []).reduce((n, c) => n + (((c && c.messages) || []).length), 0) + ':' + (((tasksData && tasksData.tasks) || []).length)
  useEffect(() => {
    try { layout.kick() } catch (e) { /* motore non pronto */ }
  }, [edgesSig, expandedKey, activeSig, dataSig, details])

  const openChat = (c, wantOpen) => {
    try {
      const id = c && c.id
      if (!id) return
      api('/chats/' + id + (wantOpen ? '/open' : '/close'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      }).catch(() => { /* best-effort, il poll aggiorna */ })
    } catch (e) { /* mai crash per un toggle chat */ }
  }

  /* Dati orchestratore (da /orchestrator con fallback all'ufficio) ---------- */
  const orchD = (orchRaw && (orchRaw.orchestrator || orchRaw.data || orchRaw)) || {}
  const orchGoal = (orchD && (orchD.goal || orchD.current_goal)) || (orchOffice && orchOffice.goal) || ''
  const orchSubs = ((orchD && (orchD.subtasks || orchD.steps || orchD.missions)) || [])
  let orchDone = (orchD && (orchD.done != null ? orchD.done : null))
  let orchTotal = (orchD && (orchD.total != null ? orchD.total : null))
  if (orchDone == null || orchTotal == null) {
    orchTotal = orchSubs.length || null
    orchDone = orchSubs.filter((s) => s && (s.done || s.status === 'done' || Number(s.progress || 0) >= 1)).length
  }
  const orchPct = orchTotal ? Math.min(100, Math.max(0, Math.round((orchDone / orchTotal) * 100))) : 0
  const orchChats = stOf(orchId).chats

  /* Dati keeper (da /gatekeeper/state con fallback) -------------------------- */
  const keepD = (keeperRaw && (keeperRaw.gatekeeper || keeperRaw.state || keeperRaw.data || keeperRaw)) || {}
  const keepRows = []
  ;['status', 'state', 'files', 'locks', 'indexed', 'last_sync', 'updated_at'].forEach((k) => {
    if (keepD && keepD[k] !== undefined && keepD[k] !== null && keepD[k] !== '') {
      keepRows.push({ k, v: typeof keepD[k] === 'object' ? JSON.stringify(keepD[k]).slice(0, 80) : String(keepD[k]).slice(0, 80) })
    }
  })

  const cardBase = 'uff-card flex flex-col gap-1.5 p-2 select-none'

  const renderWorker = (o) => {
    const oid = o.id || o.name
    const st = stOf(oid)
    const p = (pos && pos[oid]) || { x: 50, y: 60 }
    const expanded = isExpanded(oid)
    const ags = st.agents || []
    const shown = expanded ? ags.slice(0, 8) : ags.slice(0, 4)
    const extra = ags.length - shown.length
    const tks = (st.tasks || []).filter(isCurrentTask).slice(0, expanded ? 6 : 3)
    const borderCol = st.flash
      ? 'var(--ui-success, ' + UFF_GREEN + ')'
      : (st.active ? 'var(--accent, var(--ui-accent))' : 'var(--border, var(--ui-stroke-secondary))')
    const det = (details && details[oid]) || null
    const detMsgs = []
    try {
      ;(st.chats || []).forEach((c) => {
        ;((c && c.messages) || []).slice(-5).forEach((m) => detMsgs.push({ c, m }))
      })
    } catch (e) { /* preview chat opzionale */ }
    const z = expanded ? (zMap[oid] || 40) : 10
    const wid = expanded ? 420 : 250
    let X0 = 800
    let Y0 = 500
    try {
      const s = { w: 800, h: 500 }
      X0 = Math.round((p.x / 100) * s.w)
      Y0 = Math.round((p.y / 100) * s.h)
    } catch (e) { /* fallback */ }
    return jsx('div', {
      key: oid,
      ref: (el) => { try { if (el) layout.cardEls.current[oid] = el; else delete layout.cardEls.current[oid] } catch (e) { /* noop */ } },
      onMouseDown: (ev) => { try { layout.startDrag(oid, ev) } catch (e) { /* drag mai fatale */ } },
      onClick: (ev) => { try { if (layout.consumeSuppress(oid)) { ev.stopPropagation(); return } } catch (e) { /* noop */ } },
      className: cardBase + (st.flash ? ' uff-flash' : (st.active ? ' uff-active' : '')) + ' absolute',
      style: {
        left: 0, top: 0,
        transform: 'translate3d(' + X0 + 'px,' + Y0 + 'px,0) translate(-50%,-50%)',
        width: wid, maxWidth: 'calc(100% - 16px)', zIndex: z,
        maxHeight: expanded ? 480 : undefined, overflow: expanded ? 'auto' : 'visible',
        background: 'var(--card)', opacity: 1, color: 'var(--foreground, var(--ui-text-primary))',
        border: '1px solid ' + (expanded ? 'var(--accent, var(--ui-accent))' : borderCol), borderRadius: 10,
        boxShadow: expanded ? '0 14px 36px rgba(0,0,0,.32)' : 'none',
        cursor: 'grab',
      },
      children: [
        jsx('div', {
          key: 'hh', className: 'flex items-center gap-1.5 cursor-pointer',
          onClick: (ev) => {
            try { if (layout.consumeSuppress(oid)) return } catch (e) { /* noop */ }
            ev.stopPropagation()
            toggleExpand(oid)
          },
          children: [
            officeHead(o, st),
            expanded ? jsx('span', { key: 'zx', className: 'ml-auto text-[0.6rem] text-(--ui-text-quaternary)', children: '— riduci' }) : null,
          ],
        }),
        shown.length
          ? (expanded
            ? jsxs('div', {
              key: 'ag', className: 'flex flex-col gap-1',
              children: shown.map((a) => {
                const m = (a && typeof a === 'object') ? a : {}
                const rawFull = m.activity || m.goal || m.current_task || m.task || m.last_output || m.output || 'in attesa di mansione'
                return jsxs('button', {
                  key: m.id || m.name, type: 'button', title: 'Apri sessione agente',
                  onClick: (ev) => { ev.stopPropagation(); setSelAgent({ officeId: oid, agentId: m.id || m.name }) },
                  className: 'uff-agent w-full text-left rounded-md px-1.5 py-1 hover:bg-(--chrome-action-hover) transition-colors flex flex-col gap-px',
                  children: [
                    jsxs('div', {
                      key: 'r', className: 'flex items-baseline gap-1.5',
                      children: [
                        jsx('span', { key: 'n', className: 'text-[0.72rem] font-medium truncate', children: m.name || m.id || '—' }),
                        m.model || m.llm || m.engine ? jsx('span', { key: 'mo', className: 'ml-auto text-[0.6rem] text-(--ui-text-quaternary) truncate shrink-0', children: String(m.model || m.llm || m.engine).slice(0, 24) }) : null,
                      ],
                    }),
                    jsx('div', { key: 'p', className: 'text-[0.65rem] text-(--ui-text-tertiary) leading-snug break-words', children: String(rawFull || '').slice(0, 220) }),
                  ],
                })
              }),
            })
            : jsxs('div', { key: 'ag', className: 'flex flex-col gap-0.5', children: shown.map((a) => agentMini(a, (picked) => setSelAgent({ officeId: oid, agentId: picked.id || picked.name }))) }))
          : jsx('div', { key: 'na', className: 'text-[0.65rem] text-(--ui-text-quaternary)', children: 'Nessun agente attivo' }),
        extra > 0 ? jsx('div', { key: 'more', className: 'text-[0.62rem] text-(--ui-text-quaternary)', children: '+' + extra + ' altri' }) : null,
        tks.length
          ? (expanded
            ? jsxs('div', {
              key: 'tk', className: 'flex flex-col gap-1',
              children: tks.map((t) => {
                const m = (t && typeof t === 'object') ? t : {}
                const color = m.color || 'var(--accent, var(--ui-accent))'
                const desc = m.description || m.preview || m.status || ''
                return jsxs('div', {
                  key: m.id || m.title, className: 'rounded px-1.5 py-1 border border-(--ui-stroke-secondary)',
                  style: { borderLeft: '3px solid ' + color },
                  children: [
                    jsx('div', { key: 't', className: 'text-[0.68rem] font-medium leading-snug break-words', children: m.title || m.id || '—' }),
                    desc ? jsx('div', { key: 'p', className: 'text-[0.65rem] text-(--ui-text-tertiary) leading-snug break-words', children: String(desc).slice(0, 300) }) : null,
                  ],
                })
              }),
            })
            : jsxs('div', { key: 'tk', className: 'flex flex-col gap-1', children: tks.map((t) => taskMini(t)) }))
          : jsx('div', { key: 'ntk', className: 'text-[0.65rem] text-(--ui-text-quaternary)', children: '— Task: niente in esecuzione ora' }),
        expanded ? jsxs('div', {
          key: 'x', className: 'flex flex-col gap-1.5 pt-1 border-t border-(--ui-stroke-secondary)',
          onClick: (ev) => ev.stopPropagation(),
          onMouseDown: (ev) => ev.stopPropagation(),
          children: [
            jsxs('div', {
              key: 'xh', className: 'flex items-center gap-1.5',
              children: [
                jsx('span', { key: 't', className: 'text-[0.62rem] uppercase tracking-wide text-(--ui-text-quaternary) flex-1', children: 'Dettaglio ufficio' }),
                jsx(Button, { key: 'c', size: 'sm', variant: 'ghost', type: 'button', onClick: () => collapse(oid), children: 'Chiudi' }),
              ],
            }),
            det && !det._missing && det.goal ? jsx('div', { key: 'g', className: 'text-[0.68rem] text-(--ui-text-secondary) leading-snug break-words', children: String(det.goal).slice(0, 500) }) : null,
            jsxs('div', {
              key: 'ch', className: 'flex flex-col gap-1',
              children: [
                jsx('div', { key: 't', className: 'text-[0.62rem] uppercase tracking-wide text-(--ui-text-quaternary)', children: 'Chat collegate' }),
                (st.chats || []).length
                  ? (st.chats || []).slice(0, 6).map((c) => jsxs('div', {
                    key: (c && c.id) || (c && c.name), className: 'flex items-center gap-1.5',
                    onMouseDown: (ev) => ev.stopPropagation(),
                    children: [
                      jsx('span', { key: 'n', className: 'text-[0.68rem] truncate flex-1', children: (c && c.name) || (c && c.id) || '—' }),
                      jsx('span', { key: 'c', className: 'text-[0.6rem] text-(--ui-text-quaternary)', children: '' + ((c && c.messages) || []).length }),
                      jsx(Button, {
                        key: 'b', size: 'sm', variant: 'ghost', type: 'button',
                        onClick: () => openChat(c, Boolean(c && (c.open === false || c.closed))),
                        children: (c && (c.open === false || c.closed)) ? 'Apri' : 'Chiudi',
                      }),
                    ],
                  }))
                  : jsx('div', { key: 'nc', className: 'text-[0.65rem] text-(--ui-text-quaternary)', children: 'Nessuna chat' }),
              ],
            }),
            detMsgs.length ? jsxs('div', {
              key: 'th', className: 'flex flex-col gap-1 rounded-md border border-(--ui-stroke-secondary) p-1.5',
              children: [
                jsx('div', { key: 't', className: 'text-[0.62rem] uppercase tracking-wide text-(--ui-text-quaternary)', children: 'Attività interna' }),
                ...detMsgs.slice(-5).map((r, i) => jsxs('div', {
                  key: 'm' + i, children: [
                    jsx('div', { key: 'w', className: 'text-[0.6rem] text-(--ui-text-quaternary)', children: agentByIdSafe(agents, r.m) }),
                    jsx('div', { key: 'x', className: 'text-[0.68rem] text-(--ui-text-secondary) leading-snug break-words', children: String((r.m && r.m.text) || '').slice(0, 220) }),
                  ],
                })),
              ],
            }) : null,
          ],
        }) : null,
      ],
    })
  }


  /* Popover sessione agente v0.4.3 (click-only, ancorato alla card) ---------- */
  const popAgent = selAgent ? (stOf(selAgent.officeId).agents || []).find((a) => a && ((a.id || a.name) === selAgent.agentId)) || null : null
  const popDet = (selAgent && details && details[selAgent.officeId]) || null
  const popDetAgents = (popDet && (popDet.agents || popDet.sessions)) || []
  const popDetA = popDetAgents.find((a) => a && ((a.id || a.name) === (selAgent && selAgent.agentId))) || {}
  function lastLinesOf(v, n) {
    try {
      const lines = String(v == null ? '' : v).split('\n').map((s) => (s || '').trim()).filter(Boolean)
      return lines.slice(-(n || 4))
    } catch (e) { return [] }
  }
  // Activity corrente (/agents): ultima riga utile (output:/thinking: se presenti)
  const popActLines = lastLinesOf((popAgent && (popAgent.activity || popAgent.last_output || popAgent.output)) || (popDetA && (popDetA.activity || popDetA.last_output || popDetA.output)) || '', 6)
  const popActivity = popActLines.length ? popActLines[popActLines.length - 1] : ''
  // Task corrente: match agente su /tasks, fallback active_task_ids ufficio
  const popAllTasks = ((tasksData && tasksData.tasks) || [])
  const popAid = (selAgent && selAgent.agentId) || null
  const popAgentTasks = popAllTasks.filter((t) => t && typeof t === 'object' && popAid && (t.assignee === popAid || t.assignee_id === popAid || t.agent_id === popAid || t.agent === popAid))
  const popOffice = selAgent ? list.find((o) => o && ((o.id || o.name) === selAgent.officeId)) || null : null
  const popOfficeTaskIds = (popOffice && (popOffice.active_task_ids || popOffice.task_ids)) || []
  const popOfficeTasks = popAllTasks.filter((t) => t && popOfficeTaskIds.indexOf(t.id) >= 0)
  const popTaskRows = (popAgentTasks.length ? popAgentTasks : popOfficeTasks).slice(0, 2)
  // Ultime righe output: last_output/output, altrimenti 'in attesa di output…'
  const popOutLines = lastLinesOf((popAgent && (popAgent.last_output || popAgent.output)) || (popDetA && (popDetA.last_output || popDetA.output)) || (popDetA && Array.isArray(popDetA.lines) ? popDetA.lines.join('\n') : '') || '', 4)
  const popOut = popOutLines.length ? popOutLines.join('\n') : ''
  // Anchor: segue la card via misura DOM (expand-safe), fallback a pos
  const [popXY, setPopXY] = useState(null)
  useEffect(() => {
    if (!selAgent) { setPopXY(null); return undefined }
    let alive = true
    const update = () => {
      try {
        const area = layout.areaEl.current
        const card = layout.cardEls.current[selAgent.officeId]
        if (!area || !card) return
        const ar = area.getBoundingClientRect()
        const cr = card.getBoundingClientRect()
        if (!ar || !cr || ar.width < 10) return
        if (alive) setPopXY({ x: ((cr.left - ar.left + cr.width / 2) / ar.width) * 100, y: ((cr.top - ar.top + cr.height / 2) / ar.height) * 100 })
      } catch (e) { /* best-effort */ }
    }
    update()
    const t = setTimeout(update, 250)
    return () => { alive = false; clearTimeout(t) }
  }, [selAgent, expandedKey, dataSig])
  const popBase = popXY || ((selAgent && pos && pos[selAgent.officeId]) ? pos[selAgent.officeId] : null)
  const popAnchor = popBase
    ? { x: Math.min(86, popBase.x + 14), y: Math.min(76, popBase.y + 16) }
    : null
  const popCard = popBase
    ? { x: popBase.x, y: popBase.y }
    : null

  return jsxs('div', {
    className: 'flex h-full flex-col gap-2 p-2 overflow-auto',
    children: [
      /* Top row: Orchestratore + Knowledge Keeper (fissi) -------------------- */
      jsxs('div', {
        key: 'top', className: 'flex gap-2 shrink-0',
        children: [
          jsxs('div', {
            key: 'orch',
            onClick: () => setOrchOpen(!orchOpen),
            className: cardBase + ' flex-1',
            style: {
              background: 'var(--card)', borderRadius: 10,
              border: '1px solid ' + (orchOpen ? 'var(--accent, var(--ui-accent))' : 'var(--border, var(--ui-stroke-secondary))'),
            },
            children: [
              officeHead(orch, { active: true, flash: false }),
              (!orchGoal && !orchOpen) ? jsx('div', { key: 's', className: 'text-[0.65rem] text-(--ui-text-quaternary)', children: 'Sorveglia gli uffici worker' }) : null,
              orchOpen ? jsxs('div', {
                key: 'd', className: 'flex flex-col gap-1.5', onClick: (ev) => ev.stopPropagation(),
                children: [
                  jsx('div', { key: 'g', className: 'text-[0.7rem] text-(--ui-text-secondary) leading-snug', children: orchGoal ? String(orchGoal).slice(0, 300) : 'Goal corrente non disponibile' }),
                  orchTotal ? jsxs('div', {
                    key: 'p', className: 'flex flex-col gap-1',
                    children: [
                      jsx('div', { key: 'l', className: 'text-[0.62rem] text-(--ui-text-tertiary)', children: 'Avanzamento globale: ' + orchDone + '/' + orchTotal + ' (' + orchPct + '%)' }),
                      jsx('div', {
                        key: 'bar', className: 'h-1.5 rounded-full bg-(--ui-stroke-secondary) overflow-hidden',
                        children: jsx('div', { className: 'h-full bg-(--ui-accent)', style: { width: orchPct + '%' } }),
                      }),
                      ...(orchSubs || []).slice(0, 5).map((s, i) => jsx('div', {
                        key: 's' + i, className: 'text-[0.65rem] text-(--ui-text-tertiary) truncate',
                        children: ((s && (s.done || s.status === 'done')) ? '✓ ' : '· ') + ((s && (s.name || s.title)) || ('Passo ' + (i + 1))),
                      })),
                    ],
                  }) : jsx('div', { key: 'np', className: 'text-[0.65rem] text-(--ui-text-quaternary)', children: 'Nessun sotto-task riportato' }),
                  jsxs('div', {
                    key: 'c', className: 'flex flex-col gap-0.5',
                    children: [
                      jsx('div', { key: 't', className: 'text-[0.62rem] uppercase tracking-wide text-(--ui-text-quaternary)', children: 'Chat attive con uffici' }),
                      orchChats.length
                        ? orchChats.slice(0, 4).map((c) => jsx('div', { key: (c && c.id) || (c && c.name), className: 'text-[0.68rem] text-(--ui-text-secondary) truncate', children: ((c && c.name) || (c && c.id) || '—') + ' · ' + ((c && c.messages) || []).length + ' messaggi' }))
                        : [jsx('div', { key: 'nc', className: 'text-[0.65rem] text-(--ui-text-quaternary)', children: 'Nessuna chat attiva' })],
                    ],
                  }),
                ],
              }) : null,
            ],
          }),
          jsxs('div', {
            key: 'keep',
            onClick: () => setKeeperOpen(!keeperOpen),
            className: cardBase + ' w-64',
            style: {
              background: 'var(--card)', borderRadius: 10,
              border: '1px solid ' + (keeperOpen ? 'var(--accent, var(--ui-accent))' : 'var(--border, var(--ui-stroke-secondary))'),
            },
            children: [
              officeHead(keeperOffice || { id: 'keeper', name: 'Knowledge Keeper' }, { active: false, flash: false }),
              !keeperOpen ? jsx('div', { key: 's', className: 'text-[0.65rem] text-(--ui-text-quaternary)', children: 'Archivio e memoria condivisa' }) : null,
              keeperOpen ? jsxs('div', {
                key: 'd', className: 'flex flex-col gap-1', onClick: (ev) => ev.stopPropagation(),
                children: keepRows.length
                  ? keepRows.slice(0, 6).map((r) => jsxs('div', {
                    key: r.k, className: 'flex items-baseline gap-2',
                    children: [
                      jsx('span', { key: 'k', className: 'text-[0.62rem] uppercase tracking-wide text-(--ui-text-quaternary)', children: r.k }),
                      jsx('span', { key: 'v', className: 'text-[0.68rem] text-(--ui-text-secondary) truncate flex-1 text-right', children: r.v }),
                    ],
                  }))
                  : [jsx('div', { key: 'ns', className: 'text-[0.65rem] text-(--ui-text-quaternary)', children: 'Stato non disponibile' })],
              }) : null,
            ],
          }),
        ],
      }),
      /* Bottom: worker force-directed ---------------------------------------- */
      jsx('div', {
        key: 'area', ref: layout.areaEl, className: 'relative flex-1 min-h-[440px] rounded-md border border-(--ui-stroke-primary)',
        children: [
          jsx('svg', {
            key: 'wires', className: 'absolute inset-0 w-full h-full pointer-events-none',
            shapeRendering: 'crispEdges',
            children: [
              ...(workers || []).filter((w) => (((stOf(w.id || w.name)).agents) || []).length > 0).map((w) => {
                const p = (pos && pos[w.id || w.name]) || null
                if (!p) return null
                return jsx('path', {
                  key: 'a-' + (w.id || w.name),
                  ref: (el) => { try { if (el) layout.wireEls.current['a-' + (w.id || w.name)] = el } catch (e) { /* noop */ } },
                  d: elbowPx(Math.round((p.x / 100) * 800), Math.round((Math.max(1, p.y - 6) / 100) * 500), 400, 2),
                  fill: 'none', stroke: 'var(--border, var(--ui-stroke-secondary))', strokeWidth: 1,
                  vectorEffect: 'non-scaling-stroke', opacity: 0.55,
                })
              }),
              ...(edges || []).map((e) => {
                const A = (pos && pos[e.a]) || null
                const B = (pos && pos[e.b]) || null
                if (!A || !B) return null
                return jsx('path', {
                  key: e.key,
                  ref: (el) => { try { if (el) layout.wireEls.current[e.key] = el } catch (er) { /* noop */ } },
                  d: elbowPx(Math.round((A.x / 100) * 800), Math.round((A.y / 100) * 500), Math.round((B.x / 100) * 800), Math.round((B.y / 100) * 500)),
                  fill: 'none', className: 'uff-chatline', stroke: 'var(--ui-success, ' + UFF_GREEN + ')',
                  strokeWidth: 2, vectorEffect: 'non-scaling-stroke', opacity: 0.9,
                })
              }),
              (popAnchor && popCard) ? jsx('path', {
                key: 'pop', d: elbowPx(Math.round((popCard.x / 100) * 800), Math.round((popCard.y / 100) * 500), Math.round((popAnchor.x / 100) * 800), Math.round((popAnchor.y / 100) * 500)), fill: 'none',
                stroke: 'var(--border, var(--ui-stroke-secondary))', strokeWidth: 1,
                vectorEffect: 'non-scaling-stroke', opacity: 0.7,
              }) : null,
            ],
          }),
          ...(workers || []).map((w) => renderWorker(w)),
          !(workers || []).length ? jsx('div', {
            key: 'empty', className: 'absolute inset-0 flex items-center justify-center',
            children: jsx(EmptyState, { label: 'Nessun ufficio worker' }),
          }) : null,
          (selAgent && popAgent && popAnchor) ? jsx('div', {
            key: 'popbd', className: 'absolute inset-0',
            style: { zIndex: 40, background: 'transparent', cursor: 'default' },
            onClick: () => setSelAgent(null),
          }) : null,
          (selAgent && popAgent && popAnchor) ? jsxs('div', {
            key: 'pop',
            className: 'uff-card uff-pop absolute flex flex-col gap-1 p-2',
            onClick: (ev) => ev.stopPropagation(),
            style: {
              left: popAnchor.x + '%', top: popAnchor.y + '%', transform: 'translate(-50%,-50%)',
              width: 280, maxWidth: 'calc(100% - 16px)', zIndex: 60, background: 'var(--card)', opacity: 1, borderRadius: 10,
              border: '1px solid var(--accent, var(--ui-accent))',
            },
            children: [
              jsxs('div', {
                key: 'h', className: 'flex items-center gap-1.5',
                children: [
                  jsx(StatusDot, { key: 'd', state: dotFor(popAgent.state) }),
                  jsx('span', { key: 'n', className: 'text-[0.72rem] font-medium truncate flex-1', children: popAgent.name || popAgent.id || '—' }),
                  jsx(Button, { key: 'x', size: 'sm', variant: 'ghost', type: 'button', onClick: () => setSelAgent(null), children: '✕' }),
                ],
              }),
              jsx('div', { key: 'mo', className: 'text-[0.6rem] text-(--ui-text-quaternary)', children: ((popAgent.model || popAgent.llm || popAgent.engine) || 'modello n/d') + (popAgent.state ? ' · ' + popAgent.state : '') }),
              jsx('div', { key: 'acl', className: 'text-[0.6rem] uppercase tracking-wide text-(--ui-text-quaternary)', children: 'Activity corrente' }),
              jsx('div', { key: 'ac', className: 'text-[0.68rem] text-(--ui-text-secondary) leading-snug break-words', children: String(popActivity || popAgent.goal || 'in attesa di mansione').slice(0, 200) }),
              popTaskRows.length ? jsxs('div', {
                key: 'tks', className: 'flex flex-col gap-0.5',
                children: [
                  jsx('div', { key: 't', className: 'text-[0.6rem] uppercase tracking-wide text-(--ui-text-quaternary)', children: 'Task corrente' }),
                  ...popTaskRows.map((t, i) => jsx('div', {
                    key: 'tk' + i, className: 'text-[0.65rem] text-(--ui-text-tertiary) truncate',
                    children: '· ' + String((t && (t.title || t.id)) || '—').slice(0, 120) + ((t && (t.status || t.state)) ? ' (' + (t.status || t.state) + ')' : ''),
                  })),
                ],
              }) : null,
              jsxs('div', {
                key: 'out', className: 'rounded border border-(--ui-stroke-secondary) p-1.5 flex flex-col gap-0.5',
                children: [
                  jsx('div', { key: 't', className: 'text-[0.6rem] uppercase tracking-wide text-(--ui-text-quaternary)', children: 'Ultime righe output' }),
                  jsx('pre', { key: 'p', className: 'text-[0.65rem] text-(--ui-text-secondary) whitespace-pre-wrap break-all max-h-28 overflow-auto', children: String(popOut || 'in attesa di output…').slice(0, 600) }),
                ],
              }),
            ],
          }) : null,
        ],
      }),
    ],
  })
}

function ChatTab({ chats, agents }) {
  const [selId, setSelId] = useState(null)
  const byId = useMemo(() => {
    const m = {}
    ;(agents || []).forEach((a) => { m[a.id] = a })
    return m
  }, [agents])
  const list = chats || []
  const sel = list.find((c) => c.id === selId) || null
  return jsxs('div', {
    className: 'flex h-full gap-2 p-2',
    children: [
      jsxs('div', {
        key: 'list', className: 'w-56 shrink-0 flex flex-col gap-1.5 overflow-auto',
        children: list.length ? list.map((c) => jsxs('button', {
          key: c.id, type: 'button',
          onClick: () => setSelId(c.id),
          className: cn('text-left rounded-md border px-2 py-1.5 transition-colors',
            selId === c.id ? 'border-(--ui-accent)' : 'border-(--ui-stroke-secondary) hover:bg-(--chrome-action-hover)'),
          children: [
            jsx('div', { key: 'n', className: 'text-xs font-medium truncate', children: (c.type === 'group' ? '# ' : '@ ') + c.name }),
            jsx('div', { key: 'c', className: 'text-[0.6rem] text-(--ui-text-quaternary)', children: (c.messages || []).length + ' messaggi' }),
          ],
        })) : [jsx(EmptyState, { key: 'e', label: 'Nessuna chat attiva' })],
      }),
      jsx('div', {
        key: 'thread', className: 'flex-1 overflow-auto flex flex-col gap-1.5 rounded-md border border-(--ui-stroke-primary) p-2',
        children: sel
          ? (sel.messages || []).map((m) => jsxs('div', {
            key: m.id || ('' + m.ts + m.from_agent_id), children: [
              jsx('div', { key: 'w', className: 'text-[0.6rem] text-(--ui-text-quaternary)', children: agentName(byId, m.from_agent_id) }),
              jsx('div', { key: 'x', className: 'text-xs text-(--ui-text-secondary)', children: m.text }),
            ],
          }))
          : jsx(EmptyState, { key: 'e', label: 'Seleziona una chat' }),
      }),
    ],
  })
}

/* Automazioni: righe + dettaglio in italiano non-tecnico ------------------ */
function autoStepsFallback(a) {
  const src = (a || {}).source === 'hermes_cron' ? 'un controllo pianificato del sistema' : 'il motore interno delle automazioni'
  const steps = []
  steps.push({ t: 'Quando parte', d: (a || {}).schedule_raw ? 'Si attiva con questa cadenza: ' + a.schedule_raw + '.' : 'Parte quando serve (nessuna cadenza impostata).' })
  steps.push({ t: 'Cosa fa', d: 'È ' + src + ' e si chiama «' + ((a || {}).name || (a || {}).id || '—') + '».' })
  if ((a || {}).office_id) steps.push({ t: 'Chi se ne occupa', d: 'Ufficio di riferimento: ' + a.office_id + '.' })
  const st = (a || {}).last_run_status
    ? 'Ultima esecuzione: ' + ((a || {}).last_run_status === 'ok' ? 'tutto bene' : a.last_run_status)
    : 'Non risulta ancora eseguita'
  const when = fmtLastRunIt((a || {}).last_run_at || (a || {}).last_run_ts)
  steps.push({ t: 'Stato', d: st + ' (' + when + ').' + ((a || {}).enabled ? ' Al momento è accesa.' : ' Al momento è spenta.') })
  return steps
}

function AutomationsTab({ automations, profile }) {
  const [selId, setSelId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailErr, setDetailErr] = useState(null)
  const [rows, setRows] = useState(automations || [])
  const [runMsg, setRunMsg] = useState(null) // {id, ok, text}
  const [running, setRunning] = useState(false)
  const [logOpen, setLogOpen] = useState(false)
  const [logText, setLogText] = useState(null)
  const [logErr, setLogErr] = useState(null)
  const [logLoading, setLogLoading] = useState(false)
  useEffect(() => { setRows(automations || []) }, [automations])
  const q = '?profile=' + encodeURIComponent(profile || 'default')
  const sel = (rows || []).find((a) => (a || {}).id === selId) || null

  useEffect(() => {
    if (!selId) { setDetail(null); setDetailErr(null); setRunMsg(null); setLogOpen(false); setLogText(null); setLogErr(null); return undefined }
    let alive = true
    setDetail(null); setDetailErr(null); setRunMsg(null); setLogOpen(false); setLogText(null); setLogErr(null)
    api('/automations/' + selId + '/detail' + q)
      .then((d) => { if (alive) setDetail(d) })
      .catch((e) => { if (alive) setDetailErr((e && (e.message || String(e))) || 'errore') })
    return () => { alive = false }
  }, [selId, profile])

  const toggle = (a) => {
    const on = !(a || {}).enabled
    setRows((prev) => (prev || []).map((r) => ((r || {}).id === (a || {}).id ? { ...r, enabled: on ? 1 : 0 } : r)))
    api('/automations/' + (a || {}).id + '/toggle?enabled=' + (on ? '1' : '0') + '&profile=' + encodeURIComponent(profile || 'default'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: on }),
    }).catch(() => {
      setRows((prev) => (prev || []).map((r) => ((r || {}).id === (a || {}).id ? { ...r, enabled: (a || {}).enabled } : r)))
    })
  }

  const runNow = (a) => {
    if (running) return
    setRunning(true); setRunMsg(null)
    api('/automations/' + (a || {}).id + '/run-now' + q, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
      .then(() => { setRunMsg({ id: (a || {}).id, ok: true, text: 'Esecuzione avviata.' }) })
      .catch((e) => {
        const m = (e && (e.message || String(e))) || 'errore'
        setRunMsg({ id: (a || {}).id, ok: false, text: /404/.test(m) ? 'Esecuzione manuale non ancora disponibile.' : 'Avvio non riuscito (' + m + ').' })
      })
      .finally(() => setRunning(false))
  }

  const loadLogs = (a) => {
    if (logOpen) { setLogOpen(false); return }
    setLogOpen(true); setLogLoading(true); setLogText(null); setLogErr(null)
    api('/automations/' + (a || {}).id + '/logs' + q)
      .then((d) => {
        if (!d || (d.logs === undefined && d.output === undefined && d.text === undefined && !Array.isArray(d))) {
          setLogErr('log non disponibile')
          return
        }
        const arr = Array.isArray(d) ? d : (d.logs || d.output || d.lines || [])
        if (Array.isArray(arr)) {
          if (!arr.length) { setLogErr('log non disponibile'); return }
          setLogText(arr.map((l) => (typeof l === 'string' ? l : (l && (l.text || l.message || JSON.stringify(l))) || '')).join('\n'))
        } else {
          const t = d.text || d.output || ''
          if (!t) { setLogErr('log non disponibile'); return }
          setLogText(String(t))
        }
      })
      .catch(() => setLogErr('log non disponibile'))
      .finally(() => setLogLoading(false))
  }

  const detailSteps = (() => {
    if (!sel) return []
    if (detail && typeof detail === 'object') {
      const arr = detail.steps || detail.composition || detail.stages || detail.passaggi || null
      if (Array.isArray(arr) && arr.length) {
        return arr.map((s, i) => {
          if (typeof s === 'string') return { t: 'Passo ' + (i + 1), d: s }
          const o = (s && typeof s === 'object') ? s : {}
          return {
            t: o.title || o.nome || o.name || ('Passo ' + (i + 1)),
            d: [o.description || o.descrizione || o.detail || '', o.script ? 'Script: ' + o.script : '', o.file ? 'File: ' + o.file : '']
              .filter(Boolean).join(' — ') || '—',
          }
        })
      }
      if (detail.description || detail.descrizione) {
        return [{ t: (sel || {}).name || 'Automazione', d: detail.description || detail.descrizione }]
      }
    }
    return autoStepsFallback(sel)
  })()

  const selLastRun = fmtLastRunIt((sel || {}).last_run_at || (sel || {}).last_run_ts)

  return jsxs('div', {
    className: 'flex h-full gap-2 p-2',
    children: [
      jsxs('div', {
        key: 'list', className: 'flex-1 flex flex-col gap-1.5 overflow-auto',
        children: (rows || []).length ? rows.map((a) => jsxs('div', {
          key: (a || {}).id || (a || {}).name,
          className: cn('rounded-md border p-2 flex items-center gap-2 cursor-pointer transition-colors',
            selId === (a || {}).id ? 'border-(--ui-accent)' : 'border-(--ui-stroke-secondary) hover:bg-(--chrome-action-hover)'),
          onClick: () => setSelId(selId === (a || {}).id ? null : (a || {}).id),
          children: [
            jsx(StatusDot, { key: 'd', state: (a || {}).enabled ? 'online' : 'idle' }),
            jsxs('div', {
              key: 'm', className: 'flex-1 min-w-0',
              children: [
                jsx('div', { key: 'n', className: 'text-xs truncate', children: (a || {}).name || (a || {}).id || '—' }),
                jsx('div', { key: 's', className: 'text-[0.6rem] text-(--ui-text-quaternary) truncate', children: ((a || {}).source === 'hermes_cron' ? 'cron' : 'motore') + ' · ' + ((a || {}).schedule_raw || 'senza cadenza') + ' · ultima: ' + fmtLastRunIt((a || {}).last_run_at || (a || {}).last_run_ts) }),
              ],
            }),
            jsx('div', { key: 'l', className: 'text-[0.6rem] text-(--ui-text-tertiary)', children: (a || {}).last_run_status === 'ok' ? 'ok' : ((a || {}).last_run_status || '—') }),
            jsx(Button, {
              key: 't', size: 'sm', variant: 'ghost', type: 'button',
              onClick: (ev) => { ev.stopPropagation(); toggle(a) },
              children: (a || {}).enabled ? 'Off' : 'On',
            }),
          ],
        })) : [jsx(EmptyState, { key: 'e', label: 'Nessuna automazione' })],
      }),
      sel ? jsxs('div', {
        key: 'detail', className: 'w-72 shrink-0 overflow-auto rounded-md border border-(--ui-stroke-primary) p-2.5 flex flex-col gap-2',
        children: [
          jsxs('div', {
            key: 'h', className: 'flex items-center gap-2',
            children: [
              jsx(StatusDot, { key: 'd', state: (sel || {}).enabled ? 'online' : 'idle' }),
              jsx('span', { key: 'n', className: 'text-xs font-medium flex-1 truncate', children: (sel || {}).name || (sel || {}).id || '—' }),
              jsx(Button, { key: 'x', size: 'sm', variant: 'ghost', type: 'button', onClick: () => setSelId(null), children: '✕' }),
            ],
          }),
          jsx('div', { key: 'lr', className: 'text-[0.65rem] text-(--ui-text-tertiary)', children: 'Ultima esecuzione: ' + selLastRun }),
          jsxs('div', {
            key: 'actions', className: 'flex items-center gap-1.5',
            children: [
              jsx(Button, { key: 'run', size: 'sm', type: 'button', onClick: () => runNow(sel), children: running ? 'Avvio…' : 'Esegui ora' }),
              jsx(Button, { key: 'log', size: 'sm', variant: 'ghost', type: 'button', onClick: () => loadLogs(sel), children: logOpen ? 'Nascondi log' : 'Log' }),
            ],
          }),
          (runMsg && runMsg.id === (sel || {}).id) ? jsx('div', { key: 'rm', className: 'text-[0.65rem] text-(--ui-text-tertiary)', children: runMsg.text }) : null,
          logOpen ? jsxs('div', {
            key: 'logbox', className: 'rounded-md border border-(--ui-stroke-secondary) p-2 flex flex-col gap-1',
            children: [
              jsx('div', { key: 'lt', className: 'text-[0.62rem] uppercase tracking-wide text-(--ui-text-quaternary)', children: 'Log' }),
              logLoading
                ? jsx('div', { key: 'll', className: 'text-[0.65rem] text-(--ui-text-quaternary)', children: 'Caricamento…' })
                : logErr
                  ? jsx('div', { key: 'le', className: 'text-[0.65rem] text-(--ui-text-quaternary)', children: logErr })
                  : jsx('pre', { key: 'lp', className: 'text-[0.65rem] text-(--ui-text-secondary) whitespace-pre-wrap break-all max-h-48 overflow-auto', children: logText || '' }),
            ],
          }) : null,
          detailErr ? jsx('div', { key: 'w', className: 'text-[0.65rem] text-(--ui-text-quaternary)', children: 'Dettaglio server non disponibile, mostro il riepilogo.' }) : null,
          ...detailSteps.map((s, i) => jsxs('div', {
            key: 's' + i, className: 'flex flex-col gap-0.5',
            children: [
              jsx('div', { key: 't', className: 'text-[0.6875rem] font-medium text-(--ui-text-secondary)', children: (i + 1) + '. ' + (s.t || '') }),
              jsx('div', { key: 'd', className: 'text-[0.7rem] text-(--ui-text-tertiary) leading-relaxed', children: s.d || '—' }),
            ],
          })),
        ],
      }) : null,
    ],
  })
}

function OutputTab() {
  const [path, setPath] = useState(ROOT)
  const [selFile, setSelFile] = useState(null)
  const { data, err } = usePoll('/files?path=' + encodeURIComponent(path), 3000)
  const entries = (data && data.entries) || []
  const crumbs = path.split('/').filter(Boolean)
  const goUp = (i) => {
    if (i < 0) { setPath('/'); setSelFile(null); return }
    setPath('/' + crumbs.slice(0, i + 1).join('/'))
    setSelFile(null)
  }
  return jsxs('div', {
    className: 'p-2.5 flex flex-col gap-2 h-full overflow-auto',
    children: [
      jsxs('div', {
        key: 'bc', className: 'flex items-center gap-1 text-[0.7rem] flex-wrap',
        children: [
          jsx('button', { key: 'root', type: 'button', onClick: () => goUp(-1), className: 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) rounded px-1', children: '/' }),
          ...crumbs.map((c, i) => jsxs('span', {
            key: 'c' + i, className: 'flex items-center gap-1',
            children: [
              jsx('span', { key: 's', className: 'text-(--ui-text-quaternary)', children: '/' }),
              jsx('button', { key: 'b', type: 'button', onClick: () => goUp(i), className: 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) rounded px-1', children: c }),
            ],
          })),
        ],
      }),
      err ? jsx(EmptyState, { key: 'e', label: 'Backend offline' }) : null,
      ...entries.map((e) => jsxs('button', {
        key: e.name, type: 'button',
        onClick: () => {
          if (e.type === 'dir') { setPath(path.replace(/\/$/, '') + '/' + e.name); setSelFile(null) }
          else setSelFile(selFile && selFile.name === e.name ? null : e)
        },
        className: cn('flex items-center gap-2 text-left text-[0.75rem] rounded px-1.5 py-1 transition-colors',
          selFile && selFile.name === e.name ? 'bg-(--chrome-action-hover)' : 'hover:bg-(--chrome-action-hover)'),
        children: [
          jsx('span', { key: 'i', className: 'text-(--ui-text-tertiary)', children: e.type === 'dir' ? '▸' : '·' }),
          jsx('span', { key: 'n', className: e.type === 'dir' ? 'text-(--ui-text-secondary)' : 'text-(--ui-text-tertiary)', children: e.name }),
          e.type === 'file' ? jsx('span', { key: 's', className: 'ml-auto text-[0.65rem] text-(--ui-text-quaternary)', children: fmtKB(e.size) }) : null,
        ],
      })),
      selFile ? jsx('div', {
        key: 'f', className: 'rounded-md border border-(--ui-stroke-secondary) p-2 text-[0.7rem] text-(--ui-text-tertiary)',
        children: selFile.name + ' · ' + fmtKB(selFile.size),
      }) : null,
    ],
  })
}

/* Progetti: kanban read-only + commenti ----------------------------------- */
function colOf(t) {
  if (!t || typeof t !== 'object') return 'backlog'
  if (t.status && KANBAN.indexOf(t.status) >= 0) return t.status
  const p = Number(t.progress || 0)
  if (p >= 1) return 'done'
  if (p >= 0.8) return 'in_review'
  if (p > 0) return 'in_progress'
  return 'backlog'
}

function synthTasks(projects) {
  const out = []
  ;(projects || []).forEach((pr) => {
    if (!pr || typeof pr !== 'object') return
    ;(pr.missions || []).forEach((m) => {
      if (!m || typeof m !== 'object') return
      out.push({
        id: m.id, project_id: pr.id, project_name: pr.name || '', title: m.title || m.id || '—',
        description: '', status: null, progress: m.progress || 0,
        assignee: m.office_id || '', priority: '—', subtasks: 0,
        comments: [], lastComment: '',
      })
    })
  })
  return out
}

function TaskDetail({ task, projectName, onClose, profile }) {
  const [remote, setRemote] = useState(null)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [sendErr, setSendErr] = useState(null)
  const [localComments, setLocalComments] = useState([])
  const qp = '?profile=' + encodeURIComponent(profile || 'default')
  useEffect(() => {
    let alive = true
    api('/tasks/' + (task || {}).id + qp)
      .then((d) => { if (alive) setRemote((d && (d.task || d)) || null) })
      .catch(() => { if (alive) setRemote(null) })
    return () => { alive = false }
  }, [(task || {}).id, profile])
  const full = { ...(task || {}), ...((remote && typeof remote === 'object') ? remote : {}) }
  const thread = [...(full.comments || []), ...localComments]
  const send = () => {
    const t = (text || '').trim()
    if (!t || sending) return
    setSending(true); setSendErr(null)
    api('/tasks/' + (task || {}).id + '/comment' + qp, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'user', text: t }),
    })
      .then(() => {
        setLocalComments((prev) => [...(prev || []), { author: 'user', text: t, ts: Date.now() / 1000 }])
        setText('')
      })
      .catch((e) => setSendErr((e && (e.message || String(e))) || 'errore'))
      .finally(() => setSending(false))
  }
  return jsxs('div', {
    className: 'w-80 shrink-0 overflow-auto rounded-md border border-(--ui-stroke-primary) p-2.5 flex flex-col gap-2',
    children: [
      jsxs('div', {
        key: 'h', className: 'flex items-center gap-2',
        children: [
          jsx(Badge, { key: 'b', variant: 'secondary', children: KANBAN_LABEL[colOf(full)] || colOf(full) }),
          jsx('span', { key: 'p', className: 'text-[0.6rem] text-(--ui-text-quaternary) truncate flex-1', children: projectName }),
          jsx(Button, { key: 'x', size: 'sm', variant: 'ghost', type: 'button', onClick: onClose, children: '✕' }),
        ],
      }),
      jsx('div', { key: 't', className: 'text-sm font-medium', children: full.title }),
      full.description ? jsx('div', { key: 'd', className: 'text-[0.72rem] text-(--ui-text-secondary) leading-relaxed', children: full.description }) : null,
      jsx('div', {
        key: 'meta', className: 'text-[0.65rem] text-(--ui-text-tertiary)',
        children: 'Assegnato a ' + (full.assignee || full.assignee_name || '—') + ' · priorità ' + (full.priority || '—') + ' · ' + (full.subtasks != null ? full.subtasks : 0) + ' sotto-attività',
      }),
      jsx('div', { key: 'ch', className: 'text-[0.6875rem] uppercase tracking-wide text-(--ui-text-tertiary)', children: 'Commenti' }),
      ...(thread.length ? thread.map((c, i) => jsxs('div', {
        key: 'c' + i, className: 'rounded border border-(--ui-stroke-secondary) px-1.5 py-1',
        children: [
          jsx('div', { key: 'w', className: 'text-[0.6rem] text-(--ui-text-quaternary)', children: (c.author || c.user || '—') }),
          jsx('div', { key: 'x', className: 'text-[0.72rem] text-(--ui-text-secondary)', children: c.text || c.body || '' }),
        ],
      })) : [jsx('div', { key: 'nc', className: 'text-[0.7rem] text-(--ui-text-quaternary)', children: 'Nessun commento.' })]),
      jsxs('div', {
        key: 'box', className: 'flex gap-1.5',
        children: [
          jsx('input', {
            key: 'i', type: 'text', value: text,
            onChange: (ev) => setText(ev.target.value),
            onKeyDown: (ev) => { if (ev.key === 'Enter') send() },
            placeholder: 'Scrivi un commento…',
            className: 'flex-1 min-w-0 rounded border border-(--ui-stroke-secondary) bg-transparent px-2 py-1 text-xs text-(--ui-text-secondary)',
          }),
          jsx(Button, { key: 's', size: 'sm', type: 'button', onClick: send, children: sending ? '…' : 'Invia' }),
        ],
      }),
      sendErr ? jsx('div', { key: 'e', className: 'text-[0.65rem] text-(--ui-text-quaternary)', children: 'Invio non riuscito (' + sendErr + ').' }) : null,
    ],
  })
}

function ProjectsTab({ projects, tasksData, agents, offices, profile }) {
  const [selId, setSelId] = useState(null)
  const agentById = useMemo(() => {
    const m = {}
    ;(agents || []).forEach((a) => { m[a.id] = a })
    return m
  }, [agents])
  const officeName = useMemo(() => {
    const m = {}
    ;(offices || []).forEach((o) => { m[o.id] = o.name })
    return m
  }, [offices])
  const tasks = useMemo(() => {
    const raw = tasksData && tasksData.tasks
    const base = Array.isArray(raw) && raw.length ? raw : synthTasks(projects)
    const empty = !Array.isArray(raw) || !raw.length
    return base.map((t) => {
      const last = (t.comments || []).length ? (t.comments[t.comments.length - 1].text || t.comments[t.comments.length - 1].body || '') : (t.lastComment || '')
      const assignee = empty
        ? (officeName[t.assignee] || t.assignee || '—')
        : (t.assignee_name || agentById[t.assignee] || agentById[t.assignee_id] || t.assignee || officeName[t.office_id] || '—')
      return {
        ...t,
        project_name: t.project_name || ((projects || []).find((p) => p.id === t.project_id) || {}).name || '',
        assignee: typeof assignee === 'object' ? (assignee.name || '—') : (assignee || '—'),
        lastSnippet: last,
      }
    })
  }, [tasksData, projects, agentById, officeName])
  const grouped = useMemo(() => {
    const g = {}
    KANBAN.forEach((k) => { g[k] = [] })
    const byProj = {}
    tasks.forEach((t) => {
      const k = (t.project_id || '') + '|' + (t.project_name || '')
      if (!byProj[k]) byProj[k] = { name: t.project_name || 'Senza progetto', cols: {} }
      const c = colOf(t)
      if (!byProj[k].cols[c]) byProj[k].cols[c] = []
      byProj[k].cols[c].push(t)
    })
    Object.keys(byProj).forEach((k) => { g._order = g._order || []; g._order.push(k) })
    return { byProj, order: Object.keys(byProj) }
  }, [tasks])
  const sel = tasks.find((t) => t.id === selId) || null

  return jsxs('div', {
    className: 'flex h-full gap-2 p-2',
    children: [
      jsxs('div', {
        key: 'board', className: 'flex-1 flex gap-2 overflow-auto',
        children: grouped.order.length ? grouped.order.map((pk) => {
          const proj = grouped.byProj[pk]
          return jsxs('div', {
            key: pk, className: 'min-w-56 flex-1 rounded-md border border-(--ui-stroke-primary) p-2 flex flex-col gap-2',
            children: [
              jsxs('div', {
                key: 'h', className: 'flex items-center gap-2',
                children: [
                  jsx('span', { key: 'n', className: 'text-xs font-medium truncate', children: proj.name }),
                  jsx(Badge, { key: 'c', variant: 'secondary', children: '' + Object.keys(proj.cols).reduce((n, k) => n + proj.cols[k].length, 0) }),
                ],
              }),
              ...KANBAN.map((k) => jsxs('div', {
                key: k, className: 'flex flex-col gap-1.5',
                children: [
                  jsx('div', { key: 'l', className: 'text-[0.62rem] uppercase tracking-wide text-(--ui-text-quaternary)', children: KANBAN_LABEL[k] }),
                  ...((proj.cols[k] || []).map((t) => jsxs('button', {
                    key: t.id, type: 'button', onClick: () => setSelId(t.id),
                    className: cn('text-left rounded-md border p-1.5 flex flex-col gap-1 transition-colors',
                      selId === t.id ? 'border-(--ui-accent)' : 'border-(--ui-stroke-secondary) hover:bg-(--chrome-action-hover)'),
                    children: [
                      jsx('div', { key: 't', className: 'text-[0.72rem] font-medium leading-snug', children: t.title }),
                      jsxs('div', {
                        key: 'm', className: 'flex items-center gap-1.5',
                        children: [
                          jsx('span', { key: 'a', className: 'text-[0.6rem] text-(--ui-text-tertiary) truncate flex-1', children: t.assignee }),
                          jsx(Badge, { key: 'p', variant: 'secondary', children: t.priority || '—' }),
                        ],
                      }),
                      jsxs('div', {
                        key: 'f', className: 'text-[0.6rem] text-(--ui-text-quaternary) truncate',
                        children: [(t.subtasks || 0) + ' sotto-attività', t.lastSnippet ? ' · ' + t.lastSnippet.slice(0, 60) : ''].join(''),
                      }),
                    ],
                  }))),
                ],
              })),
            ],
          })
        }) : [jsx(EmptyState, { key: 'e', label: 'Nessun progetto' })],
      }),
      sel ? jsx(TaskDetail, { key: 'd', task: sel, projectName: sel.project_name, profile, onClose: () => setSelId(null) }) : null,
    ],
  })
}

/* Pagina ------------------------------------------------------------------ */
function useProfiles() {
  const [profiles, setProfiles] = useState([{ id: 'default', name: 'default' }])
  useEffect(() => {
    let alive = true
    api('/profiles')
      .then((d) => {
        if (!alive) return
        const raw = (d && (d.profiles || d.items || d.data)) || d
        const arr = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' && Array.isArray(raw.profiles) ? raw.profiles : [])
        if (Array.isArray(arr) && arr.length) {
          setProfiles(arr.map((p) => (typeof p === 'string'
            ? { id: p, name: p }
            : { id: (p && (p.id || p.name)) || 'default', name: (p && (p.name || p.id)) || 'default' })))
        }
      })
      .catch(() => { /* fallback: solo default */ })
    return () => { alive = false }
  }, [])
  return profiles
}

function loadProfile() {
  try {
    if (pluginCtx && pluginCtx.storage && typeof pluginCtx.storage.get === 'function') {
      return pluginCtx.storage.get('profile').then((v) => v || null).catch(() => null)
    }
  } catch (e) { /* storage ctx non disponibile */ }
  return Promise.resolve(null)
}

function saveProfile(id) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem('gestionale.profile', id)
  } catch (e) { /* localStorage non disponibile */ }
  try {
    if (pluginCtx && pluginCtx.storage && typeof pluginCtx.storage.set === 'function') pluginCtx.storage.set('profile', id)
  } catch (e) { /* storage ctx non disponibile */ }
}

function GestionalePage() {
  const [tab, setTab] = useState('uffici')
  const profiles = useProfiles()
  const [profile, setProfile] = useState(() => {
    try {
      if (typeof localStorage !== 'undefined') return localStorage.getItem('gestionale.profile') || 'default'
    } catch (e) { /* localStorage non disponibile */ }
    return 'default'
  })
  useEffect(() => {
    let alive = true
    loadProfile().then((v) => { if (alive && v) setProfile(v) })
    return () => { alive = false }
  }, [])
  const q = '?profile=' + encodeURIComponent(profile || 'default')
  const onProfile = (id) => { setProfile(id || 'default'); saveProfile(id || 'default') }
  const offices = usePoll('/offices' + q, 3000)
  const agents = usePoll('/agents' + q, 3000)
  const chats = usePoll('/chats' + q, 3000)
  const autos = usePoll('/automations' + q, 3000)
  const graph = usePoll('/graph' + q, 2000)
  const orchPoll = usePoll('/orchestrator' + q, 3000)
  const keeperPoll = usePoll('/gatekeeper/state' + q, 3000)
  const tasks = usePoll('/tasks' + q, 3000)
  const projects = usePoll('/projects' + q, 3000)

  const data = {
    offices: ((offices.data && offices.data.offices) || []),
    agents: ((agents.data && agents.data.agents) || []),
    chats: ((chats.data && chats.data.chats) || []),
    automations: ((autos.data && autos.data.automations) || []),
    projects: ((projects.data && projects.data.projects) || []),
  }
  const running = (data.agents || []).filter((a) => (a || {}).state === 'RUNNING').length
  const offline = Boolean(offices.err && agents.err && chats.err && autos.err)
    && !offices.data && !agents.data && !chats.data && !autos.data
  const status = offline ? 'backend offline' : 'live'
  const diag = lastErr

  const body = offline
    ? jsxs('div', { className: 'flex-1 flex flex-col items-center justify-center gap-2 p-4', children: [
        jsx(EmptyState, { label: 'backend offline' }),
        jsxs('div', { className: 'text-[0.65rem] text-(--ui-text-quaternary) max-w-md text-center break-all', children: ['diagnostica: ', diag] }),
      ] })
    : tab === 'uffici'
      ? jsx(UfficiTab, { offices: data.offices, agents: data.agents, chats: data.chats, tasksData: tasks.data, orchData: orchPoll.data, keeperData: keeperPoll.data, profile })
      : tab === 'chat'
        ? jsx(ChatTab, { chats: data.chats, agents: data.agents })
        : tab === 'automazioni'
          ? jsx(AutomationsTab, { automations: data.automations, profile })
          : tab === 'output'
            ? jsx(OutputTab, {})
            : jsx(ProjectsTab, { projects: data.projects, tasksData: tasks.data, agents: data.agents, offices: data.offices, profile })

  return jsxs('div', {
    className: 'flex h-full flex-col',
    children: [
      jsxs('div', {
        key: 'head', className: 'flex items-center gap-2 px-3 py-2 border-b border-(--ui-stroke-primary)',
        children: [
          jsx('span', { key: 't', className: 'text-sm font-semibold', children: 'Gestionale' }),
          jsx(Badge, { key: 'b', variant: 'secondary', children: running + ' agenti attivi' }),
          jsx('span', { key: 's', className: 'ml-auto text-[0.6rem] text-(--ui-text-quaternary)', children: status }),
        ],
      }),
      jsxs('div', {
        key: 'tabs', className: 'flex gap-1 px-2 py-1.5 border-b border-(--ui-stroke-primary)',
        children: TABS.map(([k, label]) => jsx('button', {
          key: k, type: 'button', onClick: () => setTab(k),
          className: cn('px-2 py-0.5 rounded text-xs transition-colors',
            tab === k ? 'bg-(--ui-accent) text-white' : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover)'),
          children: label,
        })),
      }),
      jsx('div', { key: 'body', className: 'flex-1 overflow-auto', children: body }),
      jsxs('div', {
        key: 'profile', className: 'flex items-center gap-1.5 px-3 py-1.5 border-t border-(--ui-stroke-primary)',
        children: [
          jsx(StatusDot, { key: 'd', state: 'online' }),
          jsx('span', { key: 'pl', className: 'text-[0.7rem] text-(--ui-text-quaternary)', children: 'Profilo' }),
          jsx('select', {
            key: 'sel',
            value: (profiles || []).some((p) => (p || {}).id === profile) ? profile : 'default',
            onChange: (ev) => onProfile(ev && ev.target ? ev.target.value : 'default'),
            className: 'text-[0.7rem] text-(--ui-text-tertiary) bg-transparent rounded border border-(--ui-stroke-secondary) px-1 py-0.5',
            children: ((profiles || []).length ? profiles : [{ id: 'default', name: 'default' }]).map((p) =>
              jsx('option', { key: (p || {}).id || 'default', value: (p || {}).id || 'default', children: (p || {}).name || (p || {}).id || 'default' })),
          }),
        ],
      }),
    ],
  })
}

function GestionaleChip() {
  return jsx(Tip, {
    label: 'Gestionale — apri la pagina',
    children: jsx('button', {
      type: 'button',
      className: cn('inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] transition-colors',
        'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'),
      onClick: () => host.navigate('/gestionale'),
      children: 'gestionale',
    }),
  })
}

export default {
  id: ID,
  name: 'Gestionale Hermes',
  register(ctx) {
    pluginCtx = ctx
    ctx.register({ id: 'page', area: ROUTES_AREA, data: { path: '/gestionale' }, render: () => jsx(GestionalePage, {}) })
    try {
      ctx.register({ id: 'nav', area: SIDEBAR_NAV_AREA, data: { path: '/gestionale', label: 'Gestionale', codicon: 'organization' } })
    } catch (e) { /* nav opzionale */ }
    try {
      ctx.register({ id: 'cmd', area: PALETTE_AREA, data: { label: 'Gestionale: apri', run: () => host.navigate('/gestionale') } })
    } catch (e) { /* palette opzionale */ }
    ctx.register({ id: 'chip', area: 'statusBar.right', order: 140, render: () => jsx(GestionaleChip, {}) })
  },
}
