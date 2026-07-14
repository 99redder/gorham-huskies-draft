// simulator.js — mock draft engine. Bots draft by ADP (with realistic reach +
// positional discipline); you draft at your snake slot. Also runs a fast
// Monte-Carlo pass to estimate who's typically available at each of your picks.
// State here is entirely separate from the real draft board.

export function snakeOrder(teams, rounds) {
  const order = [];
  for (let r = 0; r < rounds; r++) {
    const row = [...Array(teams).keys()];
    if (r % 2 === 1) row.reverse();
    order.push(...row);
  }
  return order; // array of 0-based team indices, length teams*rounds
}

// 1-based overall pick numbers where a given 0-based slot drafts.
export function pickNumbersForSlot(slot, teams, rounds) {
  return snakeOrder(teams, rounds)
    .map((t, i) => (t === slot ? i + 1 : -1))
    .filter((n) => n > 0);
}

// How many of each position a bot will roster before it stops taking more.
const BOT_CAP = { QB: 2, RB: 6, WR: 7, TE: 3, K: 1, DEF: 1 };
// The user's autopilot caps (a bit looser on skill positions).
const USER_CAP = { QB: 3, RB: 8, WR: 8, TE: 3, K: 1, DEF: 1 };

function gaussian() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Realistic positional discipline: no early K/DEF, no early backup QB, respect caps.
function allowed(p, counts, round, rounds, cap) {
  const c = counts[p.pos] || 0;
  if (c >= (cap[p.pos] ?? 4)) return false;
  const lateWindow = round >= rounds - 2;             // last 2 rounds
  if ((p.pos === "K" || p.pos === "DEF") && !lateWindow) return false;
  if (p.pos === "QB" && c >= 1 && round < rounds - 3) return false; // backup QB only late
  return true;
}

// Required single-slot starters every team must roster by the end.
const REQUIRED = { QB: 1, K: 1, DEF: 1 };
function mustFillPositions(counts, round, rounds) {
  const picksLeft = rounds - round + 1;
  const missing = Object.keys(REQUIRED).filter((pos) => (counts[pos] || 0) < REQUIRED[pos]);
  return missing.length >= picksLeft ? missing : null; // out of time — must fill now
}

// Bot pick: best available by ADP + gaussian reach, filtered by discipline, but
// forced onto a missing required starter (QB/K/DEF) when it's out of picks.
export function botPick(available, counts, round, rounds, reach = 7) {
  const scored = available
    .map((p) => ({ p, key: p.adp + gaussian() * reach }))
    .sort((a, b) => a.key - b.key);
  const must = mustFillPositions(counts, round, rounds);
  if (must) { for (const { p } of scored) if (must.includes(p.pos)) return p; }
  for (const { p } of scored) if (allowed(p, counts, round, rounds, BOT_CAP)) return p;
  return scored[0] ? scored[0].p : available[0];
}

// User autopilot pick given a strategy. valueOf(p) -> comparable value (VOR).
export function strategyPick(available, counts, round, rounds, strategy, valueOf) {
  const byVal = [...available].sort((a, b) => valueOf(b) - valueOf(a));
  const must = mustFillPositions(counts, round, rounds);
  if (must) { const forced = byVal.find((p) => must.includes(p.pos)); if (forced) return forced; }
  const ok = (p) => allowed(p, counts, round, rounds, USER_CAP);
  const first = (pred) => byVal.find((p) => ok(p) && pred(p));
  if (strategy === "zero-rb" && round <= 5) return first((p) => p.pos !== "RB") || byVal.find(ok) || byVal[0];
  if (strategy === "hero-rb") {
    if (round === 1) return first((p) => p.pos === "RB") || byVal.find(ok) || byVal[0];
    if (round <= 6) return first((p) => p.pos !== "RB") || byVal.find(ok) || byVal[0];
  }
  return byVal.find(ok) || byVal[0];
}

// Monte-Carlo: run `runs` bot-only drafts (you auto-pick best value) and tally,
// at each of your pick slots, which players are most often still on the board.
export function availabilityAtMyPicks(players, valuesById, teams, rounds, slot, runs = 25) {
  const order = snakeOrder(teams, rounds);
  const myPickCount = pickNumbersForSlot(slot, teams, rounds).length;
  const tally = Array.from({ length: myPickCount }, () => ({}));
  const val = (p) => (valuesById.get(p.id)?.vor ?? 0);

  for (let run = 0; run < runs; run++) {
    const avail = new Set(players.map((p) => p.id));
    const counts = Array.from({ length: teams }, () => ({}));
    let myIdx = 0;
    for (let i = 0; i < order.length; i++) {
      const team = order[i];
      const round = Math.floor(i / teams) + 1;
      const list = players.filter((p) => avail.has(p.id));
      if (team === slot) {
        const best = [...list].sort((a, b) => val(b) - val(a));
        for (const p of best.slice(0, 8)) tally[myIdx][p.id] = (tally[myIdx][p.id] || 0) + 1;
        const mine = best[0];
        avail.delete(mine.id);
        counts[team][mine.pos] = (counts[team][mine.pos] || 0) + 1;
        myIdx++;
      } else {
        const pick = botPick(list, counts[team], round, rounds);
        avail.delete(pick.id);
        counts[team][pick.pos] = (counts[team][pick.pos] || 0) + 1;
      }
    }
  }

  const myPicks = pickNumbersForSlot(slot, teams, rounds);
  return myPicks.map((pn, idx) => ({
    pick: pn,
    round: idx + 1,
    players: Object.entries(tally[idx])
      .map(([id, ct]) => ({ id, name: valuesById.get(id)?.name, pos: valuesById.get(id)?.pos, prob: ct / runs }))
      .sort((a, b) => b.prob - a.prob)
      .slice(0, 6),
  }));
}
