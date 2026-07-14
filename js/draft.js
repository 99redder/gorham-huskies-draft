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
  // Consensus-ADP backbone: below replacement, VOR is flat/noisy and not comparable
  // across positions, so a small market-consensus term keeps the deep board sane
  // (e.g. a startable WR/QB ranks by ADP, not lumped with waiver fodder).
  const adpBackbone = Math.max(0, 26 - (p.adp - 1) * 0.18);
  // "Fall/steal": positive when a player is still available past their ADP.
  const adpValue = clamp((p.adp - (ctx.pickNumber || p.adp)) * 0.6, -25, 25);
  const need = needMultiplier(p.pos, ctx.need);
  const base = w.vor * (p.vorNorm || 0) + adpBackbone + w.adp * adpValue + w.intel * (p.intelDelta || 0);
  return Math.round(base * (1 + w.need * (need - 1)) * 10) / 10;
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

// Top-N recommendations from the available pool by blended score.
export function recommend(available, ctx, weights, n = 5) {
  return [...available]
    .map((p) => ({ ...p, blend: blendedScore(p, ctx, weights) }))
    .sort((a, b) => b.blend - a.blend)
    .slice(0, n);
}
