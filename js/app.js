// app.js — main controller: state, rendering, and event wiring.
import { loadData } from "./data.js";
import { computeValues, normalizeVor } from "./value.js";
import { parseIntel, intelDelta, alphaDelta, buildNameIndex, resolvePlayer } from "./intel.js";
import { SLEEPER_PLAYERS_URL, matchSleeperInjuries, injuryAbbreviation, injuryImpact } from "./injuries.js";
import { fillRoster, positionNeeds, blendedScore, sourceDisagreement, defaultSortDirection, compareDraftPlayers, runAlerts, opponentDemand, planNextTwoPicks, playerRiskProfile, explainPick, recommend, attackNext, byeConflicts, optimalLineupPoints } from "./draft.js";
import { snakeOrder, pickNumbersForSlot, botPick, strategyPick, availabilityAtMyPicks } from "./simulator.js";
import * as store from "./storage.js";

const STATE_KEYS = ["drafted", "intelLog", "weights", "sourceTrust", "injuries", "injuryRefreshedAt", "pickNumber", "draftSlot", "draftMode"];
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const DEFAULT_WEIGHTS = { vor: 1, adp: 0.45, sleeper: 0.45, yahoo: 0.3, need: 1, intel: 1, injury: 1 };

const S = {
  league: null, players: [], lexicon: null, dataMeta: null, seedIntel: { version: 0, entries: [] },
  alphaDoc: { sources: [], entries: [] }, alphaRefreshing: false,
  values: [], byId: new Map(),
  drafted: store.load("drafted", {}),            // id -> "mine" | "other"
  intelLog: store.load("intelLog", []),          // [{id, source, snippet, matches:[{playerId,delta,name}]}]
  weights: { ...DEFAULT_WEIGHTS, ...store.load("weights", {}) },
  sourceTrust: store.load("sourceTrust", {}),
  injuries: store.load("injuries", {}),
  injuryRefreshedAt: store.load("injuryRefreshedAt", null),
  injuryRefreshing: false,
  pickNumber: store.load("pickNumber", 1),
  draftSlot: store.load("draftSlot", 2),
  draftMode: store.load("draftMode", false),      // must be enabled before any pick can be marked
  filterPos: "ALL", query: "", sortBy: "blend", sortDir: "desc", hideDrafted: true,
  pendingReview: [],
};

init();

async function init() {
  const data = await loadData();
  S.league = data.league; S.players = data.players; S.lexicon = data.lexicon; S.dataMeta = data.dataMeta;
  S.seedIntel = data.seedIntel || { version: 0, entries: [] };
  S.alphaDoc = data.alphaDoc || { sources: [], entries: [] };
  populateSourceList();
  populateSourceTrustControls();
  applySeedIntel(false);
  recompute();
  wireEvents();
  renderMode();
  render();
  renderProvenance();
}

// ---- core compute -------------------------------------------------------
function recompute() {
  const values = normalizeVor(computeValues(S.players, S.league));
  // aggregate intel deltas per player
  const manualDeltas = {}, alphaDeltas = {}, alphaInjuries = {};
  for (const entry of S.intelLog) {
    const trust = sourceTrust(entry.source);
    for (const m of entry.matches)
      manualDeltas[m.playerId] = (manualDeltas[m.playerId] || 0) + m.delta * trust;
  }
  for (const entry of S.alphaDoc.entries || []) {
    for (const m of entry.matches || []) {
      alphaDeltas[m.playerId] = (alphaDeltas[m.playerId] || 0)
        + alphaDelta(m.delta, sourceTrust(entry.source), entry.publishedAt);
      if (m.injury) {
        const candidate = { ...m.injury, source: entry.source, sourceUrl: entry.sourceUrl };
        if (!alphaInjuries[m.playerId]
          || (candidate.sourceUpdatedAt || 0) > (alphaInjuries[m.playerId].sourceUpdatedAt || 0))
          alphaInjuries[m.playerId] = candidate;
      }
    }
  }
  for (const v of values) {
    v.manualIntelDelta = Math.round((manualDeltas[v.id] || 0) * 10) / 10;
    v.alphaDelta = Math.round(Math.max(-15, Math.min(15, alphaDeltas[v.id] || 0)) * 10) / 10;
    v.intelDelta = Math.round((v.manualIntelDelta + v.alphaDelta) * 10) / 10;
    const sleeperInjury = S.injuries[v.id] || null;
    const reportInjury = alphaInjuries[v.id] || null;
    v.injury = reportInjury && (!sleeperInjury
      || (reportInjury.sourceUpdatedAt || 0) >= (sleeperInjury.sourceUpdatedAt || 0))
      ? reportInjury : sleeperInjury;
    v.injuryImpact = injuryImpact(v.injury);
    v.injuryDelta = v.injuryImpact.scorePenalty;
  }
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
  return S.values.filter((p) => !S.drafted[p.id] && !p.injuryImpact?.unavailable);
}

function ownerTeam(owner) {
  if (owner === "mine") return S.draftSlot;
  const match = /^team:(\d+)$/.exec(owner || "");
  return match ? +match[1] : null;
}

function allTeamRosters() {
  const rosters = Array.from({ length: S.league.teams }, () => []);
  for (const player of S.values) {
    const team = ownerTeam(S.drafted[player.id]);
    if (team != null && rosters[team]) rosters[team].push(player);
  }
  return rosters;
}

function planningContext() {
  const picks = pickNumbersForSlot(S.draftSlot, S.league.teams, S.league.roster.total)
    .filter((pick) => pick >= S.pickNumber);
  const currentTurn = picks[0] || null;
  const nextTurn = picks[1] || null;
  const order = snakeOrder(S.league.teams, S.league.roster.total);
  const upcomingTeams = currentTurn && nextTurn
    ? order.slice(currentTurn, nextTurn - 1).filter((team) => team !== S.draftSlot)
    : [];
  return { currentTurn, nextTurn, upcomingTeams: [...new Set(upcomingTeams)] };
}

