#!/usr/bin/env node
// Pull public preseason reports into a small, auditable static snapshot.
// No article bodies are stored: title + short excerpt + source link only.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseIntel } from "../js/intel.js";

const root = new URL("../", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));
const [config, playersDoc, lexicon] = await Promise.all([
  readJson("data/alpha-sources.json"), readJson("data/players.json"), readJson("data/intel-lexicon.json"),
]);
const players = playersDoc.players;
const now = Date.now();
const cutoff = now - (config.maxAgeDays || 45) * 86400000;
const headers = { "user-agent": "DraftHQ preseason-alpha/1.0 (public feed reader)" };

const decode = (value = "") => String(value)
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/\s+/g, " ").trim();
const tag = (xml, name) => decode((xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i")) || [])[1]);
const attr = (xml, name, key) => (xml.match(new RegExp(`<${name}[^>]*\\s${key}=["']([^"']+)["']`, "i")) || [])[1] || "";
const stableId = (value) => createHash("sha256").update(value).digest("hex").slice(0, 16);
const normalized = (value) => String(value || "").toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9]+/g, " ").trim();

function parseFeed(xml, type) {
  const blocks = type === "atom"
    ? [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((m) => m[0])
    : [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((m) => m[0]);
  return blocks.slice(0, 60).map((block) => {
    const title = tag(block, "title");
    const excerpt = tag(block, type === "atom" ? "content" : "description") || tag(block, "summary");
    const url = type === "atom" ? attr(block, "link", "href") : tag(block, "link");
    const publishedRaw = tag(block, "pubDate") || tag(block, "published") || tag(block, "updated") || tag(block, "dc:date");
    const publishedAt = Number.isNaN(Date.parse(publishedRaw)) ? null : new Date(publishedRaw).toISOString();
    return { title, excerpt: excerpt.slice(0, 320), url, publishedAt };
  }).filter((item) => item.title && item.url && (!item.publishedAt || Date.parse(item.publishedAt) >= cutoff));
}

function strictMatches(item, source) {
  const text = `${item.title}. ${item.excerpt}`;
  const textNorm = normalized(text);
  const titleNorm = normalized(item.title);
  const reportCue = /first[- ]team|named (?:the )?starter|expected to start|starting (?:job|role)|(?:earned|getting|taking) reps|depth chart|training camp|practice|increased workload|target share|committee|injur|carted|limited|miss(?:ing)? time|surgery|out for|pup|ir\b/i;
  return parseIntel(text, players, lexicon)
    .filter((match) => match.player && Math.abs(match.sentiment) >= 0.75)
    .filter((match) => {
      const full = normalized(match.player.name.replace(/\s+(jr|sr|ii|iii|iv)\.?$/i, ""));
      return full.includes(" ") && textNorm.includes(full)
        && titleNorm.includes(full) && reportCue.test(item.title);
    })
    .map((match) => {
      const injuryHeadline = /suffers? .*injur|dealing with .*injur|carted|limited|miss(?:ing)? time|surgery|out for|pup|ir\b|torn|ruptured|sidelined|questionable|doubtful/i.test(item.title);
      const status = /out for|miss(?:ing)? time|season[- ]ending|torn|ruptured/i.test(item.title)
        ? "Out" : /pup/i.test(item.title) ? "PUP" : /\bir\b/i.test(item.title) ? "IR" : "Questionable";
      return {
        playerId: match.player.id,
        name: match.player.name,
        delta: Math.max(-6, Math.min(6, Math.round(match.magnitude * 10) / 10)),
        ...(injuryHeadline ? { injury: { status, note: item.title.slice(0, 180),
          sourceUpdatedAt: item.publishedAt ? Date.parse(item.publishedAt) : now } } : {}),
      };
    })
    .filter((match) => match.delta !== 0);
}

async function fetchFeed(source) {
  const response = await fetch(source.url, { headers });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const items = parseFeed(await response.text(), source.type);
  return items.map((item) => ({ ...item, matches: strictMatches(item, source) })).filter((item) => item.matches.length);
}

async function fetchSleeperTrends(source) {
  const [trendResponse, playersResponse] = await Promise.all([
    fetch(source.url, { headers }), fetch("https://api.sleeper.app/v1/players/nfl", { headers }),
  ]);
  if (!trendResponse.ok || !playersResponse.ok) throw new Error(`HTTP ${trendResponse.status}/${playersResponse.status}`);
  const [trends, sleeperPlayers] = await Promise.all([trendResponse.json(), playersResponse.json()]);
  const byName = new Map(players.map((p) => [normalized(p.name.replace(/\s+(jr|sr|ii|iii|iv)\.?$/i, "")), p]));
  return trends.slice(0, 30).flatMap((trend, index) => {
    const sleeper = sleeperPlayers[trend.player_id];
    const player = sleeper?.full_name && byName.get(normalized(sleeper.full_name));
    if (!player) return [];
    const count = Number(trend.count) || 0;
    const delta = Math.min(5, Math.max(1.5, 1.5 + Math.log10(Math.max(1, count))));
    return [{
      title: `${player.name} is trending in Sleeper adds`,
      excerpt: `Top-${index + 1} add over the last 24 hours (${count.toLocaleString()} adds). Treat as market momentum, not a confirmed role change.`,
      url: "https://sleeper.com/",
      publishedAt: new Date(now).toISOString(),
      matches: [{ playerId: player.id, name: player.name, delta: Math.round(delta * 10) / 10 }],
    }];
  });
}

const statuses = [];
const entries = [];
for (const source of config.sources) {
  try {
    const items = source.type === "sleeper-trends" ? await fetchSleeperTrends(source) : await fetchFeed(source);
    for (const item of items) entries.push({
      id: `alpha_${stableId(`${source.id}|${item.url}|${item.title}`)}`,
      source: source.name, publisher: source.publisher, sourceUrl: item.url,
      title: item.title.slice(0, 180), snippet: item.excerpt.slice(0, 240),
      publishedAt: item.publishedAt, trust: source.trust, matches: item.matches,
    });
    statuses.push({ id: source.id, name: source.name, url: source.url, ok: true, matched: items.length });
  } catch (error) {
    statuses.push({ id: source.id, name: source.name, url: source.url, ok: false, matched: 0, error: error.message });
  }
}

entries.sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0));
const output = {
  version: 1, generatedAt: new Date(now).toISOString(), maxAgeDays: config.maxAgeDays,
  methodology: "Strict full-name match plus deterministic bullish/bearish phrase. Source trust and freshness are applied in the app.",
  sources: statuses, entries: entries.slice(0, 180),
};
await writeFile(new URL("data/preseason-alpha.json", root), `${JSON.stringify(output, null, 2)}\n`);
console.log(`Wrote ${output.entries.length} signals from ${statuses.filter((s) => s.ok).length}/${statuses.length} sources.`);
for (const status of statuses) console.log(`${status.ok ? "✓" : "✕"} ${status.name}: ${status.matched}${status.error ? ` (${status.error})` : ""}`);
