// draft.js — draft board logic: roster fill, positional need, blended ranking,
// recommendations, and positional-run alerts. Pure functions over state + values.

// Fill my roster into slots (QB, RB×3, WR×3, TE, FLEX, K, DEF, BN×5) greedily by
// projected points, so we know which starter slots are still open.
export function fillRoster(myPlayers, league) {
  const st = league.roster.starters;
  const slots = [];
  const push = (label, pos) => slots.push({ label, pos, player: null });
  push("QB", ["QB"]);
  for (let i = 0; i < st.RB; i++) push("RB", ["RB"]);
  for (let i = 0; i < st.WR; i++) push("WR", ["WR"]);
  push("TE", ["TE"]);
  push("FLEX", league.roster.flexEligible);
  push("K", ["K"]);
  push("DEF", ["DEF"]);
  for (let i = 0; i < league.roster.bench; i++) push("BN", ["QB","RB","WR","TE","K","DEF"]);

  const pool = [...myPlayers].sort((a, b) => (b.proj || 0) - (a.proj || 0));
  for (const p of pool) {
    // prefer a dedicated starter slot, then FLEX, then bench
    let slot = slots.find((s) => !s.player && s.label === p.pos)
      || slots.find((s) => !s.player && s.label === "FLEX" && s.pos.includes(p.pos))
      || slots.find((s) => !s.player && s.label === "BN");
    if (slot) slot.player = p;
  }
  return slots;
}

// Count remaining OPEN starter slots by position (FLEX counts toward RB/WR/TE need).
export function positionNeeds(slots) {
  const need = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0, FLEX: 0 };
  for (const s of slots) {
    if (s.player) continue;
    if (s.label === "FLEX") need.FLEX++;
    else if (need[s.label] != null && s.label !== "BN") need[s.label]++;
  }
  return need;
}

// Need multiplier for a position: strong when a starter slot is open, softened once
// starters are filled. FLEX shares demand across RB/WR/TE.
export function needMultiplier(pos, need) {
  const direct = need[pos] || 0;
  const flexShare = ["RB", "WR", "TE"].includes(pos) ? need.FLEX * 0.5 : 0;
  const demand = direct + flexShare;
  if (demand >= 2) return 1.35;
  if (demand >= 1) return 1.18;
  if (demand > 0) return 1.08;
  return 0.82; // already set here — de-prioritize
}

// Blended draft score. Weights are user-adjustable (settings drawer).
//   vorNorm     0..100 league-specific value
//   adpValue    positive when a player is available later than their ADP
//   needMult    roster-need multiplier
//   intelDelta  signed analyst-intel adjustment
export function blendedScore(p, ctx, weights) {
  const w = weights;
  const pick = ctx.pickNumber || 1;
  // Each independent market rank contributes both overall market strength and a
  // fall/steal signal. A player still available after his rank is a positive value.
  const rankValue = (rank) => {
    if (!Number.isFinite(rank)) return 0;
    const backbone = Math.max(0, 26 - (rank - 1) * 0.18);
    const fall = clamp((pick - rank) * 0.6, -25, 25);
    return backbone + fall;
  };
  const need = needMultiplier(p.pos, ctx.need);
  const base = w.vor * (p.vorNorm || 0)
    + w.adp * rankValue(p.adp)
    + (w.sleeper ?? 0.45) * rankValue(p.sleeperAdp)
    + (w.yahoo ?? 0.3) * rankValue(p.yahooRank)
    + w.intel * (p.intelDelta || 0);
  return Math.round(base * (1 + w.need * (need - 1)) * 10) / 10;
}