// All intel blurbs affecting a player (for the hover popover).
function intelEntriesForPlayer(id) {
  const out = [];
  for (const e of S.intelLog) {
    const m = e.matches.find((x) => x.playerId === id);
    if (m) out.push({ source: e.source, snippet: e.snippet, delta: effectiveIntelDelta(m.delta, e.source) });
  }
  for (const e of S.alphaDoc.entries || []) {
    const m = (e.matches || []).find((x) => x.playerId === id);
    if (m) out.push({ source: e.source, snippet: e.snippet || e.title,
      delta: effectiveAlphaDelta(m.delta, e), auto: true, url: e.sourceUrl, publishedAt: e.publishedAt });
  }
  return out.sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0));
}

// Intel badge with a data hook so hovering/tapping it reveals the blurbs.
function intelBadgeHtml(p) {
  if (!p.intelDelta) return "";
  const cls = p.intelDelta > 0 ? "up" : "down";
  return `<span class="intel-badge ${cls}" data-intel="${p.id}" tabindex="0" title="">${p.intelDelta > 0 ? "▲" : "▼"}${Math.abs(p.intelDelta)}</span>`;
}

function injuryHtml(injury, impact) {
  if (!injury) return "";
  const status = escapeHtml(injury.status);
  const note = escapeHtml(injury.note || injury.status);
  const cls = String(injury.status).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const penalty = impact?.scorePenalty < 0 && !impact.unavailable ? ` · ranking ${impact.scorePenalty}` : "";
  return `<span class="injury-wrap" title="${status}${injury.note ? ` · ${note}` : ""}${penalty}">
    <span class="injury-badge ${cls}">${escapeHtml(injuryAbbreviation(injury.status))}</span>
    <span class="injury-note">${note}</span>
  </span>`;
}
function ctx() {
  const mine = S.values.filter((p) => S.drafted[p.id] === "mine");
  const slots = fillRoster(mine, S.league);
  const need = positionNeeds(slots);
  return { mine, slots, need, pickNumber: S.pickNumber, draftSlot: S.draftSlot };
}

// ---- rendering ----------------------------------------------------------
function render() { renderBoard(); renderSidebar(); renderInjuryButton(); renderAlphaButton(); }

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
  rows.sort((a, b) => compareDraftPlayers(a, b, S.sortBy, S.sortDir));
  renderSortHeaders();

  const showDrafted = !S.hideDrafted;
  const body = $("#boardBody");
  body.innerHTML = rows.slice(0, 300).map((p, i) => rowHtml(p, i + 1)).join("");
  if (showDrafted) {
    const drafted = S.values.filter((p) => S.drafted[p.id]);
    body.innerHTML += drafted.map((p) => rowHtml(p, "", true)).join("");
  }
}

function setBoardSort(sortBy) {
  S.sortDir = S.sortBy === sortBy
    ? (S.sortDir === "asc" ? "desc" : "asc")
    : defaultSortDirection(sortBy);
  S.sortBy = sortBy;
  $("#sortBy").value = sortBy;
  renderBoard();
}

function renderSortHeaders() {
  $$(`thead th[data-sort]`).forEach((th) => {
    const active = th.dataset.sort === S.sortBy;
    th.dataset.sortIndicator = active ? (S.sortDir === "asc" ? "▲" : "▼") : "";
    th.setAttribute("aria-sort", active ? (S.sortDir === "asc" ? "ascending" : "descending") : "none");
  });
}

function rowHtml(p, rank, isDrafted = false) {
  const intel = intelBadgeHtml(p);
  const tierCls = `t${Math.min(p.tier, 6)}`;
  const who = S.drafted[p.id]; // "mine" | "other" | undefined
  const owner = ownerTeam(who);
  const ownerLabel = who === "mine" ? "✓ MINE" : owner == null ? "TAKEN" : `TEAM ${owner + 1}`;
  const teamAtPick = snakeOrder(S.league.teams, S.league.roster.total)[S.pickNumber - 1];
  const gap = sourceDisagreement(p);
  const rankTitle = `FFC ${p.adp ?? "—"} · Sleeper ${p.sleeperAdp ?? "—"} · Yahoo ${p.yahooRank ?? "—"}`;
  const draftCls = isDrafted ? `drafted-row ${who === "mine" ? "mine-row" : "other-row"}` : "";
  return `<tr class="${draftCls} pos-${p.pos}" data-id="${p.id}">
    <td class="rk">${rank}</td>
    <td class="nm"><span class="player-name">${p.name}</span>${injuryHtml(p.injury, p.injuryImpact)}</td>
    <td><span class="pos-pill ${p.pos}">${p.pos}</span></td>
    <td class="tm">${p.team}</td>
    <td class="bye">${p.bye ?? "—"}</td>
    <td>${p.proj}</td>
    <td class="vor">${p.vor}</td>
    <td><span class="tier ${tierCls}">${p.tier}</span></td>
    <td class="adp">${p.adp ?? "—"}</td>
    <td class="adp">${p.sleeperAdp ?? "—"}</td>
    <td class="adp">${p.yahooRank ?? "—"}</td>
    <td title="${rankTitle}">${gap == null ? "—" : `<span class="source-gap ${gap >= 20 ? "hot" : ""}">${gap}</span>`}</td>
    <td>${intel}</td>
    <td class="score">${p.blend != null ? p.blend : ""}</td>
    <td class="act">
      ${isDrafted
        ? `<span class="draft-tag ${who === "mine" ? "mine" : "other"}">${ownerLabel}</span>${S.draftMode ? `<button class="mini undo" data-act="undraft" data-id="${p.id}" title="Undo pick">↩</button>` : ""}`
        : S.draftMode
        ? `<button class="mini mine" data-act="mine" data-id="${p.id}" title="I drafted this player">＋ Me</button>
           <button class="mini other" data-act="other" data-id="${p.id}" title="Drafted by Team ${(teamAtPick ?? 0) + 1} at pick #${S.pickNumber}">＋ T${(teamAtPick ?? 0) + 1}</button>`
        : `<span class="locked" title="Press “Start Draft” to mark picks">🔒</span>`}
    </td>
  </tr>`;
}

