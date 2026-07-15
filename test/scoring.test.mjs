// Minimal test harness (no deps): node test/scoring.test.mjs
import { readFileSync } from "node:fs";
import { projectedPoints } from "../js/scoring.js";
import { computeValues, replacementRanks } from "../js/value.js";
import { blendedScore, sourceDisagreement, compareDraftPlayers, explainPick } from "../js/draft.js";
import { intelDelta } from "../js/intel.js";
import { injuryFromSleeper, matchSleeperInjuries, injuryAbbreviation } from "../js/injuries.js";

const league = JSON.parse(readFileSync(new URL("../data/league.json", import.meta.url)));
const { players } = JSON.parse(readFileSync(new URL("../data/players.json", import.meta.url)));

let pass = 0, fail = 0;
function eq(name, got, want, tol = 0.05) {
  if (Math.abs(got - want) <= tol) { pass++; }
  else { fail++; console.error(`FAIL ${name}: got ${got}, want ${want}`); }
}
function ok(name, value) {
  if (value) pass++;
  else { fail++; console.error(`FAIL ${name}`); }
}

// Hand-computed WR: 102 rec, 1450 yds, 9 TD, 1 fum lost (0.5PPR, 10yd/pt, 6pt TD, -2 fum)
eq("WR 102/1450/9/1fum",
  projectedPoints({ pos: "WR", stats: { rec: 102, recYds: 1450, recTD: 9, fumblesLost: 1 } }, league),
  51 + 145 + 54 - 2);

// Return yards matter (league scores 25/pt): +400 return yds = +16
eq("return yards add 16",
  projectedPoints({ pos: "WR", stats: { rec: 50, recYds: 700, recTD: 5, returnYds: 400 } }, league)
  - projectedPoints({ pos: "WR", stats: { rec: 50, recYds: 700, recTD: 5, returnYds: 0 } }, league),
  16);

// Kicker: 5x FG40-49 (@4) + 3x FG50+ (@5) + 30 PAT = 20 + 15 + 30
eq("kicker tiers",
  projectedPoints({ pos: "K", stats: { fg40_49: 5, fg50plus: 3, pat: 30 } }, league),
  20 + 15 + 30);

// DEF 4th-down stops scored 2 ea (non-default): 6 stops = +12 over baseline
eq("4th down stops",
  projectedPoints({ pos: "DEF", stats: { fourthDownStops: 6, pointsAllowedPerGame: 21 } }, league)
  - projectedPoints({ pos: "DEF", stats: { fourthDownStops: 0, pointsAllowedPerGame: 21 } }, league),
  12);

// Independent rank sources: spread is visible and a player who falls past ADP
// receives more market value than a reach (regression for the old reversed sign).
eq("source disagreement", sourceDisagreement({ adp: 10, sleeperAdp: 25, yahooRank: 5 }), 20);
{
  const ctx = { pickNumber: 20, need: {} };
  const weights = { vor: 0, adp: 1, sleeper: 0, yahoo: 0, need: 0, intel: 0 };
  const fell = blendedScore({ adp: 10 }, ctx, weights);
  const reach = blendedScore({ adp: 30 }, ctx, weights);
  ok("fall past ADP beats a reach", fell > reach);
}
eq("analyst trust override", intelDelta({ source: "@analyst", magnitude: 10 }, { defaultTrust: 1 }, { "@analyst": 1.25 }), 12.5);

// Column sorting uses sensible defaults and keeps missing values at the bottom.
{
  const sortable = [{ name: "Low", vor: 10, adp: 20 }, { name: "High", vor: 30, adp: 5 }, { name: "Missing" }];
  ok("VOR column sorts high to low", [...sortable].sort((a, b) => compareDraftPlayers(a, b, "vor"))[0].name === "High");
  ok("ADP column sorts low to high", [...sortable].sort((a, b) => compareDraftPlayers(a, b, "adp"))[0].name === "High");
  ok("missing sort values stay last", [...sortable].sort((a, b) => compareDraftPlayers(a, b, "vor", "asc")).at(-1).name === "Missing");
}

