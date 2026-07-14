// scoring.js — league-specific scoring engine.
// projectedPoints(player, league) turns a projected stat line into fantasy points
// using the exact scoring rules in data/league.json. Pure + side-effect free so it
// runs identically in the browser and in Node tests (test/scoring.test.mjs).

function num(v) { return typeof v === "number" && isFinite(v) ? v : 0; }

export function offensePoints(stats, s) {
  let p = 0;
  p += num(stats.passYds) / s.passYardsPerPoint;
  p += num(stats.passTD) * s.passTD;
  p += num(stats.interceptions) * s.interception;
  p += num(stats.rushYds) / s.rushYardsPerPoint;
  p += num(stats.rushTD) * s.rushTD;
  p += num(stats.rec) * s.reception;
  p += num(stats.recYds) / s.recYardsPerPoint;
  p += num(stats.recTD) * s.recTD;
  p += num(stats.returnYds) / s.returnYardsPerPoint;
  p += num(stats.returnTD) * s.returnTD;
  p += num(stats.twoPointConversions) * s.twoPointConversion;
  p += num(stats.fumblesLost) * s.fumbleLost;
  p += num(stats.offFumRetTD) * s.offensiveFumbleReturnTD;
  return p;
}

export function kickerPoints(stats, k) {
  let p = 0;
  p += num(stats.fg0_19) * k.fg0_19;
  p += num(stats.fg20_29) * k.fg20_29;
  p += num(stats.fg30_39) * k.fg30_39;
  p += num(stats.fg40_49) * k.fg40_49;
  p += num(stats.fg50plus) * k.fg50plus;
  p += num(stats.pat) * k.pat;
  return p;
}

// Points-allowed is scored per game; convert a season-average PA/game into an
// expected weekly point value via the tier table, then annualize over 17 games.
export function pointsAllowedPerGame(pa, tiers) {
  for (const t of tiers) if (pa <= t.max) return t.points;
  return tiers[tiers.length - 1].points;
}

export function defensePoints(stats, d, games = 17) {
  let p = 0;
  p += num(stats.sacks) * d.sack;
  p += num(stats.interceptions) * d.interception;
  p += num(stats.fumbleRecoveries) * d.fumbleRecovery;
  p += num(stats.defTD) * d.touchdown;
  p += num(stats.safeties) * d.safety;
  p += num(stats.blockedKicks) * d.blockKick;
  p += num(stats.returnTD) * d.returnTD;
  p += num(stats.fourthDownStops) * d.fourthDownStop;
  p += pointsAllowedPerGame(num(stats.pointsAllowedPerGame), d.pointsAllowed) * games;
  return p;
}

// Total projected season fantasy points for any player, per league rules.
export function projectedPoints(player, league) {
  const sc = league.scoring;
  const st = player.stats || {};
  let p;
  if (player.pos === "K") p = kickerPoints(st, sc.kicking);
  else if (player.pos === "DEF") p = defensePoints(st, sc.defense);
  else p = offensePoints(st, sc.offense);
  return Math.round(p * 10) / 10;
}
