// app.js — main controller: state, rendering, and event wiring.
import { loadData } from "./data.js";
import { computeValues, normalizeVor } from "./value.js";
import { parseIntel, intelDelta, buildNameIndex, resolvePlayer } from "./intel.js";
import { fillRoster, positionNeeds, blendedScore, runAlerts, recommend } from "./draft.js";
import * as store from "./storage.js";

const STATE_KEYS = ["drafted", "intelLog", "weights", "pickNumber", "draftMode"];
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const S = {
  league: null, players: [], lexicon: null, dataMeta: null, seedIntel: { version: 0, entries: [] },
  values: [], byId: new Map(),
  drafted: store.load("drafted", {}),            // id -> "mine" | "other"
  intelLog: store.load("intelLog", []),          // [{id, source, snippet, matches:[{playerId,delta,name}]}]
  weights: store.load("weights", { vor: 1, adp: 0.6, need: 1, intel: 1 }),
  pickNumber: store.load("pickNumber", 1),
  draftMode: store.load("draftMode", false),      // must be enabled before any pick can be marked
  filterPos: "ALL", query: "", sortBy: "blend", hideDrafted: true,
  pendingReview: [],
};

init();

async function init() {
  const data = await loadData();
  S.league = data.league; S.players = data.players; S.lexicon = data.lexicon; S.dataMeta = data.dataMeta;
  S.seedIntel = data.seedIntel || { version: 0, entries: [] };
  populateSourceList();
  applySeedIntel(false);
  recompute();
  wireEvents();
  renderMode();
  render();
  $("#provenance").textContent =
    `Data: ${S.dataMeta.source}. Projections are a modeled starting point — edit data/players.json to refine.`;
}

// ---- core compute -------------------------------------------------------
function recompute() {
  const values = normalizeVor(computeValues(S.players, S.league));
  // aggregate intel deltas per player
  const deltas = {};
  for (const entry of S.intelLog)
    for (const m of entry.matches) deltas[m.playerId] = (deltas[m.playerId] || 0) + m.delta;
  for (const v of values) v.intelDelta = Math.round((deltas[v.id] || 0) * 10) / 10;
  S.values = values;
  S.byId = new Map(values.map((v) => [v.id, v]));
}

// Merge baked analyst intel (e.g. JagSays' RotoWire guide) into the Intel Log.
// Runs once per seed version (tracked in localStorage) so it isn't duplicated;
// force=true re-applies after a reset. Seed entries are editable/removable like
// any pasted intel.
function applySeedIntel(force) {
  const seed = S.seedIntel;
  if (!seed || !seed.entries || !seed.entries.length) return;
  const storedVer = store.load("intelSeedVersion", 0);
  if (!force && storedVer >= seed.version) return;
  const index = buildNameIndex(S.players);
  const existing = new Set(S.intelLog.map((e) => e.id));
  for (const e of seed.entries) {
    if (existing.has(e.id)) continue;
    const matches = [];
    for (const pl of e.players) {
      const p = resolvePlayer(pl.name, index);
      if (p) matches.push({ playerId: p.id, name: p.name, delta: pl.delta });
    }
    if (matches.length) S.intelLog.push({ id: e.id, source: seed.source || "@JagSays", snippet: e.snippet, matches, createdAt: Date.now(), seed: true });
  }
  store.save("intelLog", S.intelLog);
  store.save("intelSeedVersion", seed.version);
}

function availablePlayers() {
  return S.values.filter((p) => !S.drafted[p.id]);
}
function ctx() {
  const mine = S.values.filter((p) => S.drafted[p.id] === "mine");
  const slots = fillRoster(mine, S.league);
  const need = positionNeeds(slots);
  return { mine, slots, need, pickNumber: S.pickNumber };
}

// ---- rendering ----------------------------------------------------------
function render() { renderBoard(); renderSidebar(); }