function renderSidebar() {
  const c = ctx();
  // Recommendations + alerts
  const available = availablePlayers();
  const recs = recommend(available, c, S.weights, 6);
  const alerts = runAlerts(available, c.need);
  const planning = planningContext();
  const demand = opponentDemand(allTeamRosters(), S.league, planning.upcomingTeams);
  const knownOpponentPicks = Object.values(S.drafted).filter((owner) => /^team:\d+$/.test(owner)).length;
  $("#opponentDemand").innerHTML = planning.nextTurn
    ? `<h2>Opponent pressure <span class="sub-inline">before your pick #${planning.nextTurn}</span></h2>
       <div class="demand-chips">${demand.filter((x) => x.teamsNeeding).slice(0, 6).map((x) =>
         `<span class="demand-chip ${x.teamsNeeding >= Math.max(3, x.teamsConsidered - 1) ? "hot" : ""}"><b>${x.pos}</b> ${x.teamsNeeding}/${x.teamsConsidered} teams need</span>`).join("")}</div>
       ${!knownOpponentPicks && Object.keys(S.drafted).length ? `<p class="context-note">Older “Other” picks are unassigned; new picks will be tracked by team.</p>` : ""}`
    : `<p class="context-note">Set your draft slot and pick number to see opponent pressure.</p>`;
  $("#alerts").innerHTML = alerts.length
    ? alerts.map((a) => `<div class="alert">⚠ <b>${a.pos} run:</b> only ${a.remaining} left in Tier ${a.tier} — you still need ${a.pos}. Prioritize.</div>`).join("")
    : "";

  // Attack Next — which position adds the most to your optimal starting lineup
  const an = attackNext(c.mine, available, S.league).filter((x) => x.gain > 0);
  const maxGain = an.length ? an[0].gain : 0;
  $("#attackNext").innerHTML = an.length
    ? `<h2>Attack Next <span class="sub-inline">value each position adds to your lineup</span></h2>
       <div class="attack-rows">${an.map((x, i) => `
         <div class="attack-row ${i === 0 ? "top" : ""}">
           <span class="pos-pill ${x.pos}">${x.pos}</span>
           <div class="attack-bar"><span style="width:${Math.max(4, (x.gain / maxGain) * 100)}%"></span></div>
           <span class="attack-gain">+${x.gain}</span>
           <span class="attack-best">${x.best.name}</span>
         </div>`).join("")}</div>`
    : "";

  const planCtx = { ...c, pickNumber: planning.currentTurn || c.pickNumber };
  const plans = planNextTwoPicks(available, planCtx, S.weights, S.league, planning.nextTurn, 2);
  $("#twoPickPlan").innerHTML = plans.length
    ? `<h2>Two-pick plan <span class="sub-inline">picks #${planning.currentTurn} and #${planning.nextTurn}</span></h2>
       ${plans.map((plan) => `<div class="plan-row">
         <div><span class="plan-step">Pick ${planning.currentTurn}</span><b>${plan.now.name}</b> <span class="pos-pill ${plan.now.pos}">${plan.now.pos}</span></div>
         <div><span class="plan-arrow">→</span><span class="plan-step">Pick ${plan.nextPick}</span><b>${plan.next?.name || "Best available"}</b>${plan.next ? ` <span class="pos-pill ${plan.next.pos}">${plan.next.pos}</span>` : ""}</div>
         ${plan.pivot ? `<div class="plan-pivot">Pivot if gone: ${plan.pivot.name} (${plan.pivot.pos})</div>` : ""}
       </div>`).join("")}`
    : "";

  $("#recList").innerHTML = recs.map((p) => {
    const intelSources = intelEntriesForPlayer(p.id).filter((x) => x.delta > 0).map((x) => x.source);
    const byeConflictCount = p.bye ? c.slots.filter((s) => s.label !== "BN" && s.player?.bye === p.bye).length : 0;
    const why = explainPick(p, c, S.weights, { available, runAlerts: alerts, intelSources, byeConflictCount });
    const risk = playerRiskProfile(p);
    return `
    <li>
      <div class="rec-main">
        <span class="pos-pill ${p.pos}">${p.pos}</span>
        <b>${p.name}</b> <span class="tm">${p.team}</span>
        ${injuryHtml(p.injury, p.injuryImpact)}
        ${intelBadgeHtml(p)}
      </div>
      <div class="rec-meta">Score ${p.blend} · VOR ${p.vor} · Tier ${p.tier} · ADP ${p.adp}</div>
      <div class="risk-profile" title="Modeled from position volatility, injuries, analyst concern, and ranking-source disagreement">
        <span>Floor <b>${risk.floor}</b></span><span>Median <b>${p.proj}</b></span><span>Ceiling <b>${risk.ceiling}</b></span>
        <span class="risk-label ${risk.label.toLowerCase().replace(/\s+/g, "-")}">${risk.label}</span>
      </div>
      <details class="rec-why">
        <summary aria-label="Why this pick for ${escapeHtml(p.name)}?">Why this pick? <span class="why-label">${escapeHtml(why.label)}</span></summary>
        <div class="why-chips">
          ${why.reasons.map((reason) => `<span class="why-chip">${escapeHtml(reason)}</span>`).join("")}
          ${why.warnings.map((warning) => `<span class="why-chip warning">${escapeHtml(warning)}</span>`).join("")}
          ${!why.reasons.length && !why.warnings.length ? `<span class="why-chip neutral">Balanced with your current settings</span>` : ""}
        </div>
      </details>
      ${S.draftMode
        ? `<button class="mini mine" data-act="mine" data-id="${p.id}">＋ Draft to my team</button>`
        : `<span class="locked-hint">🔒 Start Draft to pick</span>`}
    </li>`;
  }).join("");

  // My team
  const startPts = optimalLineupPoints(c.mine, S.league);
  const drafted = Object.keys(S.drafted).length;
  $("#teamSummary").innerHTML = `
    <div class="stat"><span>${c.mine.length}</span>My picks</div>
    <div class="stat"><span>${Math.round(startPts)}</span>Starter pts</div>
    <div class="stat"><span>${drafted}</span>Off board</div>`;
  $("#rosterSlots").innerHTML = c.slots.map((s) => `
    <li class="slot ${s.player ? "filled" : "open"} ${s.label === "BN" ? "bench" : ""}">
      <span class="slot-label">${s.label}</span>
      ${s.player ? `<span class="slot-player">${s.player.name} <em>${s.player.team} · B${s.player.bye || "—"} · ${s.player.proj}</em></span>
        <button class="mini undo" data-act="undraft" data-id="${s.player.id}">↩</button>`
        : `<span class="slot-empty">— open —</span>`}
    </li>`).join("");
  const needList = Object.entries(c.need).filter(([k, v]) => v > 0 && k !== "FLEX");
  $("#needs").innerHTML = (needList.length || c.need.FLEX)
    ? `<h3>Still need</h3><div class="need-pills">${needList.map(([k, v]) => `<span class="need-pill">${k}×${v}</span>`).join("")}${c.need.FLEX ? `<span class="need-pill flex">FLEX×${c.need.FLEX}</span>` : ""}</div>`
    : `<h3>Starters full ✓</h3>`;

  // Bye conflicts among starters
  const conflicts = byeConflicts(c.slots, 2);
  $("#byeConflicts").innerHTML = `<h3>Bye weeks</h3>` + (conflicts.length
    ? conflicts.map((w) => `<div class="bye-warn ${w.count >= 3 ? "bad" : ""}">⚠ <b>Week ${w.week}:</b> ${w.count} starters out (${w.players.map((p) => p.pos).join(", ")})</div>`).join("")
    : `<div class="bye-ok">No starter bye stacks ✓</div>`);

  const teamRosters = allTeamRosters();
  $("#opponentRosters").innerHTML = `<h3>Opponent rosters</h3>` + teamRosters
    .map((roster, team) => ({ roster, team }))
    .filter(({ team }) => team !== S.draftSlot)
    .map(({ roster, team }) => {
      const counts = Object.fromEntries(["QB", "RB", "WR", "TE", "K", "DEF"].map((pos) => [pos, roster.filter((p) => p.pos === pos).length]));
      const need = positionNeeds(fillRoster(roster, S.league));
      const topNeeds = ["RB", "WR", "QB", "TE", "K", "DEF"].filter((pos) => need[pos] > 0).slice(0, 3);
      return `<div class="opponent-row"><b>Team ${team + 1}</b><span>${roster.length} picks</span>
        <div class="opponent-counts">${Object.entries(counts).filter(([, count]) => count).map(([pos, count]) => `${pos}×${count}`).join(" · ") || "No picks yet"}</div>
        <div class="opponent-needs">Needs: ${topNeeds.join(", ") || "starters filled"}</div></div>`;
    }).join("");

  renderAlphaLog();
  renderIntelLog();
}

