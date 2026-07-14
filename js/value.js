// value.js — Value Over Replacement (VOR) + tier detection, tuned for THIS league
// (6 teams, shallow rosters). Because replacement levels are shallow, the premium
// on scarce positions is correctly compressed vs a 12-team league.

import { projectedPoints } from "./scoring.js";

// How many players at each position clear "replacement" in this league.
// starters = per-team starters * teams; flex demand is split across RB/WR/TE by
// how often each fills a flex; a small bench buffer reflects real draft depth.
export function replacementRanks(league) {
  const t = league.teams;
  const st = league.roster.starters;
  const flexTotal = (st.FLEX || 0) * t;
  const flexSplit = { RB: 0.5, WR: 0.42, TE: 0.08 }; // typical flex usage
  const benchBuffer = { QB: 2, RB: 6, WR: 6, TE: 2, K: 0, DEF: 0 };
  const ranks = {};
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DEF"]) {
    const starters = (st[pos] || 0) * t;
    const flex = Math.round((flexSplit[pos] || 0) * flexTotal);
    ranks[pos] = Math.max(1, starters + flex + (benchBuffer[pos] || 0));
  }
  return ranks;
}

// Compute projected points, VOR, positional rank, and starter-relative value for
// every player. Returns a new array (does not mutate input) sorted by VOR desc.
export function computeValues(players, league) {
  const withPts = players.map((p) => ({ ...p, proj: projectedPoints(p, league) }));

  // positional lists sorted by projected points
  const byPos = {};
  for (const p of withPts) (byPos[p.pos] ||= []).push(p);
  for (const pos in byPos) byPos[pos].sort((a, b) => b.proj - a.proj);

  const repRanks = replacementRanks(league);
  const repPoints = {};
  for (const pos in byPos) {
    const list = byPos[pos];
    const idx = Math.min(list.length - 1, Math.max(0, (repRanks[pos] || list.length) - 1));
    repPoints[pos] = list[idx] ? list[idx].proj : 0;
  }

  for (const pos in byPos) {
    byPos[pos].forEach((p, i) => {
      p.posRank = i + 1;
      p.replacement = repPoints[pos];
      p.vor = Math.round((p.proj - repPoints[pos]) * 10) / 10;
      p.tier = 0; // filled below
    });
    assignTiers(byPos[pos]);
  }

  const all = Object.values(byPos).flat();
  all.sort((a, b) => b.vor - a.vor);
  return all;
}

// Tier detection: walk a position list (already sorted by proj desc) and start a
// new tier when the drop from the previous player exceeds a dynamic threshold
// based on the spread of gaps within that position.
export function assignTiers(list) {
  if (!list.length) return;
  const gaps = [];
  for (let i = 1; i < list.length; i++) gaps.push(list[i - 1].proj - list[i].proj);
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  const threshold = Math.max(8, median * 2.1); // a "real" cliff
  let tier = 1;
  list[0].tier = 1;
  for (let i = 1; i < list.length; i++) {
    if (list[i - 1].proj - list[i].proj >= threshold) tier++;
    list[i].tier = tier;
  }
}

// Normalize VOR to 0..100 for blending with other signals.
export function normalizeVor(values) {
  const vors = values.map((v) => v.vor);
  const min = Math.min(...vors), max = Math.max(...vors);
  const span = max - min || 1;
  for (const v of values) v.vorNorm = ((v.vor - min) / span) * 100;
  return values;
}