function renderBoard() {
  const c = ctx();
  let rows = availablePlayers().slice();
  if (S.filterPos !== "ALL") {
    rows = S.filterPos === "FLEX"
      ? rows.filter((p) => ["RB", "WR", "TE"].includes(p.pos))
      : rows.filter((p) => p.pos === S.filterPos);
  }
  if (S.query) {
    const q = S.query.toLowerCase();
    rows = rows.filter((p) => p.name.toLowerCase().includes(q) || p.team.toLowerCase().includes(q));
  }
  for (const p of rows) p.blend = blendedScore(p, c, S.weights);
  const cmp = { blend: (a, b) => b.blend - a.blend, vor: (a, b) => b.vor - a.vor,
    proj: (a, b) => b.proj - a.proj, adp: (a, b) => a.adp - b.adp }[S.sortBy];
  rows.sort(cmp);

  const showDrafted = !S.hideDrafted;
  const body = $("#boardBody");
  body.innerHTML = rows.slice(0, 300).map((p, i) => rowHtml(p, i + 1)).join("");
  if (showDrafted) {
    const drafted = S.values.filter((p) => S.drafted[p.id]);
    body.innerHTML += drafted.map((p) => rowHtml(p, "", true)).join("");
  }
}

function rowHtml(p, rank, isDrafted = false) {
  const intel = p.intelDelta ? `<span class="intel-badge ${p.intelDelta > 0 ? "up" : "down"}">${p.intelDelta > 0 ? "▲" : "▼"}${Math.abs(p.intelDelta)}</span>` : "";
  const tierCls = `t${Math.min(p.tier, 6)}`;
  const who = S.drafted[p.id]; // "mine" | "other" | undefined
  const draftCls = isDrafted ? `drafted-row ${who === "mine" ? "mine-row" : "other-row"}` : "";
  return `<tr class="${draftCls} pos-${p.pos}" data-id="${p.id}">
    <td class="rk">${rank}</td>
    <td class="nm">${p.name}</td>
    <td><span class="pos-pill ${p.pos}">${p.pos}</span></td>
    <td class="tm">${p.team}</td>
    <td>${p.proj}</td>
    <td class="vor">${p.vor}</td>
    <td><span class="tier ${tierCls}">${p.tier}</span></td>
    <td class="adp">${p.adp}</td>
    <td>${intel}</td>
    <td class="score">${p.blend != null ? p.blend : ""}</td>
    <td class="act">
      ${isDrafted
        ? `<span class="draft-tag ${who}">${who === "mine" ? "✓ MINE" : "TAKEN"}</span>${S.draftMode ? `<button class="mini undo" data-act="undraft" data-id="${p.id}" title="Undo pick">↩</button>` : ""}`
        : S.draftMode
        ? `<button class="mini mine" data-act="mine" data-id="${p.id}" title="I drafted this player">＋ Me</button>
           <button class="mini other" data-act="other" data-id="${p.id}" title="Drafted by another team">Other</button>`
        : `<span class="locked" title="Press “Start Draft” to mark picks">🔒</span>`}
    </td>
  </tr>`;
}

