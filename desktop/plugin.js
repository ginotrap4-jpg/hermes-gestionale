/** Gestionale Hermes — desktop plugin v0.2.
 * Sidebar /gestionale con tab: Uffici (canvas force-directed), Chat,
 * Automazioni (con dettaglio leggibile), Output (file explorer),
 * Progetti (kanban read-only + commenti). Profilo 'default' in basso.
 * Dati: ctx.rest verso /api/plugins/gestionale/ quando disponibile,
 * fallback a fetch http://127.0.0.1:8790 + polling (3s, 2s per il grafo).
 * Robusto a backend offline (EmptyState). Stile: solo variabili tema,
 * mai colori hardcoded (tranne i colori degli uffici che arrivano dai dati).
 */
import { cn, host, Button, Badge, EmptyState, StatusDot, Tip } from '@hermes/plugin-sdk'
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
  if (pluginCtx && pluginCtx.rest) {
    const method = (opts && opts.method) || 'GET'
    let body
    if (opts && opts.body !== undefined) {
      try { body = typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body }
      catch (e) { body = opts.body }
    }
    return pluginCtx.rest(path, body !== undefined ? { method, body } : { method })
  }
  const res = await fetch(API + path, opts)
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.json()
}

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
  return (byId[id] && byId[id].name) || id
}

/* Grafo uffici -----------------------------------------------------------
 * Prova GET /graph (nodi con x,y,vx,vy + pesi); se 404, deriva i lati
 * client-side dalle chat ACTIVE (con almeno un messaggio): il peso è il
 * numero di messaggi, e avvicina i nodi collegati.
 */
function deriveGraph(offices, agents, chats, graphJson) {
  const nodes = (offices || []).map((o) => ({ id: o.id, name: o.name, color: o.color || '#888' }))
  if (graphJson && (graphJson.edges || graphJson.links || graphJson.nodes)) {
    const seed = {}
    ;(graphJson.nodes || []).forEach((n) => { seed[n.id] = n })
    const raw = graphJson.edges || graphJson.links || []
    const edges = raw.map((e, i) => ({
      a: e.a || e.source || e.from, b: e.b || e.target || e.to,
      weight: Number(e.weight || e.messages || 1) || 1,
      chatId: e.chat_id || e.chatId || null,
      label: e.label || e.name || '',
      count: Number(e.messages || e.weight || 0) || 0,
      key: 'g' + i,
    })).filter((e) => e.a && e.b)
    return { nodes, edges, seed }
  }
  const officeOf = {}
  ;(agents || []).forEach((a) => { officeOf[a.id] = a.office_id })
  const pairCount = {}
  const pairChat = {}
  ;(chats || []).forEach((c) => {
    const msgs = c.messages || []
    if (!msgs.length) return // solo chat ACTIVE
    const offs = {}
    ;(c.participants || []).forEach((pid) => { if (officeOf[pid]) offs[officeOf[pid]] = true })
    const list = Object.keys(offs)
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const k = list[i] < list[j] ? list[i] + '|' + list[j] : list[j] + '|' + list[i]
        pairCount[k] = (pairCount[k] || 0) + msgs.length
        if (!pairChat[k]) pairChat[k] = c
      }
    }
  })
  const edges = Object.keys(pairCount).map((k, i) => {
    const parts = k.split('|')
    const c = pairChat[k] || {}
    return { a: parts[0], b: parts[1], weight: pairCount[k], chatId: c.id || null, label: c.name || '', count: pairCount[k], key: 'd' + i }
  })
  return { nodes, edges, seed: {} }
}