// Largest disagreement among the independent market/preseason sources.
export function sourceDisagreement(p) {
  const ranks = [p.adp, p.sleeperAdp, p.yahooRank].filter(Number.isFinite);
  return ranks.length >= 2 ? Math.round((Math.max(...ranks) - Math.min(...ranks)) * 10) / 10 : null;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Positional-run alert: if a tier at a needed position is nearly exhausted among the
// best available, warn the user to prioritize it.
export function runAlerts(available, need) {
  const alerts = [];
  for (const pos of ["RB", "WR", "TE", "QB"]) {
    const list = available.filter((p) => p.pos === pos);
    if (!list.length) continue;
    const topTier = Math.min(...list.map((p) => p.tier));
    const remainingInTopTier = list.filter((p) => p.tier === topTier).length;
    const demand = (need[pos] || 0) + (["RB","WR","TE"].includes(pos) ? need.FLEX * 0.5 : 0);
    if (remainingInTopTier <= 2 && demand > 0) {
      alerts.push({ pos, tier: topTier, remaining: remainingInTopTier });
    }
  }
  return alerts;
}

// Tunable, deterministic cutoffs for the compact "Why this pick?" explanation.
// Scoring stays in blendedScore(); these thresholds only describe its inputs.
export const EXPLANATION_THRESHOLDS = Object.freeze({
  strongNeed: 1.18,
  lowNeed: 0.82,
  highVorNorm: 70,
  intelBoost: 2,
  intelConcern: -2,
  adpDiscount: 5,
  tierDrying: 2,
  unlikelyToReturn: 0.35,
  canWait: 0.65,
});

// Explain an already-ranked recommendation without changing its score.
// Optional inputs let callers attach context that is not part of the player record:
// available/runAlerts, returnProbability, intelSources, and byeConflictCount.
export function explainPick(player, ctx, weights, options = {}) {
  const t = { ...EXPLANATION_THRESHOLDS, ...(options.thresholds || {}) };
  const reasons = [];
  const warnings = [];
  const need = needMultiplier(player.pos, ctx.need || {});
  const pick = ctx.pickNumber || 1;
  const add = (list, text) => { if (text && !list.includes(text)) list.push(text); };

  const biggestNeed = Math.max(...["QB", "RB", "WR", "TE", "K", "DEF"]
    .map((pos) => needMultiplier(pos, ctx.need || {})));
  if ((weights.need ?? 1) > 0 && need >= t.strongNeed)
    add(reasons, need >= biggestNeed ? `Biggest roster need · ${player.pos}` : `Strong ${player.pos} roster need`);
  else if ((weights.need ?? 1) > 0 && need <= t.lowNeed)
    add(warnings, `Low ${player.pos} roster need`);

  if ((weights.vor ?? 1) > 0 && (player.vorNorm || 0) >= t.highVorNorm)
    add(reasons, "High VOR edge");
  else if ((weights.vor ?? 1) > 0 && Number.isFinite(player.posRank) && player.posRank <= 3)
    add(reasons, `${player.pos}${player.posRank} by projection`);

  if ((weights.adp ?? 0) > 0 && Number.isFinite(player.adp) && pick - player.adp >= t.adpDiscount)
    add(reasons, `ADP discount · ${Math.round(pick - player.adp)} picks`);

  if ((weights.intel ?? 0) > 0 && (player.intelDelta || 0) >= t.intelBoost) {
    const source = (options.intelSources || []).find(Boolean);
    add(reasons, source ? `Intel boost · ${source}` : "Intel boost");
  } else if ((weights.intel ?? 0) > 0 && (player.intelDelta || 0) <= t.intelConcern) {
    add(warnings, "Analyst intel concern");
  }

  const alert = (options.runAlerts || []).find((a) =>
    a.pos === player.pos && a.tier === player.tier && a.remaining <= t.tierDrying);
  let tierRemaining = alert?.remaining;
  if (tierRemaining == null && Array.isArray(options.available)) {
    const positionPlayers = options.available.filter((p) => p.pos === player.pos);
    const topTier = positionPlayers.length ? Math.min(...positionPlayers.map((p) => p.tier)) : null;
    if (player.tier === topTier)
      tierRemaining = positionPlayers.filter((p) => p.tier === player.tier).length;
  }
  if (tierRemaining != null && tierRemaining <= t.tierDrying && need > 1) {
    add(reasons, tierRemaining === 1
      ? `Last ${player.pos} in Tier ${player.tier}`
      : `Only ${tierRemaining} ${player.pos}s left in Tier ${player.tier}`);
  }

  if (Number.isFinite(options.returnProbability)) {
    if (options.returnProbability <= t.unlikelyToReturn)
      add(reasons, "Likely gone before next pick");
    else if (options.returnProbability >= t.canWait)
      add(warnings, "Can probably wait");
  }

  if ((options.byeConflictCount || 0) > 0)
    add(warnings, `Bye overlaps with ${options.byeConflictCount} starter${options.byeConflictCount === 1 ? "" : "s"}`);

  const urgent = tierRemaining === 1 || options.returnProbability <= t.unlikelyToReturn;
  const label = urgent ? "Take now"
    : options.returnProbability >= t.canWait ? "Can wait"
    : reasons.length >= 2 ? "Strong fit"
    : "Consider";
  return { label, reasons: reasons.slice(0, 4), warnings: warnings.slice(0, 2) };
}

// The starters (non-bench filled slots) of the optimal lineup from a set of
// players — fillRoster slots highest projections into starters + FLEX.
function starters(myPlayers, league) {
  return fillRoster(myPlayers, league).filter((s) => s.label !== "BN" && s.player).map((s) => s.player);
}

// Raw projected points of the optimal starting lineup (a real, meaningful total).
export function optimalLineupPoints(myPlayers, league) {
  return Math.round(starters(myPlayers, league).reduce((a, p) => a + (p.proj || 0), 0) * 10) / 10;
}

// Value (sum of VOR) of the optimal starting lineup. Using VOR — not raw points —
// keeps draft priority honest: a QB scores lots of points but little value over a
// replacement QB, so it won't dominate "Attack Next" in this 1-QB league.
function lineupValue(myPlayers, league) {
  return starters(myPlayers, league).reduce((a, p) => a + (p.vor || 0), 0);
}

// For each position, how much value the best available player there would add to
// your optimal starting lineup — i.e. which position to attack next.
export function attackNext(myPlayers, available, league) {
  const base = lineupValue(myPlayers, league);
  const out = [];
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DEF"]) {
    const best = available.filter((p) => p.pos === pos).sort((a, b) => b.proj - a.proj)[0];
    if (!best) continue;
    const gain = Math.round((lineupValue([...myPlayers, best], league) - base) * 10) / 10;
    out.push({ pos, gain, best });
  }
  return out.sort((a, b) => b.gain - a.gain);
}

// Weeks where multiple of your STARTERS share a bye (a tough week to fill).
export function byeConflicts(starterSlots, threshold = 2) {
  const weeks = {};
  for (const s of starterSlots) {
    if (s.label === "BN" || !s.player || !s.player.bye) continue;
    (weeks[s.player.bye] ||= []).push(s.player);
  }
  return Object.entries(weeks)
    .map(([wk, players]) => ({ week: +wk, players, count: players.length }))
    .filter((w) => w.count >= threshold)
    .sort((a, b) => b.count - a.count || a.week - b.week);
}

// Top-N recommendations from the available pool by blended score.
export function recommend(available, ctx, weights, n = 5) {
  return [...available]
    .map((p) => ({ ...p, blend: blendedScore(p, ctx, weights) }))
    .sort((a, b) => b.blend - a.blend)
    .slice(0, n);
}