function renderSidebar() {
  const c = ctx();
  // Recommendations + alerts
  const recs = recommend(availablePlayers(), c, S.weights, 6);
  const alerts = runAlerts(availablePlayers(), c.need);
  $("#alerts").innerHTML = alerts.length
    ? alerts.map((a) => `<div class="alert">⚠ <b>${a.pos} run:</b> only ${a.remaining} left in Tier ${a.tier} — you still need ${a.pos}. Prioritize.</div>`).join("")
    : "";
  $("#recList").innerHTML = recs.map((p) => `
    <li>
      <div class="rec-main">
        <span class="pos-pill ${p.pos}">${p.pos}</span>
        <b>${p.name}</b> <span class="tm">${p.team}</span>
        ${p.intelDelta ? `<span class="intel-badge ${p.intelDelta > 0 ? "up" : "down"}">${p.intelDelta > 0 ? "▲" : "▼"}${Math.abs(p.intelDelta)}</span>` : ""}
      </div>
      <div class="rec-meta">Score ${p.blend} · VOR ${p.vor} · Tier ${p.tier} · ADP ${p.adp}</div>
      ${S.draftMode
        ? `<button class="mini mine" data-act="mine" data-id="${p.id}">＋ Draft to my team</button>`
        : `<span class="locked-hint">🔒 Start Draft to pick</span>`}
    </li>`).join("");

  // My team
  const startPts = c.slots.filter((s) => s.label !== "BN" && s.player).reduce((a, s) => a + (s.player.proj || 0), 0);
  const drafted = Object.keys(S.drafted).length;
  $("#teamSummary").innerHTML = `
    <div class="stat"><span>${c.mine.length}</span>My picks</div>
    <div class="stat"><span>${Math.round(startPts)}</span>Proj starters</div>
    <div class="stat"><span>${drafted}</span>Off board</div>`;
  const byes = {};
  for (const s of c.slots) if (s.player && s.player.bye) (byes[s.player.bye] ||= []).push(s.player.pos);
  $("#rosterSlots").innerHTML = c.slots.map((s) => `
    <li class="slot ${s.player ? "filled" : "open"} ${s.label === "BN" ? "bench" : ""}">
      <span class="slot-label">${s.label}</span>
      ${s.player ? `<span class="slot-player">${s.player.name} <em>${s.player.team} · ${s.player.proj}</em></span>
        <button class="mini undo" data-act="undraft" data-id="${s.player.id}">↩</button>`
        : `<span class="slot-empty">— open —</span>`}
    </li>`).join("");
  const needList = Object.entries(c.need).filter(([k, v]) => v > 0 && k !== "FLEX");
  $("#needs").innerHTML = (needList.length || c.need.FLEX)
    ? `<h3>Still need</h3><div class="need-pills">${needList.map(([k, v]) => `<span class="need-pill">${k}×${v}</span>`).join("")}${c.need.FLEX ? `<span class="need-pill flex">FLEX×${c.need.FLEX}</span>` : ""}</div>`
    : `<h3>Starters full ✓</h3>`;

  renderIntelLog();
}

function renderIntelLog() {
  $("#intelLog").innerHTML = S.intelLog.length
    ? S.intelLog.map((e) => `
      <li>
        <div class="ilog-head"><b>${e.source}</b>${e.seed ? `<span class="seed-tag">baseline</span>` : ""} <button class="mini danger" data-act="del-intel" data-id="${e.id}">✕</button></div>
        <div class="ilog-snip">"${escapeHtml(e.snippet)}"</div>
        <div class="ilog-players">${e.matches.map((m) => `<span class="intel-badge ${m.delta > 0 ? "up" : "down"}">${m.name} ${m.delta > 0 ? "▲" : "▼"}${Math.abs(m.delta)}</span>`).join("")}</div>
      </li>`).join("")
    : `<li class="muted">No intel yet.</li>`;
}

// ---- intel review flow --------------------------------------------------
function analyzeIntel() {
  const text = $("#intelText").value.trim();
  const source = $("#intelSource").value.trim() || "manual";
  if (!text) return toast("Paste some text first.");
  const matches = parseIntel(text, S.players, S.lexicon);
  if (!matches.length) { $("#intelReview").innerHTML = `<p class="muted">No players matched. Try including full names.</p>`; return; }
  S.pendingReview = matches.map((m) => ({ ...m, source }));
  $("#intelReview").innerHTML = `
    <div class="review-box">
      <h3>Review &amp; confirm (${matches.length})</h3>
      ${S.pendingReview.map((m, i) => reviewRowHtml(m, i, source)).join("")}
      <button class="btn primary" id="btnConfirmIntel">Apply to rankings</button>
    </div>`;
}