/* Canvas force-directed (physics hand-rolled, niente librerie) ------------ */
function OfficesCanvas({ nodes, edges, seed, selectedId, onNodeClick, onEdgeClick }) {
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const dataRef = useRef({ nodes, edges, seed })
  dataRef.current = { nodes, edges, seed }
  const cbRef = useRef({ onNodeClick, onEdgeClick })
  cbRef.current = { onNodeClick, onEdgeClick }
  const selRef = useRef(selectedId)
  selRef.current = selectedId

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return undefined
    const ctx = canvas.getContext('2d')
    const size = { w: 300, h: 300, dpr: 1 }
    let colors = { text: '#999', faint: '#777', stroke: '#555', accent: '#7aa2f7', bubble: '#fff', bubbleSub: '#bbb' }
    const pos = new Map() // id -> {x,y,vx,vy}
    let mouse = null
    let hoverEdge = null
    let dragId = null
    let downAt = null
    let raf = 0

    const resolveColors = () => {
      try {
        const cs = getComputedStyle(canvas)
        const g = (n, fb) => (cs.getPropertyValue(n) || '').trim() || fb
        colors = {
          text: g('--ui-text-secondary', '#999'),
          faint: g('--ui-text-quaternary', '#777'),
          stroke: g('--ui-stroke-secondary', '#555'),
          accent: g('--ui-accent', '#7aa2f7'),
          bubble: g('--ui-text-primary', '#fff'),
          bubbleSub: g('--ui-text-tertiary', '#bbb'),
        }
      } catch (e) { /* tema non leggibile, fallback ok */ }
    }

    const ensureSize = () => {
      const w = wrap.clientWidth
      const h = wrap.clientHeight
      if (!w || !h) return
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      size.w = w; size.h = h; size.dpr = dpr
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.width = w + 'px'
      canvas.style.height = h + 'px'
      resolveColors()
    }
    ensureSize()
    let ro = null
    try {
      ro = new ResizeObserver(ensureSize)
      ro.observe(wrap)
    } catch (e) { /* ResizeObserver non disponibile: misura fissa */ }

    const P = (id) => {
      let p = pos.get(id)
      if (!p) {
        const s = (dataRef.current.seed || {})[id] || {}
        const n = pos.size
        p = {
          x: typeof s.x === 'number' ? s.x : size.w / 2 + 90 * Math.cos((n * 2.4) + 0.5),
          y: typeof s.y === 'number' ? s.y : size.h / 2 + 90 * Math.sin((n * 2.4) + 0.5),
          vx: typeof s.vx === 'number' ? s.vx : 0,
          vy: typeof s.vy === 'number' ? s.vy : 0,
        }
        pos.set(id, p)
      }
      return p
    }

    const distToSeg = (mx, my, ax, ay, bx, by) => {
      const dx = bx - ax
      const dy = by - ay
      const len2 = dx * dx + dy * dy || 1
      let t = ((mx - ax) * dx + (my - ay) * dy) / len2
      t = Math.max(0, Math.min(1, t))
      const px = ax + t * dx
      const py = ay + t * dy
      return Math.sqrt((mx - px) * (mx - px) + (my - py) * (my - py))
    }

    const step = () => {
      const cur = dataRef.current
      const list = cur.nodes || []
      const links = cur.edges || []
      list.forEach((n) => P(n.id))
      // repulsione tra nodi
      for (let i = 0; i < list.length; i++) {
        const a = P(list[i].id)
        for (let j = i + 1; j < list.length; j++) {
          const b = P(list[j].id)
          let dx = a.x - b.x
          let dy = a.y - b.y
          let d2 = dx * dx + dy * dy
          if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1 }
          const d = Math.sqrt(d2)
          const f = Math.min(6, 2600 / d2)
          const ux = (dx / d) * f
          const uy = (dy / d) * f
          a.vx += ux; a.vy += uy; b.vx -= ux; b.vy -= uy
        }
      }
      // molle sui lati: il peso avvicina (rest più corta, molla più forte)
      links.forEach((e) => {
        if (!pos.has(e.a) || !pos.has(e.b)) return
        const a = pos.get(e.a)
        const b = pos.get(e.b)
        const w = Math.min(40, Number(e.weight) || 1)
        const rest = Math.max(70, 200 - w * 4)
        const k = 0.012 * (1 + w * 0.12)
        const dx = b.x - a.x
        const dy = b.y - a.y
        const d = Math.sqrt(dx * dx + dy * dy) || 1
        const f = (d - rest) * k
        const ux = (dx / d) * f
        const uy = (dy / d) * f
        a.vx += ux; a.vy += uy; b.vx -= ux; b.vy -= uy
      })
      // centraggio + attrito; il nodo trascinato resta fermo
      const cx = size.w / 2
      const cy = size.h / 2
      pos.forEach((p, id) => {
        if (id === dragId) { p.vx = 0; p.vy = 0; return }
        p.vx += (cx - p.x) * 0.006
        p.vy += (cy - p.y) * 0.006
        p.vx *= 0.86; p.vy *= 0.86
        const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy)
        if (sp > 8) { p.vx = (p.vx / sp) * 8; p.vy = (p.vy / sp) * 8 }
        p.x += p.vx; p.y += p.vy
      })
    }

    const roundRect = (x, y, w, h, r) => {
      ctx.beginPath()
      ctx.moveTo(x + r, y)
      ctx.arcTo(x + w, y, x + w, y + h, r)
      ctx.arcTo(x + w, y + h, x, y + h, r)
      ctx.arcTo(x, y + h, x, y, r)
      ctx.arcTo(x, y, x + w, y, r)
      ctx.closePath()
    }

    const draw = () => {
      const cur = dataRef.current
      ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0)
      ctx.clearRect(0, 0, size.w, size.h)
      // lati
      ;(cur.edges || []).forEach((e) => {
        if (!pos.has(e.a) || !pos.has(e.b)) return
        const a = pos.get(e.a)
        const b = pos.get(e.b)
        const hot = hoverEdge && hoverEdge.key === e.key
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.strokeStyle = hot ? colors.accent : colors.stroke
        ctx.lineWidth = hot ? 3 : 1 + Math.min(3, (Number(e.weight) || 1) / 8)
        ctx.stroke()
        if (hot) {
          const mx = (a.x + b.x) / 2
          const my = (a.y + b.y) / 2
          const title = e.label || (e.a + ' ↔ ' + e.b)
          const sub = (e.count || e.weight || 0) + ' messaggi — clicca per aprire la chat'
          ctx.font = '11px sans-serif'
          const w1 = ctx.measureText(title).width
          ctx.font = '10px sans-serif'
          const w2 = ctx.measureText(sub).width
          const bw = Math.max(w1, w2) + 16
          const bx = Math.min(Math.max(4, mx - bw / 2), Math.max(4, size.w - bw - 4))
          const by = Math.max(4, my - 46)
          roundRect(bx, by, bw, 40, 6)
          ctx.fillStyle = 'rgba(0,0,0,0.82)'
          ctx.fill()
          ctx.strokeStyle = colors.accent
          ctx.lineWidth = 1
          ctx.stroke()
          ctx.fillStyle = colors.bubble
          ctx.font = '11px sans-serif'
          ctx.fillText(title, bx + 8, by + 16)
          ctx.fillStyle = colors.bubbleSub
          ctx.font = '10px sans-serif'
          ctx.fillText(sub, bx + 8, by + 31)
        }
      })
      // nodi
      ;(cur.nodes || []).forEach((n) => {
        const p = P(n.id)
        const R = 24
        ctx.beginPath()
        ctx.arc(p.x, p.y, R, 0, Math.PI * 2)
        ctx.fillStyle = n.color || '#888'
        ctx.fill()
        if (selRef.current === n.id) {
          ctx.beginPath()
          ctx.arc(p.x, p.y, R + 4, 0, Math.PI * 2)
          ctx.strokeStyle = colors.accent
          ctx.lineWidth = 2.5
          ctx.stroke()
        }
        ctx.fillStyle = colors.text
        ctx.font = '11px sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText(n.name, p.x, p.y + R + 14)
        ctx.textAlign = 'left'
      })
    }

    const frame = () => {
      step()
      draw()
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    const toLocal = (ev) => {
      const r = canvas.getBoundingClientRect()
      return { x: ev.clientX - r.left, y: ev.clientY - r.top }
    }
    const hitNode = (m) => {
      const cur = dataRef.current
      const list = cur.nodes || []
      for (let i = list.length - 1; i >= 0; i--) {
        const p = pos.get(list[i].id)
        if (!p) continue
        if ((m.x - p.x) * (m.x - p.x) + (m.y - p.y) * (m.y - p.y) <= 26 * 26) return list[i].id
      }
      return null
    }
    const hitEdge = (m) => {
      const cur = dataRef.current
      let best = null
      let bestD = 9
      ;(cur.edges || []).forEach((e) => {
        if (!pos.has(e.a) || !pos.has(e.b)) return
        const a = pos.get(e.a)
        const b = pos.get(e.b)
        const d = distToSeg(m.x, m.y, a.x, a.y, b.x, b.y)
        if (d < bestD) { bestD = d; best = e }
      })
      return best
    }

    const onDown = (ev) => {
      const m = toLocal(ev)
      const id = hitNode(m)
      downAt = m
      if (id) {
        dragId = id
        const p = P(id)
        p.x = m.x; p.y = m.y
      }
    }
    const onMove = (ev) => {
      const m = toLocal(ev)
      mouse = m
      if (dragId && downAt) {
        const p = P(dragId)
        p.x = m.x; p.y = m.y
        return
      }
      hoverEdge = hitEdge(m)
      canvas.style.cursor = hitNode(m) || hoverEdge ? 'pointer' : 'default'
    }
    const onUp = (ev) => {
      const m = toLocal(ev)
      const moved = downAt ? Math.abs(m.x - downAt.x) + Math.abs(m.y - downAt.y) : 99
      const wasDrag = dragId
      dragId = null
      downAt = null
      if (moved > 4) return // era un trascinamento, non un clic
      const id = hitNode(m)
      if (id) { cbRef.current.onNodeClick(id); return }
      if (wasDrag) return
      const e = hitEdge(m)
      if (e) cbRef.current.onEdgeClick(e)
      else { cbRef.current.onNodeClick(null); cbRef.current.onEdgeClick(null) }
    }
    const onLeave = () => { hoverEdge = null; mouse = null; if (!dragId) downAt = null }

    canvas.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    canvas.addEventListener('mouseleave', onLeave)
    return () => {
      cancelAnimationFrame(raf)
      if (ro) ro.disconnect()
      canvas.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      canvas.removeEventListener('mouseleave', onLeave)
    }
  }, [])

  return jsx('div', {
    ref: wrapRef,
    className: 'relative flex-1 min-h-[380px]',
    children: jsx('canvas', { ref: canvasRef, className: 'absolute inset-0 block' }),
  })
}