function renderAlphaLog() {
  const summary = $("#alphaSummary"), sourceList = $("#alphaSources"), log = $("#alphaLog");
  if (!summary || !sourceList || !log) return;
  const sources = S.alphaDoc.sources || [], entries = S.alphaDoc.entries || [];
  const healthy = sources.filter((source) => source.ok).length;
  const when = S.alphaDoc.generatedAt ? new Date(S.alphaDoc.generatedAt).toLocaleString() : "not loaded";
  summary.textContent = `${entries.length} signals · ${healthy}/${sources.length || 10} sources healthy · ${when}. Signals decay after 7 days and expire after 45.`;
  sourceList.innerHTML = sources.map((source) => `<a class="alpha-source ${source.ok ? "ok" : "failed"}"
    href="${escapeHtml(source.url)}" target="_blank" rel="noopener" title="${escapeHtml(source.ok ? `${source.matched} strict matches` : source.error || "Refresh failed")}">
    ${source.ok ? "✓" : "!"} ${escapeHtml(source.name)}</a>`).join("");
  log.innerHTML = entries.length ? entries.slice(0, 12).map((entry) => `
    <li>
      <div class="ilog-head"><b>${escapeHtml(entry.source)}</b><span class="seed-tag auto-tag">auto</span><span class="trust-tag">×${sourceTrust(entry.source).toFixed(2)}</span></div>
      <a class="alpha-link" href="${escapeHtml(entry.sourceUrl)}" target="_blank" rel="noopener">${escapeHtml(entry.title)}</a>
      <div class="ilog-players">${(entry.matches || []).map((m) => { const d = effectiveAlphaDelta(m.delta, entry); return `<span class="intel-badge ${d > 0 ? "up" : "down"}">${escapeHtml(m.name)} ${d > 0 ? "▲" : "▼"}${Math.abs(d)}</span>`; }).join("")}</div>
    </li>`).join("") : `<li class="muted">No strict player + camp-signal matches in the current feeds.</li>`;
}

function renderIntelLog() {
  $("#intelLog").innerHTML = S.intelLog.length
    ? S.intelLog.map((e) => `
      <li>
        <div class="ilog-head"><b>${escapeHtml(e.source)}</b>${e.seed ? `<span class="seed-tag">baseline</span>` : ""} <span class="trust-tag">×${sourceTrust(e.source).toFixed(2)}</span> <button class="mini danger" data-act="del-intel" data-id="${e.id}">✕</button></div>
        <div class="ilog-snip">"${escapeHtml(e.snippet)}"</div>
        <div class="ilog-players">${e.matches.map((m) => { const d = effectiveIntelDelta(m.delta, e.source); return `<span class="intel-badge ${d > 0 ? "up" : "down"}">${escapeHtml(m.name)} ${d > 0 ? "▲" : "▼"}${Math.abs(d)}</span>`; }).join("")}</div>
      </li>`).join("")
    : `<li class="muted">No intel yet.</li>`;
}

function renderInjuryButton() {
  const button = $("#btnInjuries");
  if (!button) return;
  const count = Object.keys(S.injuries).length;
  const removed = S.values.filter((p) => p.injuryImpact?.unavailable).length;
  button.disabled = S.injuryRefreshing;
  button.textContent = S.injuryRefreshing ? "🏥 Refreshing…" : `🏥 Injuries${count ? ` (${count})` : ""}`;
  button.title = S.injuryRefreshedAt
    ? `Refresh from Sleeper · last updated ${new Date(S.injuryRefreshedAt).toLocaleString()}${removed ? ` · ${removed} season-ending removal(s)` : ""}`
    : "Refresh injury designations from Sleeper";
}

