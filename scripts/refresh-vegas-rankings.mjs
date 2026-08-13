#!/usr/bin/env node
// Capture The Betting Insider's Vegas-derived rankings — the primary ranking
// source for the board. Run close to draft day:
//
//   node scripts/refresh-vegas-rankings.mjs                 # fetch the public page
//   node scripts/refresh-vegas-rankings.mjs saved-page.html # parse a saved page
//
// The public page only unlocks the top few players; the rest come back with
// their fields stripped and marked "locked" (a paid subscription is required to
// see them). If you're a subscriber, open the ranking page while signed in, save
// the full HTML ("Save Page As…"), and pass that file as the argument — this
// script reads the same embedded data array either way.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const players = JSON.parse(readFileSync(join(root, "data", "players.json"))).players;

const URL = "https://www.thebettinginsider.com/vegas-rankings";

const normalize = (name) => name.toLowerCase()
  .replace(/[’']/g, "'")
  .replace(/\s+(jr|sr|ii|iii|iv)\.?$/i, "")
  .replace(/\s+(dst|d\/st|defense)$/i, "")
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

const exact = new Map();
for (const p of players) {
  exact.set(normalize(p.name), p);
  for (const alias of p.aliases || []) exact.set(normalize(alias), p);
}

const dstNicknameToTeam = {
  "49ers": "SF", Bears: "CHI", Bengals: "CIN", Bills: "BUF", Broncos: "DEN",
  Browns: "CLE", Buccaneers: "TB", Cardinals: "ARI", Chargers: "LAC", Chiefs: "KC",
  Colts: "IND", Commanders: "WAS", Cowboys: "DAL", Dolphins: "MIA", Eagles: "PHI",
  Falcons: "ATL", Giants: "NYG", Jaguars: "JAX", Jets: "NYJ", Lions: "DET",
  Packers: "GB", Panthers: "CAR", Patriots: "NE", Raiders: "LV", Rams: "LAR",
  Ravens: "BAL", Saints: "NO", Seahawks: "SEA", Steelers: "PIT", Texans: "HOU",
  Titans: "TEN", Vikings: "MIN",
};

function matchPlayer(name, pos = "", team = "") {
  if (String(pos).toUpperCase().startsWith("DST") || String(pos).toUpperCase() === "DEF") {
    const code = String(team).match(/[A-Z]{2,3}/)?.[0] || dstNicknameToTeam[name];
    return players.find((p) => p.pos === "DEF" && p.team === code) || null;
  }
  return exact.get(normalize(name)) || null;
}

async function getHtml() {
  const fileArg = process.argv[2];
  if (fileArg) return readFileSync(fileArg, "utf8");
  const res = await fetch(URL, { headers: { "user-agent": "Mozilla/5.0 DraftHQ vegas-rankings refresh" } });
  if (!res.ok) throw new Error(`${res.status} fetching ${URL}`);
  return res.text();
}

// The Next.js page embeds every ranking row (including the fields for locked
// players when you're subscribed) as an escaped JSON array under "initialPlayers".
function extractInitialPlayers(html) {
  const key = 'initialPlayers\\":[';
  const start = html.indexOf(key);
  if (start < 0) throw new Error("Could not find initialPlayers data — page shape changed");
  let depth = 0, end = -1;
  for (let i = start + key.length - 1; i < html.length; i++) {
    const c = html[i];
    if (c === "[") depth++;
    else if (c === "]") { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) throw new Error("Could not find end of initialPlayers array");
  const BS = "@@BACKSLASH@@";
  const unesc = html.slice(start + 'initialPlayers\\":'.length, end + 1)
    .split("\\\\").join(BS)
    .split('\\"').join('"')
    .split("\\n").join("\n")
    .split("\\t").join("\t")
    .split("\\/").join("/")
    .split(BS).join("\\");
  return JSON.parse(unesc);
}

const html = await getHtml();
const rows = extractInitialPlayers(html);

const output = {};
const unmatched = [];
let locked = 0;
for (const row of rows) {
  // Locked rows are stripped server-side (empty name, resolved:false) unless you
  // hold a subscription — skip them so we only publish real, unlocked ranks.
  if (row.locked || !row.name || !row.name.trim()) { locked++; continue; }
  const isDst = String(row.pos).toUpperCase() === "DEF" || String(row.pos).toUpperCase().startsWith("DST");
  const p = matchPlayer(row.name, isDst ? "DEF" : "", isDst ? row.team : "");
  if (!p) { unmatched.push(`${row.rank}. ${row.name} (${row.team} ${row.pos})`); continue; }
  output[p.id] = {
    vegasRank: row.vegasRank ?? row.rank,
    vegasPoints: Number.isFinite(row.impliedPts) && row.impliedPts > 0 ? row.impliedPts : null,
    vegasAdp: Number.isFinite(row.value?.adp) ? row.value.adp : null,
  };
}

const generatedAt = new Date().toISOString();
const doc = {
  generatedAt,
  source: {
    label: "The Betting Insider — Vegas rankings",
    url: URL,
    capturedAt: generatedAt,
    note: "Vegas implied-point rankings. Ranks past the free preview require a paid subscription; unlocked rows only.",
  },
  players: output,
};
writeFileSync(join(root, "data", "vegas-rankings.json"), JSON.stringify(doc, null, 2) + "\n");

const unlocked = Object.keys(output).length;
console.log(`Wrote data/vegas-rankings.json — ${unlocked} matched, ${locked} locked/hidden, ${unmatched.length} unmatched.`);
if (unlocked <= 3) {
  console.log("Only the free preview was available. Save a signed-in copy of the page and pass it as an argument to import the full list.");
}
if (unmatched.length) console.log("Unmatched rows:\n  " + unmatched.slice(0, 20).join("\n  "));