// Recommendation explanations describe existing score inputs without reranking.
{
  const base = { id: "p1", name: "Test Runner", pos: "RB", tier: 2, vor: 40,
    vorNorm: 75, adp: 10, intelDelta: 0 };
  const weights = { vor: 1, adp: 1, sleeper: 0, yahoo: 0, need: 1, intel: 1 };
  const needed = explainPick(base, { pickNumber: 10, need: { RB: 2, FLEX: 0 } }, weights);
  ok("explanation strong roster need", needed.reasons.some((x) => x.includes("roster need")));

  const intel = explainPick({ ...base, intelDelta: 3 }, { pickNumber: 10, need: {} }, weights,
    { intelSources: ["@analyst"] });
  ok("explanation positive intel", intel.reasons.some((x) => x.includes("Intel boost")));

  const discount = explainPick(base, { pickNumber: 20, need: {} }, weights);
  ok("explanation ADP discount", discount.reasons.some((x) => x.includes("ADP discount")));

  const gone = explainPick(base, { pickNumber: 10, need: {} }, weights, { returnProbability: 0.2 });
  ok("explanation unlikely to return", gone.reasons.includes("Likely gone before next pick") && gone.label === "Take now");

  const tier = explainPick(base, { pickNumber: 10, need: { RB: 1, FLEX: 0 } }, weights,
    { runAlerts: [{ pos: "RB", tier: 2, remaining: 1 }] });
  ok("explanation tier drying up", tier.reasons.some((x) => x.includes("Last RB in Tier 2")));
}

// Sleeper injury normalization + suffix-tolerant matching.
{
  const sleeper = { player_id: "1", full_name: "James Cook", injury_status: "Questionable",
    injury_body_part: "Knee", injury_notes: "Soreness", news_updated: 123 };
  const injury = injuryFromSleeper(sleeper);
  eq("injury source timestamp", injury.sourceUpdatedAt, 123, 0);
  ok("injury note includes details", injury.note === "Knee · Soreness");
  ok("healthy designation ignored", injuryFromSleeper({ injury_status: "NA" }) === null);
  const matched = matchSleeperInjuries([{ id: "cook", name: "James Cook III", pos: "RB" }], { "1": sleeper });
  ok("injury player suffix matching", matched.injuries.cook?.status === "Questionable");
  ok("injury abbreviation", injuryAbbreviation("Questionable") === "Q");
}

// Sanity: full dataset VOR ranks the top pick reasonably, replacement levels shallow
const values = computeValues(players, league);
console.log("Replacement ranks (6-team):", replacementRanks(league));
console.log("Top 8 by VOR:");
values.slice(0, 8).forEach((v, i) =>
  console.log(`  ${i + 1}. ${v.name} (${v.pos}) proj=${v.proj} vor=${v.vor} tier=${v.tier}`));

// Simulator sanity: full snake draft fills every team's required starters.
import { snakeOrder, botPick } from "../js/simulator.js";
const teams = league.teams, rounds = league.roster.total;
eq("snake order length", snakeOrder(teams, rounds).length, teams * rounds, 0);
{
  const avail = new Set(values.map((p) => p.id));
  const counts = Array.from({ length: teams }, () => ({}));
  const order = snakeOrder(teams, rounds);
  for (let i = 0; i < order.length; i++) {
    const t = order[i], r = Math.floor(i / teams) + 1;
    const pk = botPick(values.filter((p) => avail.has(p.id)), counts[t], r, rounds);
    avail.delete(pk.id);
    counts[t][pk.pos] = (counts[t][pk.pos] || 0) + 1;
  }
  const missing = counts.filter((c) => !(c.QB >= 1 && c.K >= 1 && c.DEF >= 1)).length;
  eq("every bot team has QB/K/DEF", missing, 0, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