function renderAlphaButton() {
  const button = $("#btnAlpha");
  if (!button) return;
  const count = (S.alphaDoc.entries || []).length;
  button.disabled = S.alphaRefreshing;
  button.textContent = S.alphaRefreshing ? "📡 Loading…" : `📡 Alpha${count ? ` (${count})` : ""}`;
}

function renderProvenance() {
  const marketDate = S.dataMeta.rankingsGeneratedAt ? new Date(S.dataMeta.rankingsGeneratedAt).toLocaleDateString() : "not loaded";
  const injuryDate = S.injuryRefreshedAt ? new Date(S.injuryRefreshedAt).toLocaleString() : "not refreshed";
  const alphaDate = S.alphaDoc.generatedAt ? new Date(S.alphaDoc.generatedAt).toLocaleString() : "not loaded";
  $("#provenance").innerHTML = `Projections: ${escapeHtml(S.dataMeta.source)}. Yahoo + Sleeper ranks captured ${marketDate}. Preseason alpha: 10 public sources (${alphaDate}). Injuries: <a href="https://sleeper.com/" target="_blank" rel="noopener">Sleeper</a> (${injuryDate}).`;
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
    return `<div class="review-row amb" data-review="${i}">
      <div class="rr-name">Ambiguous: "${m.token}"</div>
      <select data-review="${i}" class="amb-select">
        <option value="">— pick player —</option>
        ${m.candidates.map((c) => `<option value="${c.id}">${c.name} (${c.pos}·${c.team})</option>`).join("")}
      </select>
      <div class="rr-snip">"${escapeHtml(m.snippet)}"</div>
    </div>`;
  }
  const delta = intelDelta({ magnitude: m.magnitude, source }, S.lexicon, S.sourceTrust);
  const dir = m.sentiment >= 0 ? "up" : "down";
  return `<div class="review-row" data-player="${m.player.id}" data-review="${i}">
    <div class="rr-name"><b>${m.player.name}</b> <span class="pos-pill ${m.player.pos}">${m.player.pos}</span>
      <span class="rr-delta ${dir}">${delta > 0 ? "+" : ""}${delta.toFixed(1)}</span></div>
    <input type="range" class="rr-slider" min="-30" max="30" step="1" value="${Math.round(m.magnitude)}" data-review="${i}" title="Raw take strength; source trust is applied separately">
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
  const teamAtPick = snakeOrder(S.league.teams, S.league.roster.total)[S.pickNumber - 1];
  S.drafted[id] = who === "other" && teamAtPick != null ? `team:${teamAtPick}` : who;
  S.pickNumber = Object.keys(S.drafted).length + 1; $("#pickNumber").value = S.pickNumber; persist(); render();
}
function undraft(id) {
  if (!S.draftMode) return toast("Draft Mode is off.");
  delete S.drafted[id]; S.pickNumber = Object.keys(S.drafted).length + 1; $("#pickNumber").value = S.pickNumber; persist(); render();
}

function persist() { store.save("drafted", S.drafted); store.save("intelLog", S.intelLog); store.save("weights", S.weights); store.save("sourceTrust", S.sourceTrust); store.save("injuries", S.injuries); store.save("injuryRefreshedAt", S.injuryRefreshedAt); store.save("pickNumber", S.pickNumber); store.save("draftSlot", S.draftSlot); store.save("draftMode", S.draftMode); }

async function refreshInjuries() {
  if (S.injuryRefreshing) return;
  S.injuryRefreshing = true;
  renderInjuryButton();
  try {
    const response = await fetch(SLEEPER_PLAYERS_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`Sleeper returned ${response.status}`);
    const sleeperPlayers = await response.json();
    const { injuries, matched } = matchSleeperInjuries(S.players, sleeperPlayers);
    S.injuries = injuries;
    S.injuryRefreshedAt = Date.now();
    persist(); recompute(); render(); renderProvenance();
    toast(`Updated ${Object.keys(injuries).length} injury designations across ${matched} matched players.`);
  } catch (err) {
    toast(`Injury refresh failed — keeping saved data. ${err.message}`);
  } finally {
    S.injuryRefreshing = false;
    renderInjuryButton();
  }
}

async function refreshAlpha() {
  if (S.alphaRefreshing) return;
  S.alphaRefreshing = true;
  renderAlphaButton();
  try {
    const response = await fetch(`data/preseason-alpha.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`snapshot returned ${response.status}`);
    S.alphaDoc = await response.json();
    recompute(); render(); renderProvenance();
    toast(`Loaded ${(S.alphaDoc.entries || []).length} current preseason signals.`);
  } catch (err) {
    toast(`Alpha refresh failed — keeping the loaded snapshot. ${err.message}`);
  } finally {
    S.alphaRefreshing = false;
    renderAlphaButton();
  }
}

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
    const sortHeader = e.target.closest("thead th[data-sort]");
    if (sortHeader) { setBoardSort(sortHeader.dataset.sort); return; }
    const tab = e.target.closest(".tab");
    if (tab) { $$(".tab").forEach((x) => x.classList.remove("active")); tab.classList.add("active");
      $$(".tab-panel").forEach((p) => p.classList.remove("active")); $("#tab-" + tab.dataset.tab).classList.add("active"); return; }
    if (e.target.id === "btnDraftMode") toggleDraftMode();
    if (e.target.id === "btnPauseDraft") toggleDraftMode(false);
    if (e.target.id === "btnParse") analyzeIntel();
    if (e.target.id === "btnInjuries") refreshInjuries();
    if (e.target.id === "btnAlpha") refreshAlpha();
    if (e.target.id === "btnConfirmIntel") confirmIntel();
    if (e.target.id === "btnSettings") $("#settingsDrawer").hidden = false;
    if (e.target.id === "btnCloseSettings") $("#settingsDrawer").hidden = true;
    if (e.target.id === "btnExport") doExport();
    if (e.target.id === "btnReset") doReset();
  });
  $("#boardTable thead").addEventListener("keydown", (e) => {
    const sortHeader = e.target.closest("th[data-sort]");
    if (sortHeader && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      setBoardSort(sortHeader.dataset.sort);
    }
  });

  // mock draft simulator
  $("#btnSim").addEventListener("click", openSim);
  $("#simModal").addEventListener("click", (e) => {
    const pickBtn = e.target.closest("[data-sim-pick]");
    if (pickBtn) return userSimPick(pickBtn.dataset.simPick);
    const posf = e.target.closest("[data-sim-pos]");
    if (posf && SIM) { SIM.filterPos = posf.dataset.simPos; renderSim(); return; }
    const id = e.target.id;
    if (id === "simClose") closeSim();
    else if (id === "simStart") startSim();
    else if (id === "simQuick") runQuickSim();
    else if (id === "simAutoPick") autoPickUser();
    else if (id === "simToEnd") { SIM.autopilot = true; advanceSim(); }
    else if (id === "simRestart" || id === "simRunAgain") renderSimSetup();
  });

  // intel blurb popover — hover (desktop), focus (keyboard), tap (touch)
  document.body.addEventListener("mouseover", (e) => {
    const b = e.target.closest(".intel-badge[data-intel]");
    if (b) showIntelTip(b);
  });
  document.body.addEventListener("mouseout", (e) => {
    if (e.target.closest(".intel-badge[data-intel]")) hideIntelTip();
  });
  document.body.addEventListener("focusin", (e) => {
    const b = e.target.closest && e.target.closest(".intel-badge[data-intel]");
    if (b) showIntelTip(b);
  });
  document.body.addEventListener("click", (e) => {
    const b = e.target.closest(".intel-badge[data-intel]");
    if (b) { e.stopPropagation(); ($("#intelTip").hidden ? showIntelTip(b) : hideIntelTip()); }
    else hideIntelTip();
  });
  document.addEventListener("scroll", hideIntelTip, true);

  // live slider updates inside intel review
  $("#intelReview").addEventListener("input", (e) => {
    if (e.target.classList.contains("rr-slider")) {
      const row = e.target.closest(".review-row");
      const pending = S.pendingReview[+e.target.dataset.review];
      const d = intelDelta({ magnitude: +e.target.value, source: pending.source }, S.lexicon, S.sourceTrust);
      const badge = $(".rr-delta", row);
      badge.textContent = (d > 0 ? "+" : "") + d.toFixed(1);
      badge.className = "rr-delta " + (d >= 0 ? "up" : "down");
    }
  });

  $("#search").addEventListener("input", (e) => { S.query = e.target.value; renderBoard(); });
  $("#sortBy").addEventListener("change", (e) => { S.sortBy = e.target.value; S.sortDir = defaultSortDirection(S.sortBy); renderBoard(); });
  $("#hideDrafted").addEventListener("change", (e) => { S.hideDrafted = e.target.checked; renderBoard(); });
  $("#pickNumber").addEventListener("change", (e) => { S.pickNumber = Math.max(1, +e.target.value || 1); persist(); render(); });
  $("#draftSlot").addEventListener("change", (e) => { S.draftSlot = Math.max(0, Math.min(S.league.teams - 1, +e.target.value || 0)); persist(); render(); });

  // weight sliders
  for (const [id, key] of [["wVor", "vor"], ["wAdp", "adp"], ["wSleeper", "sleeper"], ["wYahoo", "yahoo"], ["wNeed", "need"], ["wIntel", "intel"], ["wInjury", "injury"]]) {
    const el = $("#" + id); el.value = S.weights[key];
    $(`[data-out="${id}"]`).textContent = (+el.value).toFixed(2);
    el.addEventListener("input", (e) => { S.weights[key] = +e.target.value; $(`[data-out="${id}"]`).textContent = (+e.target.value).toFixed(2); persist(); render(); });
  }

  wireSourceTrustEvents();

  $("#importFile").addEventListener("change", doImport);
  $("#pickNumber").value = S.pickNumber;
  $("#draftSlot").value = S.draftSlot;
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
      S.weights = { ...DEFAULT_WEIGHTS, ...store.load("weights", {}) };
      S.sourceTrust = store.load("sourceTrust", {}); S.pickNumber = store.load("pickNumber", 1);
      S.draftSlot = store.load("draftSlot", 2);
      S.injuries = store.load("injuries", {}); S.injuryRefreshedAt = store.load("injuryRefreshedAt", null);
      S.draftMode = store.load("draftMode", false);
      $("#draftSlot").value = S.draftSlot; populateSourceTrustControls(); wireSourceTrustEvents(); recompute(); renderMode(); render(); renderProvenance(); toast("Imported backup.");
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

