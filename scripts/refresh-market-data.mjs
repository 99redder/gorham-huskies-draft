#!/usr/bin/env node
// Capture the two public ranking sources used alongside the modeled FFC ADP.
// Run close to draft day: node scripts/refresh-market-data.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const players = JSON.parse(readFileSync(join(root, "data", "players.json"))).players;

const URLS = {
  yahoo: "https://football.fantasysports.yahoo.com/f1/public_prerank",
  sleeper: "https://yafsb.com/fantasy-football/adp-rankings/?scoring_type=half_ppr&league_size=8&is_superflex=False&is_dynasty=False&is_rookies=False",
};

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

async function get(url) {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 DraftHQ market-data refresh" } });
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  return res.text();
}

const [yahooHtml, sleeperHtml] = await Promise.all([get(URLS.yahoo), get(URLS.sleeper)]);
const output = {};
const unmatched = { yahoo: [], sleeper: [] };

// The first numbered list on Yahoo's page is its Top 200 Default Rankings; a
// second list contains auction values, so intentionally stop after 200 entries.
const yahooRows = [...yahooHtml.matchAll(/<li class="Listitem Phone-fz-lg">(\d+)\.\s*([^<(]+?)(?:\s*\(\$\d+\))?<\/li>/g)]
  .slice(0, 200)
  .map((m) => ({ rank: +m[1], name: m[2].trim() }));
if (yahooRows.length < 150) throw new Error(`Only found ${yahooRows.length} Yahoo ranks`);
for (const row of yahooRows) {
  const p = matchPlayer(row.name, dstNicknameToTeam[row.name] ? "DEF" : "", dstNicknameToTeam[row.name] || "");
  if (p) (output[p.id] ||= {}).yahooRank = row.rank;
  else unmatched.yahoo.push(row.name);
}

// YAFSB publishes the distribution of actual Sleeper picks as a Bokeh document.
// Average each player's overall picks to produce a transparent Sleeper ADP.
const docsMatch = sleeperHtml.match(/const docs_json = '(\{.*?\})';/s);
if (!docsMatch) throw new Error("Could not find Sleeper draft distribution data");
const docs = JSON.parse(docsMatch[1]);
const nodes = [];
const visit = (value) => {
  if (!value || typeof value !== "object") return;
  nodes.push(value);
  if (Array.isArray(value)) value.forEach(visit);
  else Object.values(value).forEach(visit);
};
visit(docs);
const sourceNode = nodes.find((n) => n.name === "ColumnDataSource"
  && n.attributes?.data?.entries?.some(([key]) => key === "x")
  && n.attributes?.data?.entries?.some(([key]) => key === "y"));
const axisNode = nodes.find((n) => n.name === "LinearAxis" && n.attributes?.major_label_overrides?.entries);
if (!sourceNode || !axisNode) throw new Error("Sleeper distribution shape changed");
const series = Object.fromEntries(sourceNode.attributes.data.entries);
const labels = new Map(axisNode.attributes.major_label_overrides.entries);
const picksByPlayer = new Map();
for (let i = 0; i < series.x.length; i++) {
  if (!Number.isFinite(series.x[i]) || !Number.isFinite(series.y[i])) continue;
  (picksByPlayer.get(series.y[i]) || picksByPlayer.set(series.y[i], []).get(series.y[i])).push(series.x[i]);
}
const decode = (s) => s.replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
for (const [idx, picks] of picksByPlayer) {
  const name = decode(labels.get(idx) || "");
  const isDst = /^[A-Z]{2,3}$/.test(name);
  const p = matchPlayer(name, isDst ? "DEF" : "", isDst ? name : "");
  const adp = Math.round((picks.reduce((a, n) => a + n, 0) / picks.length) * 10) / 10;
  if (p) (output[p.id] ||= {}).sleeperAdp = adp;
  else unmatched.sleeper.push(name);
}

const generatedAt = new Date().toISOString();
const doc = {
  generatedAt,
  sources: {
    yahoo: {
      label: "Yahoo default preseason rank",
      url: URLS.yahoo,
      capturedAt: generatedAt,
      note: "Public Top 200 default pre-draft rankings; distinct from Yahoo Expert Rank.",
    },
    sleeper: {
      label: "Sleeper half-PPR redraft ADP",
      url: URLS.sleeper,
      capturedAt: generatedAt,
      note: "Average actual picks from recent 8-team, 1-QB, half-PPR Sleeper drafts via YAFSB.",
    },
  },
  players: output,
};

writeFileSync(join(root, "data", "rankings.json"), JSON.stringify(doc, null, 2) + "\n");
const covered = (key) => Object.values(output).filter((v) => v[key] != null).length;
console.log(`Wrote data/rankings.json — Yahoo ${covered("yahooRank")}/${players.length}, Sleeper ${covered("sleeperAdp")}/${players.length}`);
console.log(`Unmatched source rows — Yahoo ${unmatched.yahoo.length}, Sleeper ${unmatched.sleeper.length}`);
