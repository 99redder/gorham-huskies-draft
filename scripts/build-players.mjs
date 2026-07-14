#!/usr/bin/env node
/**
 * build-players.mjs — generates data/players.json
 *
 * PROVENANCE
 *  - Draft order / consensus ADP: FantasyFootballCalculator Half-PPR consensus
 *    (aggregate of live public mock drafts), captured 2026-07-14. This is the
 *    "multiple mock drafts" intelligence layer.
 *  - Projected stat lines: MODELED here from positional archetypes scaled by
 *    within-position rank, plus targeted overrides for pass-catching backs,
 *    rushing QBs, and kick/punt returners (so this league's return-yard and
 *    0.5-PPR scoring actually moves value). These are a transparent STARTING
 *    POINT meant to be edited — every player carries `provenance: "modeled-2026"`.
 *
 * Re-run:  node scripts/build-players.mjs   (writes ../data/players.json)
 * Edit the ADP list below (or players.json directly) to refresh before a draft.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Consensus draft order: [name, POS, TEAM]  (FFC Half-PPR, 2026-07-14)
const ADP = [
  ["Jahmyr Gibbs","RB","DET"],["Bijan Robinson","RB","ATL"],["Puka Nacua","WR","LAR"],
  ["Ja'Marr Chase","WR","CIN"],["Christian McCaffrey","RB","SF"],["Jonathan Taylor","RB","IND"],
  ["Jaxon Smith-Njigba","WR","SEA"],["Amon-Ra St. Brown","WR","DET"],["De'Von Achane","RB","MIA"],
  ["Derrick Henry","RB","BAL"],["James Cook III","RB","BUF"],["Drake London","WR","ATL"],
  ["CeeDee Lamb","WR","DAL"],["Justin Jefferson","WR","MIN"],["Ashton Jeanty","RB","LV"],
  ["A.J. Brown","WR","NE"],["George Pickens","WR","DAL"],["Saquon Barkley","RB","PHI"],
  ["Omarion Hampton","RB","LAC"],["Kenneth Walker III","RB","KC"],["Chase Brown","RB","CIN"],
  ["Chris Olave","WR","NO"],["Tee Higgins","WR","CIN"],["Nico Collins","WR","HOU"],
  ["Zay Flowers","WR","BAL"],["Josh Jacobs","RB","GB"],["Jeremiyah Love","RB","ARI"],
  ["Rashee Rice","WR","KC"],["Garrett Wilson","WR","NYJ"],["DeVonta Smith","WR","PHI"],
  ["Breece Hall","RB","NYJ"],["Josh Allen","QB","BUF"],["Kyren Williams","RB","LAR"],
  ["Tetairoa McMillan","WR","CAR"],["Javonte Williams","RB","DAL"],["Terry McLaurin","WR","WAS"],
  ["Davante Adams","WR","LAR"],["Ladd McConkey","WR","LAC"],["Cam Skattebo","RB","NYG"],
  ["Jameson Williams","WR","DET"],["Travis Etienne Jr.","RB","NO"],["Jaylen Waddle","WR","DEN"],
  ["Malik Nabers","WR","NYG"],["Luther Burden III","WR","CHI"],["Trey McBride","TE","ARI"],
  ["Emeka Egbuka","WR","TB"],["Mike Evans","WR","SF"],["Rome Odunze","WR","CHI"],
  ["D'Andre Swift","RB","CHI"],["Bucky Irving","RB","TB"],["DK Metcalf","WR","PIT"],
  ["Alec Pierce","WR","IND"],["Quinshon Judkins","RB","CLE"],["Christian Watson","WR","GB"],
  ["Brock Bowers","TE","LV"],["Carnell Tate","WR","TEN"],["Marvin Harrison Jr.","WR","ARI"],
  ["Joe Burrow","QB","CIN"],["DJ Moore","WR","BUF"],["Courtland Sutton","WR","DEN"],
  ["Parker Washington","WR","JAX"],["David Montgomery","RB","HOU"],["Bhayshul Tuten","RB","JAX"],
  ["Colston Loveland","TE","CHI"],["Brian Thomas Jr.","WR","JAX"],["TreVeyon Henderson","RB","NE"],
  ["Michael Pittman Jr.","WR","PIT"],["Lamar Jackson","QB","BAL"],["Jayden Reed","WR","GB"],
  ["Michael Wilson","WR","ARI"],["Jordyn Tyson","WR","NO"],["Chris Godwin Jr.","WR","TB"],
  ["Dak Prescott","QB","DAL"],["Jaylen Warren","RB","PIT"],["Jordan Addison","WR","MIN"],
  ["Josh Downs","WR","IND"],["Xavier Worthy","WR","KC"],["Quentin Johnston","WR","LAC"],
  ["Jadarian Price","RB","SEA"],["Tony Pollard","RB","TEN"],["Romeo Doubs","WR","NE"],
  ["Drake Maye","QB","NE"],["Rhamondre Stevenson","RB","NE"],["Jakobi Meyers","WR","JAX"],
  ["Ricky Pearsall","WR","SF"],["Wan'Dale Robinson","WR","TEN"],["Tyler Warren","TE","IND"],
  ["Khalil Shakir","WR","BUF"],["Rico Dowdle","RB","PIT"],["Seattle","DEF","SEA"],
  ["Chuba Hubbard","RB","CAR"],["Patrick Mahomes","QB","KC"],["Makai Lemon","WR","PHI"],
  ["Justin Herbert","QB","LAC"],["Trevor Lawrence","QB","JAX"],["Jalen Coker","WR","CAR"],
  ["Matthew Golden","WR","GB"],["J.K. Dobbins","RB","DEN"],["Jayden Daniels","QB","WAS"],
  ["Jayden Higgins","WR","HOU"],["Jared Goff","QB","DET"],["KC Concepcion","WR","CLE"],
  ["Denver","DEF","DEN"],["Tucker Kraft","TE","GB"],["Harold Fannin Jr.","TE","CLE"],
  ["Sam LaPorta","TE","DET"],["Jalen Hurts","QB","PHI"],["Brock Purdy","QB","SF"],
  ["Matthew Stafford","QB","LAR"],["Caleb Williams","QB","CHI"],["Aaron Jones Sr.","RB","MIN"],
  ["RJ Harvey","RB","DEN"],["LA Rams","DEF","LAR"],["Rashid Shaheed","WR","SEA"],
  ["Houston","DEF","HOU"],["Jauan Jennings","WR","MIN"],["New England","DEF","NE"],
  ["Kyle Monangai","RB","CHI"],["Omar Cooper Jr.","WR","NYJ"],["Kyle Pitts Sr.","TE","ATL"],
  ["Travis Kelce","TE","KC"],["Bo Nix","QB","DEN"],["Jaxson Dart","QB","NYG"],
  ["Denzel Boston","WR","CLE"],["Tre Tucker","WR","LV"],["Philadelphia","DEF","PHI"],
  ["Rachaad White","RB","WAS"],["Jacksonville","DEF","JAX"],["George Kittle","TE","SF"],
  ["Kenny Gainwell","RB","TB"],
  // --- extended pool (kickers + a few more DST) ---
  ["Brandon Aubrey","K","DAL"],["Jason Myers","K","SEA"],["Cameron Dicker","K","LAC"],
  ["Ka'imi Fairbairn","K","HOU"],["Jake Bates","K","DET"],["Chase McLaughlin","K","TB"],
  ["Harrison Butker","K","KC"],["Cam Little","K","JAX"],["Evan McPherson","K","CIN"],
  ["Will Reichard","K","MIN"],["Detroit","DEF","DET"],["Minnesota","DEF","MIN"],
  ["Pittsburgh","DEF","PIT"],["Buffalo","DEF","BUF"],["Baltimore","DEF","BAL"],
  ["LA Chargers","DEF","LAC"]
];

// Players who catch a lot out of the backfield -> boost receptions (0.5 PPR matters)
const PASS_CATCH_RB = {
  "Jahmyr Gibbs":75,"Christian McCaffrey":80,"De'Von Achane":78,"James Cook III":52,
  "Breece Hall":58,"Jaylen Warren":52,"Kenneth Walker III":45,"D'Andre Swift":48,
  "Bucky Irving":50,"Kenny Gainwell":46,"Rachaad White":52,"Aaron Jones Sr.":44,
  "Jonathan Taylor":40,"Bijan Robinson":58,"Saquon Barkley":40,"Travis Etienne Jr.":42,
  "Omarion Hampton":40,"Ashton Jeanty":42,"TreVeyon Henderson":40,"Cam Skattebo":38
};
// Rushing QBs -> add rush volume
const RUSH_QB = {
  "Josh Allen":{ry:520,rtd:8},"Lamar Jackson":{ry:820,rtd:5},"Jayden Daniels":{ry:820,rtd:6},
  "Jalen Hurts":{ry:600,rtd:12},"Justin Herbert":{ry:260,rtd:3},"Joe Burrow":{ry:180,rtd:2},
  "Caleb Williams":{ry:430,rtd:4},"Bo Nix":{ry:380,rtd:4},"Jaxson Dart":{ry:420,rtd:4},
  "Drake Maye":{ry:400,rtd:3},"Patrick Mahomes":{ry:330,rtd:2}
};
// Kick/punt returners -> add return yards (THIS LEAGUE SCORES RETURN YARDS 25/pt)
const RETURNERS = {
  "Xavier Worthy":620,"Rashid Shaheed":540,"Marvin Harrison Jr.":0,"Jameson Williams":260,
  "Tre Tucker":560,"KC Concepcion":700,"Makai Lemon":640,"Wan'Dale Robinson":300,
  "Ricky Pearsall":280,"Tutu Atwell":0,"Parker Washington":520,"Omar Cooper Jr.":540,
  "Jadarian Price":480,"Kyle Monangai":0,"Jaylen Waddle":180
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function statsForRB(rank, name) {
  const r = rank; // within-position rank (1-based)
  let rushYds = clamp(1300 - (r - 1) * 46, 320, 1600);
  let rushTD = clamp(10 - (r - 1) * 0.4, 2, 13);
  let rec = PASS_CATCH_RB[name] != null ? PASS_CATCH_RB[name] : clamp(42 - (r - 1) * 1.4, 8, 60);
  let recYds = Math.round(rec * (8.4 + Math.max(0, 6 - r) * 0.15));
  let recTD = clamp(2.6 - (r - 1) * 0.06, 0.5, 3);
  const ret = RETURNERS[name] || 0;
  return { rushYds: Math.round(rushYds), rushTD: +rushTD.toFixed(1), rec: Math.round(rec),
    recYds, recTD: +recTD.toFixed(1), returnYds: ret, fumblesLost: 2 };
}
function statsForWR(rank, name) {
  const r = rank;
  let rec = clamp(102 - (r - 1) * 1.9, 34, 112);
  let recYds = clamp(1450 - (r - 1) * 26, 480, 1600);
  let recTD = clamp(9 - (r - 1) * 0.17, 2.5, 10);
  const ret = RETURNERS[name] || 0;
  const rush = r <= 40 && (name.includes("Worthy") || name.includes("Tucker")) ? 120 : 0;
  return { rec: Math.round(rec), recYds: Math.round(recYds), recTD: +recTD.toFixed(1),
    rushYds: rush, rushTD: 0, returnYds: ret, fumblesLost: 1 };
}
function statsForTE(rank) {
  const r = rank;
  let rec = clamp(80 - (r - 1) * 3.4, 24, 90);
  let recYds = clamp(950 - (r - 1) * 42, 260, 1050);
  let recTD = clamp(7 - (r - 1) * 0.32, 2, 8);
  return { rec: Math.round(rec), recYds: Math.round(recYds), recTD: +recTD.toFixed(1),
    returnYds: 0, fumblesLost: 0 };
}
function statsForQB(rank, name) {
  const r = rank;
  let passYds = clamp(4750 - (r - 1) * 135, 3200, 5000);
  let passTD = clamp(35 - (r - 1) * 1.25, 16, 40);
  let intc = clamp(8 + (r - 1) * 0.22, 6, 16);
  const rush = RUSH_QB[name] || { ry: 180, rtd: 1.5 };
  return { passYds: Math.round(passYds), passTD: +passTD.toFixed(1), interceptions: +intc.toFixed(1),
    rushYds: rush.ry, rushTD: rush.rtd, fumblesLost: 3 };
}
function statsForK(rank) {
  const r = rank;
  const totFG = clamp(31 - (r - 1) * 0.7, 20, 34);
  return {
    fg0_19: 0,
    fg20_29: Math.round(totFG * 0.16),
    fg30_39: Math.round(totFG * 0.30),
    fg40_49: Math.round(totFG * 0.32),
    fg50plus: Math.round(totFG * 0.22),
    pat: Math.round(clamp(42 - (r - 1) * 1.1, 24, 48))
  };
}
function statsForDST(rank) {
  const r = rank;
  return {
    sacks: +clamp(48 - (r - 1) * 1.4, 30, 55).toFixed(1),
    interceptions: +clamp(15 - (r - 1) * 0.4, 8, 18).toFixed(1),
    fumbleRecoveries: +clamp(9 - (r - 1) * 0.22, 4, 11).toFixed(1),
    defTD: +clamp(4 - (r - 1) * 0.12, 1.2, 5).toFixed(1),
    safeties: 0.5,
    blockedKicks: +clamp(1 - (r - 1) * 0.04, 0.2, 1.2).toFixed(1),
    returnTD: +clamp(0.9 - (r - 1) * 0.04, 0.1, 1).toFixed(1),
    fourthDownStops: +clamp(7 - (r - 1) * 0.2, 3, 8).toFixed(1),
    pointsAllowedPerGame: +clamp(17.5 + (r - 1) * 0.7, 16, 27).toFixed(1)
  };
}

const posRank = {};
const players = ADP.map((row, i) => {
  const [name, pos, team] = row;
  posRank[pos] = (posRank[pos] || 0) + 1;
  const pr = posRank[pos];
  let stats;
  if (pos === "RB") stats = statsForRB(pr, name);
  else if (pos === "WR") stats = statsForWR(pr, name);
  else if (pos === "TE") stats = statsForTE(pr);
  else if (pos === "QB") stats = statsForQB(pr, name);
  else if (pos === "K") stats = statsForK(pr);
  else stats = statsForDST(pr);

  return {
    id: slug(name, team, pos),
    name: pos === "DEF" ? `${name} DST` : name,
    pos,
    team,
    bye: null,
    adp: i + 1,
    posRankConsensus: pr,
    yahooRank: i + 1,
    aliases: buildAliases(name, pos),
    stats,
    provenance: { adp: "FFC-half-ppr-2026-07-14", stats: "modeled-2026" }
  };
});

function slug(name, team, pos) {
  return (name + "-" + team + "-" + pos).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
function buildAliases(name, pos) {
  const a = new Set();
  const norm = name.replace(/\s+(Jr\.?|Sr\.?|II|III|IV)$/i, "").trim();
  a.add(norm);
  const parts = norm.split(/\s+/);
  if (parts.length >= 2) {
    a.add(parts.slice(1).join(" ")); // last name(s)
    a.add(parts[0][0] + ". " + parts.slice(1).join(" ")); // F. Last
  }
  if (pos === "DEF") { a.add(name); a.add(name + " D/ST"); a.add(name + " Defense"); }
  a.delete(name);
  return [...a];
}

const out = { generatedAt: new Date().toISOString(), source: "FantasyFootballCalculator Half-PPR consensus (mock-draft aggregate), 2026-07-14; stat lines modeled", count: players.length, players };
writeFileSync(join(__dirname, "..", "data", "players.json"), JSON.stringify(out, null, 2));
console.log(`Wrote data/players.json — ${players.length} players`);