function sourceTrust(source) {
  return S.sourceTrust[source] ?? S.lexicon.sources?.[source] ?? S.lexicon.defaultTrust ?? 1;
}

function effectiveIntelDelta(rawDelta, source) {
  return Math.round(rawDelta * sourceTrust(source) * 10) / 10;
}

function effectiveAlphaDelta(rawDelta, entry) {
  return alphaDelta(rawDelta, sourceTrust(entry.source), entry.publishedAt);
}

function populateSourceTrustControls() {
  const root = $("#sourceTrustControls");
  if (!root || !S.lexicon) return;
  root.innerHTML = Object.entries(S.lexicon.sources || {}).map(([source, fallback]) => {
    const value = S.sourceTrust[source] ?? fallback;
    const meta = S.lexicon.sourceMeta?.[source];
    return `<label title="${escapeHtml(meta?.note || "")}">${escapeHtml(source)}${meta?.name ? ` <em>${escapeHtml(meta.name)}</em>` : ""}
      <input type="range" min="0" max="2" step="0.05" value="${value}" data-source-trust="${escapeHtml(source)}">
      <span data-trust-out>${value.toFixed(2)}</span></label>`;
  }).join("");
}

function wireSourceTrustEvents() {
  for (const el of $$('[data-source-trust]')) {
    if (el.dataset.wired) continue;
    el.dataset.wired = "1";
    el.addEventListener("input", (e) => {
      const source = e.target.dataset.sourceTrust;
      S.sourceTrust[source] = +e.target.value;
      e.target.closest("label").querySelector("[data-trust-out]").textContent = (+e.target.value).toFixed(2);
      persist(); recompute(); render();
    });
  }
}