function reviewRowHtml(m, i, source) {
  if (m.ambiguous) {
    return `<div class="review-row amb">
      <div class="rr-name">Ambiguous: "${m.token}"</div>
      <select data-review="${i}" class="amb-select">
        <option value="">— pick player —</option>
        ${m.candidates.map((c) => `<option value="${c.id}">${c.name} (${c.pos}·${c.team})</option>`).join("")}
      </select>
      <div class="rr-snip">"${escapeHtml(m.snippet)}"</div>
    </div>`;
  }
  const delta = intelDelta({ magnitude: m.magnitude, source }, S.lexicon);
  const dir = m.sentiment >= 0 ? "up" : "down";
  return `<div class="review-row" data-player="${m.player.id}" data-review="${i}">
    <div class="rr-name"><b>${m.player.name}</b> <span class="pos-pill ${m.player.pos}">${m.player.pos}</span>
      <span class="rr-delta ${dir}">${delta > 0 ? "+" : ""}${delta.toFixed(1)}</span></div>
    <input type="range" class="rr-slider" min="-30" max="30" step="1" value="${Math.round(delta)}" data-review="${i}">
    <div class="rr-snip">"${escapeHtml(m.snippet)}"</div>
  </div>`;
}

function confirmIntel() {
  const rows = $$(".review-row", $("#intelReview"));
  const matches = [];
  rows.forEach((row) => {
    const i = +row.dataset.review;
    const m = S.pendingReview[i];
    if (m.ambiguous) {
      const sel = $(".amb-select", row);
      if (sel && sel.value) {
        const p = S.byId.get(sel.value);
        matches.push({ playerId: sel.value, name: p.name, delta: 6 }); // default mild boost; user can re-run
      }
      return;
    }
    const slider = $(".rr-slider", row);
    const delta = +slider.value;
    if (delta !== 0) matches.push({ playerId: m.player.id, name: m.player.name, delta });
  });
  if (!matches.length) return toast("Nothing to apply.");
  const entry = { id: "in_" + Date.now(), source: $("#intelSource").value.trim() || "manual",
    snippet: $("#intelText").value.trim().slice(0, 200), matches, createdAt: Date.now() };
  S.intelLog.unshift(entry);
  persist(); recompute(); render();
  $("#intelText").value = ""; $("#intelReview").innerHTML = "";
  toast(`Applied intel to ${matches.length} player(s).`);
}

// ---- draft mode ---------------------------------------------------------
function toggleDraftMode(on) {
  S.draftMode = on == null ? !S.draftMode : on;
  store.save("draftMode", S.draftMode);
  renderMode();
  render();
  toast(S.draftMode ? "Draft Mode ON — picks unlocked." : "Draft paused — picks locked.");
}
function renderMode() {
  document.body.classList.toggle("draft-mode", S.draftMode);
  const b = $("#btnDraftMode");
  b.textContent = S.draftMode ? "● Draft Mode ON" : "▶ Start Draft";
  b.classList.toggle("on", S.draftMode);
  b.setAttribute("aria-pressed", String(S.draftMode));
  const banner = $("#modeBanner");
  banner.className = "mode-banner " + (S.draftMode ? "live" : "prep");
  banner.innerHTML = S.draftMode
    ? `🟢 <b>Draft Mode is live.</b> Marking a player removes them from the board. <button class="mini" id="btnPauseDraft">Pause</button>`
    : `🔒 <b>Prep mode.</b> Reviewing rankings — picks are locked. Press <b>Start Draft</b> to begin marking players as they're taken.`;
}

// ---- actions ------------------------------------------------------------
function draftPlayer(id, who) {
  if (!S.draftMode) return toast("Press “Start Draft” first to mark picks.");
  S.drafted[id] = who; S.pickNumber = Object.keys(S.drafted).length + 1; $("#pickNumber").value = S.pickNumber; persist(); render();
}
function undraft(id) {
  if (!S.draftMode) return toast("Draft Mode is off.");
  delete S.drafted[id]; S.pickNumber = Object.keys(S.drafted).length + 1; $("#pickNumber").value = S.pickNumber; persist(); render();
}

function persist() { store.save("drafted", S.drafted); store.save("intelLog", S.intelLog); store.save("weights", S.weights); store.save("pickNumber", S.pickNumber); store.save("draftMode", S.draftMode); }