function AgentLine({ agent }) {
  const pct = pctOf(agent.progress)
  return jsxs('div', {
    className: 'rounded-md border border-(--ui-stroke-secondary) p-2 flex flex-col gap-1',
    children: [
      jsxs('div', {
        key: 'h', className: 'flex items-center gap-1.5',
        children: [
          jsx(StatusDot, { key: 'd', state: dotFor(agent.state) }),
          jsx('span', { key: 'n', className: 'text-xs font-medium truncate', children: agent.name }),
          jsx('span', { key: 's', className: 'ml-auto text-[0.6rem] text-(--ui-text-quaternary)', children: agent.state }),
        ],
      }),
      jsx('div', {
        key: 'bar', className: 'h-1 rounded-full bg-(--ui-stroke-secondary) overflow-hidden',
        children: jsx('div', { className: 'h-full bg-(--ui-accent)', style: { width: pct + '%' } }),
      }),
      jsx('div', {
        key: 'act', className: 'text-[0.6875rem] text-(--ui-text-tertiary) leading-snug',
        children: (agent.goal || 'in attesa di mansione') + ' · ' + pct + '% · ' + fmtAgo(agent.heartbeat_at || agent.started_at),
      }),
    ],
  })
}

function UfficiTab({ offices, agents, chats, graphJson }) {
  const [selOffice, setSelOffice] = useState(null)
  const [edgeSel, setEdgeSel] = useState(null) // {a,b,...}
  const graph = useMemo(
    () => deriveGraph(offices, agents, chats, graphJson),
    [offices, agents, chats, graphJson]
  )
  const byId = useMemo(() => {
    const m = {}
    ;(agents || []).forEach((a) => { m[a.id] = a })
    return m
  }, [agents])
  const officeById = useMemo(() => {
    const m = {}
    ;(offices || []).forEach((o) => { m[o.id] = o })
    return m
  }, [offices])

  const officeAgents = selOffice ? (agents || []).filter((a) => a.office_id === selOffice) : []
  const edgeChats = useMemo(() => {
    if (!edgeSel) return []
    const officeOf = (pid) => byId[pid] && byId[pid].office_id
    return (chats || []).filter((c) => {
      const offs = {}
      ;(c.participants || []).forEach((pid) => { if (officeOf(pid)) offs[officeOf(pid)] = true })
      return offs[edgeSel.a] && offs[edgeSel.b]
    })
  }, [edgeSel, chats, byId])

  const side = edgeSel
    ? jsxs('div', {
      key: 'edge', className: 'flex flex-col gap-2',
      children: [
        jsxs('div', {
          key: 'h', className: 'flex items-center gap-2',
          children: [
            jsx(Button, { key: 'b', size: 'sm', variant: 'ghost', type: 'button', onClick: () => setEdgeSel(null), children: '←' }),
            jsx('span', {
              key: 't', className: 'text-xs font-medium truncate',
              children: (officeById[edgeSel.a] ? officeById[edgeSel.a].name : edgeSel.a) + ' ↔ ' + (officeById[edgeSel.b] ? officeById[edgeSel.b].name : edgeSel.b),
            }),
          ],
        }),
        edgeChats.length
          ? edgeChats.map((c) => jsxs('div', {
            key: c.id, className: 'rounded-md border border-(--ui-stroke-secondary) p-2 flex flex-col gap-1',
            children: [
              jsx('div', { key: 'n', className: 'text-[0.6875rem] uppercase tracking-wide text-(--ui-text-tertiary)', children: c.name }),
              ...(c.messages || []).slice(-6).map((m) => jsxs('div', {
                key: m.id || ('' + m.ts + m.from_agent_id),
                children: [
                  jsx('div', { key: 'w', className: 'text-[0.6rem] text-(--ui-text-quaternary)', children: agentName(byId, m.from_agent_id) }),
                  jsx('div', { key: 'x', className: 'text-[0.7rem] text-(--ui-text-secondary)', children: m.text }),
                ],
              })),
            ],
          }))
          : jsx(EmptyState, { key: 'e', label: 'Nessuna chat fra questi uffici' }),
      ],
    })
    : selOffice
      ? jsxs('div', {
        key: 'off', className: 'flex flex-col gap-2',
        children: [
          jsx('div', {
            key: 'h', className: 'text-[0.6875rem] uppercase tracking-wide text-(--ui-text-tertiary)',
            children: (officeById[selOffice] ? officeById[selOffice].name : selOffice) + ' · ' + officeAgents.length + ' agenti',
          }),
          officeAgents.length
            ? officeAgents.map((a) => jsx(AgentLine, { key: a.id, agent: a }))
            : jsx(EmptyState, { key: 'e', label: 'Nessun agente in questo ufficio' }),
        ],
      })
      : jsx('div', {
        key: 'hint', className: 'text-[0.7rem] text-(--ui-text-quaternary) leading-relaxed',
        children: 'Trascina i nodi per spostarli. Clicca un ufficio per vedere i suoi agenti, o una linea per aprire la chat fra due uffici.',
      })

  return jsxs('div', {
    className: 'flex h-full gap-2 p-2',
    children: [
      jsx(OfficesCanvas, {
        key: 'cv', nodes: graph.nodes, edges: graph.edges, seed: graph.seed, selectedId: selOffice,
        onNodeClick: (id) => { setSelOffice(id); if (id) setEdgeSel(null) },
        onEdgeClick: (e) => { setEdgeSel(e); if (e) setSelOffice(null) },
      }),
      jsx('div', { key: 'side', className: 'w-64 shrink-0 overflow-auto flex flex-col gap-2', children: side }),
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
  const steps = []
  steps.push({ t: 'Quando parte', d: a.schedule_raw ? 'Si attiva con questa cadenza: ' + a.schedule_raw + '.' : 'Parte quando serve (nessuna cadenza impostata).' })
  const src = a.source === 'hermes_cron' ? 'un controllo pianificato del sistema' : 'il motore interno delle automazioni'
  steps.push({ t: 'Cosa fa', d: 'È ' + src + ' e si chiama «' + a.name + '».' })
  if (a.office_id) steps.push({ t: 'Chi se ne occupa', d: 'Ufficio di riferimento: ' + a.office_id + '.' })
  const last = a.last_run_status
    ? 'Ultima esecuzione: ' + (a.last_run_status === 'ok' ? 'tutto bene' : a.last_run_status) + (a.last_run_ts ? ' (' + fmtAgo(a.last_run_ts) + ')' : '') + '.'
    : 'Non risulta ancora eseguita.'
  steps.push({ t: 'Stato', d: last + (a.enabled ? ' Al momento è accesa.' : ' Al momento è spenta.') })
  return steps
}

function AutomationsTab({ automations }) {
  const [selId, setSelId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailErr, setDetailErr] = useState(null)
  const [rows, setRows] = useState(automations || [])
  useEffect(() => { setRows(automations || []) }, [automations])
  const sel = (rows || []).find((a) => a.id === selId) || null

  useEffect(() => {
    if (!selId) { setDetail(null); setDetailErr(null); return undefined }
    let alive = true
    setDetail(null); setDetailErr(null)
    api('/automations/' + selId + '/detail')
      .then((d) => { if (alive) setDetail(d) })
      .catch((e) => { if (alive) setDetailErr(e.message || 'errore') })
    return () => { alive = false }
  }, [selId])

  const toggle = (a) => {
    const on = !a.enabled
    setRows((prev) => (prev || []).map((r) => (r.id === a.id ? { ...r, enabled: on ? 1 : 0 } : r)))
    api('/automations/' + a.id + '/toggle?enabled=' + (on ? '1' : '0'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: on }),
    }).catch(() => {
      setRows((prev) => (prev || []).map((r) => (r.id === a.id ? { ...r, enabled: a.enabled } : r)))
    })
  }

  const detailSteps = (() => {
    if (!sel) return []
    if (detail) {
      const arr = detail.steps || detail.composition || detail.stages || detail.passaggi || null
      if (Array.isArray(arr) && arr.length) {
        return arr.map((s, i) => {
          if (typeof s === 'string') return { t: 'Passo ' + (i + 1), d: s }
          return {
            t: s.title || s.nome || s.name || ('Passo ' + (i + 1)),
            d: [s.description || s.descrizione || s.detail || '', s.script ? 'Script: ' + s.script : '', s.file ? 'File: ' + s.file : '']
              .filter(Boolean).join(' — ') || '—',
          }
        })
      }
      if (detail.description || detail.descrizione) {
        return [{ t: sel.name, d: detail.description || detail.descrizione }]
      }
    }
    return autoStepsFallback(sel)
  })()

  return jsxs('div', {
    className: 'flex h-full gap-2 p-2',
    children: [
      jsxs('div', {
        key: 'list', className: 'flex-1 flex flex-col gap-1.5 overflow-auto',
        children: (rows || []).length ? rows.map((a) => jsxs('div', {
          key: a.id,
          className: cn('rounded-md border p-2 flex items-center gap-2 cursor-pointer transition-colors',
            selId === a.id ? 'border-(--ui-accent)' : 'border-(--ui-stroke-secondary) hover:bg-(--chrome-action-hover)'),
          onClick: () => setSelId(selId === a.id ? null : a.id),
          children: [
            jsx(StatusDot, { key: 'd', state: a.enabled ? 'online' : 'idle' }),
            jsxs('div', {
              key: 'm', className: 'flex-1 min-w-0',
              children: [
                jsx('div', { key: 'n', className: 'text-xs truncate', children: a.name }),
                jsx('div', { key: 's', className: 'text-[0.6rem] text-(--ui-text-quaternary) truncate', children: (a.source === 'hermes_cron' ? 'cron' : 'motore') + ' · ' + (a.schedule_raw || 'senza cadenza') }),
              ],
            }),
            jsx('div', { key: 'l', className: 'text-[0.6rem] text-(--ui-text-tertiary)', children: a.last_run_status === 'ok' ? 'ok' : (a.last_run_status || '—') }),
            jsx(Button, {
              key: 't', size: 'sm', variant: 'ghost', type: 'button',
              onClick: (ev) => { ev.stopPropagation(); toggle(a) },
              children: a.enabled ? 'Off' : 'On',
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
              jsx(StatusDot, { key: 'd', state: sel.enabled ? 'online' : 'idle' }),
              jsx('span', { key: 'n', className: 'text-xs font-medium flex-1 truncate', children: sel.name }),
              jsx(Button, { key: 'x', size: 'sm', variant: 'ghost', type: 'button', onClick: () => setSelId(null), children: '✕' }),
            ],
          }),
          detailErr ? jsx('div', { key: 'w', className: 'text-[0.65rem] text-(--ui-text-quaternary)', children: 'Dettaglio server non disponibile, mostro il riepilogo.' }) : null,
          ...detailSteps.map((s, i) => jsxs('div', {
            key: 's' + i, className: 'flex flex-col gap-0.5',
            children: [
              jsx('div', { key: 't', className: 'text-[0.6875rem] font-medium text-(--ui-text-secondary)', children: (i + 1) + '. ' + s.t }),
              jsx('div', { key: 'd', className: 'text-[0.7rem] text-(--ui-text-tertiary) leading-relaxed', children: s.d }),
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
    ;(pr.missions || []).forEach((m) => {
      out.push({
        id: m.id, project_id: pr.id, project_name: pr.name, title: m.title,
        description: '', status: null, progress: m.progress || 0,
        assignee: m.office_id || '', priority: '—', subtasks: 0,
        comments: [], lastComment: '',
      })
    })
  })
  return out
}

function TaskDetail({ task, projectName, onClose }) {
  const [remote, setRemote] = useState(null)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [sendErr, setSendErr] = useState(null)
  const [localComments, setLocalComments] = useState([])
  useEffect(() => {
    let alive = true
    api('/tasks/' + task.id)
      .then((d) => { if (alive) setRemote(d.task || d) })
      .catch(() => { if (alive) setRemote(null) })
    return () => { alive = false }
  }, [task.id])
  const full = { ...task, ...(remote || {}) }
  const thread = [...(full.comments || []), ...localComments]
  const send = () => {
    const t = text.trim()
    if (!t || sending) return
    setSending(true); setSendErr(null)
    api('/tasks/' + task.id + '/comment', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'user', text: t }),
    })
      .then(() => {
        setLocalComments((prev) => [...prev, { author: 'user', text: t, ts: Date.now() / 1000 }])
        setText('')
      })
      .catch((e) => setSendErr(e.message || 'errore'))
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

function ProjectsTab({ projects, tasksData, agents, offices }) {
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
      sel ? jsx(TaskDetail, { key: 'd', task: sel, projectName: sel.project_name, onClose: () => setSelId(null) }) : null,
    ],
  })
}

/* Pagina ------------------------------------------------------------------ */
function GestionalePage() {
  const [tab, setTab] = useState('uffici')
  const offices = usePoll('/offices', 3000)
  const agents = usePoll('/agents', 3000)
  const chats = usePoll('/chats', 3000)
  const autos = usePoll('/automations', 3000)
  const graph = usePoll('/graph', 2000)
  const tasks = usePoll('/tasks', 3000)
  const projects = usePoll('/projects', 3000)

  const data = {
    offices: (offices.data && offices.data.offices) || [],
    agents: (agents.data && agents.data.agents) || [],
    chats: (chats.data && chats.data.chats) || [],
    automations: (autos.data && autos.data.automations) || [],
    projects: (projects.data && projects.data.projects) || [],
  }
  const running = data.agents.filter((a) => a.state === 'RUNNING').length
  const offline = Boolean(offices.err && agents.err && chats.err && autos.err)
    && !offices.data && !agents.data && !chats.data && !autos.data
  const status = offline ? 'backend offline' : 'live'

  const body = offline
    ? jsx('div', { className: 'flex-1 flex items-center justify-center', children: jsx(EmptyState, { label: 'backend offline' }) })
    : tab === 'uffici'
      ? jsx(UfficiTab, { offices: data.offices, agents: data.agents, chats: data.chats, graphJson: graph.data })
      : tab === 'chat'
        ? jsx(ChatTab, { chats: data.chats, agents: data.agents })
        : tab === 'automazioni'
          ? jsx(AutomationsTab, { automations: data.automations })
          : tab === 'output'
            ? jsx(OutputTab, {})
            : jsx(ProjectsTab, { projects: data.projects, tasksData: tasks.data, agents: data.agents, offices: data.offices })

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
          jsx('span', { key: 'n', className: 'text-[0.7rem] text-(--ui-text-tertiary)', children: 'default' }),
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