// ---- mock draft simulator (isolated state) ------------------------------
let SIM = null;

function openSim() { $("#simModal").hidden = false; renderSimSetup(); }
function closeSim() { $("#simModal").hidden = true; SIM = null; }

function slotSuffix(i) { return ["st", "nd", "rd", "th", "th", "th"][i] || "th"; }

function renderSimSetup() {
  const teams = S.league.teams;
  $("#simBody").innerHTML = `
    <div class="sim-setup">
      <p class="hint">Rehearse your draft from your slot. Bots draft by ADP with realistic reach and positional discipline; you pick at your turns. Nothing here touches your real draft board.</p>
      <div class="sim-setup-grid">
        <label class="fld">Your draft slot
          <select id="simSlot">${Array.from({ length: teams }, (_, i) => `<option value="${i}"${i === 2 ? " selected" : ""}>${i + 1}${slotSuffix(i)} of ${teams}</option>`).join("")}</select>
        </label>
        <label class="fld">Autopilot strategy
          <select id="simStrategy">
            <option value="best">Best available (value)</option>
            <option value="zero-rb">Zero-RB</option>
            <option value="hero-rb">Hero-RB</option>
          </select>
        </label>
      </div>
      <div class="sim-setup-actions">
        <button class="btn primary" id="simStart">Start mock draft →</button>
        <button class="btn ghost" id="simQuick">⚡ Quick sim ×25</button>
      </div>
      <div id="simQuickOut" class="sim-quick-out"></div>
    </div>`;
}

function runQuickSim() {
  const teams = S.league.teams, rounds = S.league.roster.total;
  const slot = +$("#simSlot").value;
  $("#simQuickOut").innerHTML = `<p class="muted">Running 25 sims…</p>`;
  setTimeout(() => {
    const eligible = S.values.filter((p) => !p.injuryImpact?.unavailable);
    const out = availabilityAtMyPicks(eligible, new Map(eligible.map((p) => [p.id, p])), teams, rounds, slot, 25);
    $("#simQuickOut").innerHTML = `<h3>Typically available at your picks (25 sims)</h3>` +
      out.map((r) => `<div class="qs-row"><b>Rd ${r.round} · #${r.pick}</b> ${r.players.map((p) => `<span class="qs-p ${p.pos}">${p.name} ${Math.round(p.prob * 100)}%</span>`).join(" ")}</div>`).join("");
  }, 20);
}

function startSim() {
  const teams = S.league.teams, rounds = S.league.roster.total;
  SIM = {
    teams, rounds,
    slot: +$("#simSlot").value,
    strategy: $("#simStrategy").value,
    order: snakeOrder(teams, rounds),
    i: 0,
    avail: new Set(S.values.filter((p) => !p.injuryImpact?.unavailable).map((p) => p.id)),
    counts: Array.from({ length: teams }, () => ({})),
    rosters: Array.from({ length: teams }, () => []),
    feed: [],
    filterPos: "ALL",
    autopilot: false,
    done: false,
  };
  advanceSim();
}

const simAvailList = () => S.values.filter((p) => SIM.avail.has(p.id));

// Need-aware value function for the user's autopilot picks — mirrors the real
// board's blended score so "sim to end" builds a balanced roster, not a stack.
function userValueFn() {
  const s = SIM;
  const ctx = { need: positionNeeds(fillRoster(s.rosters[s.slot], S.league)), pickNumber: s.i + 1 };
  return (p) => blendedScore(p, ctx, S.weights);
}

function applySimPick(team, p, round) {
  const s = SIM;
  s.avail.delete(p.id);
  s.counts[team][p.pos] = (s.counts[team][p.pos] || 0) + 1;
  s.rosters[team].push(p);
  s.feed.unshift({ overall: s.i + 1, round, team, player: p, mine: team === s.slot });
  s.i++;
}

function advanceSim() {
  const s = SIM;
  while (s.i < s.order.length) {
    const team = s.order[s.i];
    const round = Math.floor(s.i / s.teams) + 1;
    if (team === s.slot && !s.autopilot) { renderSim(); return; }
    const list = simAvailList();
    const pick = team === s.slot
      ? strategyPick(list, s.counts[team], round, s.rounds, s.strategy, userValueFn())
      : botPick(list, s.counts[team], round, s.rounds);
    applySimPick(team, pick, round);
  }
  s.done = true;
  renderSim();
}

function userSimPick(id) {
  const s = SIM;
  if (!s || s.done || s.order[s.i] !== s.slot) return;
  const p = S.byId.get(id);
  if (!p || !s.avail.has(id)) return;
  applySimPick(s.slot, p, Math.floor(s.i / s.teams) + 1);
  advanceSim();
}

function autoPickUser() {
  const s = SIM;
  if (!s || s.order[s.i] !== s.slot) return;
  const round = Math.floor(s.i / s.teams) + 1;
  applySimPick(s.slot, strategyPick(simAvailList(), s.counts[s.slot], round, s.rounds, s.strategy, userValueFn()), round);
  advanceSim();
}

