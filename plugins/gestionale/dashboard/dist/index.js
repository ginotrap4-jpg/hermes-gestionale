(function () {
  "use strict";
  var SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK) return;
  var React = SDK.React;
  var h = React.createElement;

  var API = "/api/plugins/gestionale";
  var KANBAN = ["backlog", "todo", "in_progress", "in_review", "done"];
  var KLBL = { backlog: "Backlog", todo: "Da fare", in_progress: "In corso", in_review: "In revisione", done: "Fatti" };
  var TABS = [["uffici", "Uffici"], ["chat", "Chat"], ["automazioni", "Automazioni"], ["output", "Output"], ["progetti", "Progetti"]];

  function get(path) { return fetch(API + path).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }); }
  function kb(n) { return (n / 1024).toFixed(1) + " KB"; }
  function pct(p) { return Math.min(100, Math.max(0, Math.round((p || 0) * 100))); }

  var App = function () {
    var tab = React.useState("uffici")[0];
    var setTab = React.useState("uffici")[1];
    var agents = React.useState([])[0];
    var setAgents = React.useState([])[1];
    var offices = React.useState([])[0];
    var setOffices = React.useState([])[1];
    var chats = React.useState([])[0];
    var setChats = React.useState([])[1];
    var autos = React.useState([])[0];
    var setAutos = React.useState([])[1];
    var graph = React.useState(null)[0];
    var setGraph = React.useState(null)[1];
    var tasks = React.useState([])[0];
    var setTasks = React.useState([])[1];
    var projects = React.useState([])[0];
    var setProjects = React.useState([])[1];
    var files = React.useState(null)[0];
    var setFiles = React.useState(null)[1];
    var status = React.useState("conn…")[0];
    var setStatus = React.useState("conn…")[1];

    React.useEffect(function () {
      var alive = true;
      function tick() {
        Promise.all([
          get("/offices").then(function (d) { if (alive) setOffices(d.offices || []) }),
          get("/agents").then(function (d) { if (alive) setAgents(d.agents || []) }),
          get("/chats").then(function (d) { if (alive) setChats(d.chats || []) }),
          get("/automations").then(function (d) { if (alive) setAutos(d.automations || []) }),
          get("/graph").then(function (d) { if (alive) setGraph(d) }).catch(function () {}),
          get("/tasks").then(function (d) { if (alive) setTasks(d.tasks || []) }).catch(function () {}),
          get("/projects").then(function (d) { if (alive) setProjects(d.projects || []) }).catch(function () {}),
        ]).then(function () { if (alive) setStatus("live") }).catch(function (e) { if (alive) setStatus("errore: " + e.message) });
      }
      tick();
      var t = setInterval(tick, 3000);
      return function () { alive = false; clearInterval(t); };
    }, []);

    var running = agents.filter(function (a) { return a.state === "RUNNING" }).length;
    var byId = {};
    agents.forEach(function (a) { byId[a.id] = a });

    /* --- canvases via refs --- */
    var cvRef = React.useRef(null);
    var posRef = React.useRef({});
    var dataRef = React.useRef({ offices: offices, graph: graph, agents: agents });
    dataRef.current = { offices: offices, graph: graph, agents: agents };
    var selRef = React.useRef(null);
    var setSelRef = React.useState(null)[1];

    React.useEffect(function () {
      var cv = cvRef.current;
      if (!cv) return;
      var ctx2d = cv.getContext("2d");
      var raf = 0;
      function frame() {
        raf = requestAnimationFrame(frame);
        var d = dataRef.current;
        var w = cv.parentElement.clientWidth, ht = cv.parentElement.clientHeight;
        if (cv.width !== w || cv.height !== ht) { cv.width = w; cv.height = ht; }
        if (!w || !ht) return;
        var cs = getComputedStyle(cv);
        function g(n, f) { return (cs.getPropertyValue(n) || "").trim() || f; }
        var cText = g("--foreground", "#eee"), cMute = g("--muted-foreground", "#999"), cAcc = g("--accent", "#7aa2f7"), cLine = g("--border", "#444");
        var nodes = d.offices;
        if (!nodes.length) { ctx2d.clearRect(0, 0, w, ht); return; }
        var pos = posRef.current;
        // init positions
        nodes.forEach(function (o, i) {
          if (!pos[o.id]) {
            var ang = (i / nodes.length) * Math.PI * 2;
            pos[o.id] = { x: w / 2 + Math.cos(ang) * w * 0.28, y: ht / 2 + Math.sin(ang) * ht * 0.3, vx: 0, vy: 0, fixed: false };
          }
        });
        // edges from graph
        var edges = (d.graph && (d.graph.edges || d.graph.links)) || [];
        // physics
        var i2, j2, a, b, dx, dy, dist;
        for (i2 = 0; i2 < nodes.length; i2++) for (j2 = i2 + 1; j2 < nodes.length; j2++) {
          a = pos[nodes[i2].id]; b = pos[nodes[j2].id];
          dx = a.x - b.x; dy = a.y - b.y; dist = Math.sqrt(dx * dx + dy * dy) || 1;
          var rep = 2600 / (dist * dist);
          a.vx += dx / dist * rep; a.vy += dy / dist * rep;
          b.vx -= dx / dist * rep; b.vy -= dy / dist * rep;
        }
        edges.forEach(function (e) {
          var pa = pos[e.source || e.a || e.from], pb = pos[e.target || e.b || e.to];
          if (!pa || !pb) return;
          dx = pb.x - pa.x; dy = pb.y - pa.y; dist = Math.sqrt(dx * dx + dy * dy) || 1;
          var wgt = Math.min(2, Number(e.weight || e.messages || 1));
          var spring = 0.002 * wgt;
          pa.vx += dx * spring; pa.vy += dy * spring;
          pb.vx -= dx * spring; pb.vy -= dy * spring;
        });
        nodes.forEach(function (o) {
          var p = pos[o.id];
          if (!p.fixed) {
            p.vx += (w / 2 - p.x) * 0.0025; p.vy += (ht / 2 - p.y) * 0.0025;
            p.x += p.vx; p.y += p.vy;
          }
          p.vx *= 0.85; p.vy *= 0.85;
          p.x = Math.max(50, Math.min(w - 50, p.x));
          p.y = Math.max(40, Math.min(ht - 40, p.y));
        });
        // draw
        ctx2d.clearRect(0, 0, w, ht);
        edges.forEach(function (e) {
          var pa = pos[e.source || e.a || e.from], pb = pos[e.target || e.b || e.to];
          if (!pa || !pb) return;
          ctx2d.strokeStyle = "rgba(80,220,120,0.75)";
          ctx2d.lineWidth = Math.min(4, 1 + (Number(e.weight || e.messages || 1) / 12));
          ctx2d.beginPath(); ctx2d.moveTo(pa.x, pa.y); ctx2d.lineTo(pb.x, pb.y); ctx2d.stroke();
          var cnt = Number(e.weight || e.messages || 0);
          var mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;
          ctx2d.fillStyle = cMute; ctx2d.font = "10px sans-serif"; ctx2d.textAlign = "center";
          ctx2d.fillText(cnt + " msg", mx, my - 6);
        });
        nodes.forEach(function (o) {
          var p = pos[o.id];
          ctx2d.beginPath(); ctx2d.arc(p.x, p.y, 18, 0, Math.PI * 2);
          ctx2d.fillStyle = o.color || cAcc; ctx2d.fill();
          ctx2d.strokeStyle = cText; ctx2d.lineWidth = 1; ctx2d.stroke();
          var count = d.agents.filter(function (x) { return x.office_id === o.id }).length;
          ctx2d.fillStyle = cText; ctx2d.font = "12px sans-serif"; ctx2d.textAlign = "center";
          ctx2d.fillText(o.name, p.x, p.y - 28);
          ctx2d.fillStyle = cMute;
          ctx2d.fillText(count ? count + " agenti" : "vuoto", p.x, p.y + 34);
        });
      }
      frame();
      function cleanup() { cancelAnimationFrame(raf); }
      cv._cleanup = cleanup;
      // simple drag
      var drag = null;
      cv.onmousedown = function (ev) {
        var r2 = cv.getBoundingClientRect();
        var mx = ev.clientX - r2.left, my = ev.clientY - r2.top;
        Object.keys(posRef.current).forEach(function (k) {
          var p = posRef.current[k];
          if (Math.hypot(p.x - mx, p.y - my) < 22) { drag = p; p.fixed = true; }
        });
      };
      cv.onmousemove = function (ev) {
        if (!drag) return;
        var r3 = cv.getBoundingClientRect();
        drag.x = ev.clientX - r3.left; drag.y = ev.clientY - r3.top;
      };
      cv.onmouseup = function () { if (drag) { drag.fixed = false; drag = null; } };
      return cleanup;
    }, [offices.length, graph]);

    var body;
    if (tab === "uffici") {
      body = h("div", { style: { flex: 1, position: "relative", minHeight: 420 } },
        h("canvas", { ref: cvRef, style: { width: "100%", height: "100%", display: "block" } })
      );
    } else if (tab === "chat") {
      body = h("div", { style: { flex: 1, overflow: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 12 } },
        chats.map(function (c) {
          return h("div", { key: c.id, style: { border: "1px solid rgba(128,128,128,.25)", borderRadius: 8, padding: 10 } },
            h("div", { style: { fontSize: 12, opacity: .6, marginBottom: 6 } }, (c.type === "group" ? "# " : "@ ") + c.name),
            (c.messages || []).slice(-8).map(function (m, ix) {
              return h("div", { key: ix, style: { marginBottom: 4 } },
                h("div", { style: { fontSize: 10, opacity: .55 } }, (byId[m.from_agent_id] || {}).name || m.from_agent_id),
                h("div", { style: { fontSize: 13 } }, m.text));
            })
          );
        })
      );
    } else if (tab === "automazioni") {
      body = h("div", { style: { flex: 1, overflow: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 6 } },
        autos.map(function (a2) {
          var tgl = function () {
            fetch(API + "/automations/" + a2.id + "/toggle?enabled=" + (!a2.enabled), { method: "POST" }).then(function () { return get("/automations") }).then(function (d) { setAutos(d.automations || []) });
          };
          return h("div", { key: a2.id, style: { border: "1px solid rgba(128,128,128,.25)", borderRadius: 8, padding: 10, display: "flex", alignItems: "center", gap: 10 } },
            h("div", { style: { width: 9, height: 9, borderRadius: 9, background: a2.enabled ? "#4cc38a" : "#666" } }),
            h("div", { style: { flex: 1, minWidth: 0 } },
              h("div", { style: { fontSize: 13 } }, a2.name),
              h("div", { style: { fontSize: 10, opacity: .55 } }, (a2.source === "hermes_cron" ? "cron" : "engine") + " · " + a2.schedule_raw)),
            h("div", { style: { fontSize: 10, opacity: .6 } }, a2.last_run_status || "—"),
            h("button", { onClick: tgl, style: { padding: "3px 10px", fontSize: 11, cursor: "pointer" } }, a2.enabled ? "Off" : "On"));
        })
      );
    } else if (tab === "output") {
      body = h("div", { style: { flex: 1, overflow: "auto", padding: 12 } }, "Output — navigatore file lato desktop (qui mostro solo la root):",
        h("div", { style: { marginTop: 8, fontSize: 12, opacity: .7 } }, files ? JSON.stringify(files).slice(0, 400) : "caricamento…"));
    } else {
      // progetti kanban paperclip-style
      var cols = KANBAN.map(function (st) {
        var list = tasks.filter(function (t) { return t.status === st });
        return h("div", { key: st, style: { flex: 1, minWidth: 180, background: "rgba(128,128,128,.06)", borderRadius: 8, padding: 8 } },
          h("div", { style: { fontSize: 11, opacity: .65, marginBottom: 6 } }, KLBL[st] + " (" + list.length + ")"),
          list.map(function (t) {
            return h("div", { key: t.id, style: { border: "1px solid rgba(128,128,128,.25)", borderRadius: 6, padding: 7, marginBottom: 5, background: "rgba(128,128,128,.08)" } },
              h("div", { style: { fontSize: 12 } }, t.title),
              h("div", { style: { fontSize: 10, opacity: .55, marginTop: 3 } }, (t.assignee_agent_id || t.assignee_office_id || "—") + (t.children_count ? " · " + t.children_count + " subtask" : "")));
          }));
      });
      body = h("div", { style: { flex: 1, overflow: "auto", padding: 12, display: "flex", gap: 10 } }, cols);
    }

    return h("div", { style: { display: "flex", flexDirection: "column", height: "calc(100vh - 120px)", gap: 8, fontFamily: "inherit", color: "var(--foreground)" } },
      h("div", { style: { display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderBottom: "1px solid rgba(128,128,128,.2)" } },
        h("span", { style: { fontWeight: 600, fontSize: 15 } }, "Gestionale"),
        h("span", { style: { fontSize: 11, opacity: .6, padding: "2px 8px", border: "1px solid rgba(128,128,128,.3)", borderRadius: 10 } }, running + " agenti attivi"),
        h("span", { style: { marginLeft: "auto", fontSize: 10, opacity: .55 } }, status)),
      h("div", { style: { display: "flex", gap: 4, padding: "4px 10px", borderBottom: "1px solid rgba(128,128,128,.2)" } },
        TABS.map(function (tl) {
          return h("button", { key: tl[0], onClick: function () { setTab(tl[0]) }, style: {
            padding: "4px 10px", fontSize: 12, cursor: "pointer", borderRadius: 6, border: "1px solid rgba(128,128,128,.3)",
            background: tab === tl[0] ? "var(--accent)" : "transparent", color: tab === tl[0] ? "#000" : "var(--foreground)", opacity: tab === tl[0] ? .9 : .75 } }, tl[1]);
        })),
      body);
  };

  window.__HERMES_PLUGINS__.register("gestionale", App);
})();