// ---- events -------------------------------------------------------------
function wireEvents() {
  document.body.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (b) {
      const { act, id } = b.dataset;
      if (act === "mine") draftPlayer(id, "mine");
      else if (act === "other") draftPlayer(id, "other");
      else if (act === "undraft") undraft(id);
      else if (act === "del-intel") { S.intelLog = S.intelLog.filter((x) => x.id !== id); persist(); recompute(); render(); }
      return;
    }
    const posf = e.target.closest(".pos-filter");
    if (posf) { $$(".pos-filter").forEach((x) => x.classList.remove("active")); posf.classList.add("active"); S.filterPos = posf.dataset.pos; renderBoard(); return; }
    const tab = e.target.closest(".tab");
    if (tab) { $$(".tab").forEach((x) => x.classList.remove("active")); tab.classList.add("active");
      $$(".tab-panel").forEach((p) => p.classList.remove("active")); $("#tab-" + tab.dataset.tab).classList.add("active"); return; }
    if (e.target.id === "btnDraftMode") toggleDraftMode();
    if (e.target.id === "btnPauseDraft") toggleDraftMode(false);
    if (e.target.id === "btnParse") analyzeIntel();
    if (e.target.id === "btnConfirmIntel") confirmIntel();
    if (e.target.id === "btnSettings") $("#settingsDrawer").hidden = false;
    if (e.target.id === "btnCloseSettings") $("#settingsDrawer").hidden = true;
    if (e.target.id === "btnExport") doExport();
    if (e.target.id === "btnReset") doReset();
  });

  // live slider updates inside intel review
  $("#intelReview").addEventListener("input", (e) => {
    if (e.target.classList.contains("rr-slider")) {
      const row = e.target.closest(".review-row");
      const d = +e.target.value;
      const badge = $(".rr-delta", row);
      badge.textContent = (d > 0 ? "+" : "") + d;
      badge.className = "rr-delta " + (d >= 0 ? "up" : "down");
    }
  });

  $("#search").addEventListener("input", (e) => { S.query = e.target.value; renderBoard(); });
  $("#sortBy").addEventListener("change", (e) => { S.sortBy = e.target.value; renderBoard(); });
  $("#hideDrafted").addEventListener("change", (e) => { S.hideDrafted = e.target.checked; renderBoard(); });
  $("#pickNumber").addEventListener("change", (e) => { S.pickNumber = Math.max(1, +e.target.value || 1); persist(); render(); });

  // weight sliders
  for (const [id, key] of [["wVor", "vor"], ["wAdp", "adp"], ["wNeed", "need"], ["wIntel", "intel"]]) {
    const el = $("#" + id); el.value = S.weights[key];
    $(`[data-out="${id}"]`).textContent = (+el.value).toFixed(2);
    el.addEventListener("input", (e) => { S.weights[key] = +e.target.value; $(`[data-out="${id}"]`).textContent = (+e.target.value).toFixed(2); persist(); render(); });
  }

  $("#importFile").addEventListener("change", doImport);
  $("#pickNumber").value = S.pickNumber;
}

function doExport() {
  const bundle = store.exportState(STATE_KEYS);
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `huskies-draft-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  toast("Exported backup.");
}
function doImport(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      store.importState(JSON.parse(reader.result));
      S.drafted = store.load("drafted", {}); S.intelLog = store.load("intelLog", []);
      S.weights = store.load("weights", S.weights); S.pickNumber = store.load("pickNumber", 1);
      S.draftMode = store.load("draftMode", false);
      recompute(); renderMode(); render(); toast("Imported backup.");
    } catch (err) { toast("Import failed: " + err.message); }
  };
  reader.readAsText(file);
  e.target.value = "";
}
function doReset() {
  if (!confirm("Reset the draft board? This clears drafted players and any intel you added. The baked JagSays baseline stays.")) return;
  S.drafted = {}; S.intelLog = []; S.pickNumber = 1;
  store.save("intelSeedVersion", 0);
  applySeedIntel(true);
  persist(); recompute(); render(); toast("Draft reset — JagSays baseline restored.");
}

function populateSourceList() {
  const dl = $("#sourceList");
  dl.innerHTML = Object.keys(S.lexicon.sources || {}).map((s) => `<option value="${s}">`).join("");
}

// ---- utils --------------------------------------------------------------
let toastTimer;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600);
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