function renderSim() {
  const s = SIM;
  if (!s) return;
  if (s.done) return renderSimResults();
  const team = s.order[s.i];
  const round = Math.floor(s.i / s.teams) + 1;
  const onClock = team === s.slot;
  const myPlayers = s.rosters[s.slot];
  const slots = fillRoster(myPlayers, S.league);
  const ctx = { need: positionNeeds(slots), pickNumber: s.i + 1 };
  let list = simAvailList();
  if (s.filterPos !== "ALL") list = s.filterPos === "FLEX"
    ? list.filter((p) => ["RB", "WR", "TE"].includes(p.pos))
    : list.filter((p) => p.pos === s.filterPos);
  const ranked = list.map((p) => ({ p, blend: blendedScore(p, ctx, S.weights) }))
    .sort((a, b) => b.blend - a.blend).slice(0, 60);

  $("#simBody").innerHTML = `
    <div class="sim-draft">
      <div class="sim-status ${onClock ? "live" : ""}">
        <div>
          <div class="sim-round">Round ${round} · Pick #${s.i + 1} of ${s.order.length}</div>
          <div class="sim-clock">${onClock ? "🟢 YOUR PICK — draft a player" : `Team ${team + 1} on the clock…`}</div>
        </div>
        <div class="sim-actions">
          ${onClock ? `<button class="mini mine" id="simAutoPick">Auto-pick</button>` : ""}
          <button class="mini" id="simToEnd">Sim to end ▶▶</button>
          <button class="mini" id="simRestart">↺ Restart</button>
        </div>
      </div>
      <div class="sim-cols">
        <div class="sim-board">
          <div class="sim-filters">${["ALL", "QB", "RB", "WR", "TE", "FLEX", "K", "DEF"].map((x) => `<button class="pos-filter ${s.filterPos === x ? "active" : ""}" data-sim-pos="${x}">${x === "ALL" ? "All" : x}</button>`).join("")}</div>
          <div class="sim-list">
            ${ranked.map(({ p, blend }) => `
              <div class="sim-p">
                <span class="pos-pill ${p.pos}">${p.pos}</span>
                <span class="sim-p-name">${p.name} <em>${p.team}·B${p.bye || "—"}</em></span>
                <span class="sim-p-meta">VOR ${p.vor} · ADP ${p.adp}${p.intelDelta ? ` · <span class="intel-badge ${p.intelDelta > 0 ? "up" : "down"}">${p.intelDelta > 0 ? "▲" : "▼"}${Math.abs(p.intelDelta)}</span>` : ""}</span>
                ${onClock ? `<button class="mini mine" data-sim-pick="${p.id}">Draft</button>` : `<span class="sim-p-blend">${blend}</span>`}
              </div>`).join("")}
          </div>
        </div>
        <div class="sim-side">
          <h3>Your roster · Team ${s.slot + 1}</h3>
          <ul class="roster sim-roster">${slots.map((sl) => `<li class="slot ${sl.player ? "filled" : "open"} ${sl.label === "BN" ? "bench" : ""}"><span class="slot-label">${sl.label}</span>${sl.player ? `<span class="slot-player">${sl.player.name} <em>${sl.player.team}·${sl.player.proj}</em></span>` : `<span class="slot-empty">—</span>`}</li>`).join("")}</ul>
          <h3>Pick feed</h3>
          <ul class="sim-feed">${s.feed.slice(0, 16).map((f) => `<li class="${f.mine ? "mine" : ""}"><b>${f.round}.${String(((f.overall - 1) % s.teams) + 1).padStart(2, "0")}</b> ${f.mine ? "★ " : ""}T${f.team + 1}: ${f.player.name} <span class="pos-pill ${f.player.pos}">${f.player.pos}</span></li>`).join("")}</ul>
        </div>
      </div>
    </div>`;
}

function renderSimResults() {
  const s = SIM;
  const myPlayers = s.rosters[s.slot];
  const slots = fillRoster(myPlayers, S.league);
  const myPts = optimalLineupPoints(myPlayers, S.league);
  const allPts = s.rosters.map((r) => optimalLineupPoints(r, S.league));
  const rank = [...allPts].sort((a, b) => b - a).indexOf(myPts) + 1;
  $("#simBody").innerHTML = `
    <div class="sim-results">
      <div class="sim-grade">
        <div class="stat"><span>${Math.round(myPts)}</span>Starter pts</div>
        <div class="stat"><span>#${rank} / ${s.teams}</span>Roster strength</div>
        <div class="stat"><span>${myPlayers.length}</span>Players</div>
      </div>
      <h3>Your team</h3>
      <ul class="roster">${slots.map((sl) => `<li class="slot ${sl.player ? "filled" : "open"} ${sl.label === "BN" ? "bench" : ""}"><span class="slot-label">${sl.label}</span>${sl.player ? `<span class="slot-player">${sl.player.name} <em>${sl.player.team}·B${sl.player.bye || "—"}·${sl.player.proj}</em></span>` : `<span class="slot-empty">—</span>`}</li>`).join("")}</ul>
      <div class="sim-setup-actions">
        <button class="btn primary" id="simRunAgain">↺ New mock</button>
        <button class="btn ghost" id="simClose">Done</button>
      </div>
    </div>`;
}

// ---- intel hover popover ------------------------------------------------
function showIntelTip(badge) {
  const id = badge.dataset.intel;
  const entries = intelEntriesForPlayer(id);
  if (!entries.length) return;
  const p = S.byId.get(id);
  const tip = $("#intelTip");
  tip.innerHTML =
    `<div class="tip-name">${p ? escapeHtml(p.name) : ""} <span class="tip-net ${p && p.intelDelta > 0 ? "up" : "down"}">net ${p && p.intelDelta > 0 ? "▲" : "▼"}${p ? Math.abs(p.intelDelta) : ""}</span></div>` +
    entries.map((en) => `
      <div class="tip-row">
        <div class="tip-head"><span class="tip-src">${escapeHtml(en.source)}</span><span class="intel-badge ${en.delta > 0 ? "up" : "down"}">${en.delta > 0 ? "▲" : "▼"}${Math.abs(en.delta)}</span></div>
        <div class="tip-q">“${escapeHtml(en.snippet)}”</div>
      </div>`).join("");
  tip.hidden = false;
  const r = badge.getBoundingClientRect();
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let left = Math.min(Math.max(8, r.left + r.width / 2 - tw / 2), window.innerWidth - tw - 8);
  let top = r.bottom + 8;
  if (top + th > window.innerHeight - 8) top = r.top - th - 8; // flip above if no room
  tip.style.left = left + "px";
  tip.style.top = Math.max(8, top) + "px";
}
function hideIntelTip() { const t = $("#intelTip"); if (t) t.hidden = true; }

// ---- utils --------------------------------------------------------------
let toastTimer;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600);
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
