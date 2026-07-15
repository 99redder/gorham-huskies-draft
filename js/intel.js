// intel.js — the "alpha" ingest feature.
// User pastes the text of an analyst post (e.g. @JagSays); we detect which players
// are mentioned and whether the take is bullish/bearish, then propose an adjustable
// score delta per player, weighted by the source's trust. Nothing is applied until
// the user confirms in the review UI (app.js). All matching/sentiment is heuristic
// and fully client-side.

const STOP = new Set(["the", "and", "for", "with", "his", "her", "you", "are", "was",
  "but", "not", "has", "had", "who", "all", "out", "get", "got", "one", "two", "this",
  "that", "they", "him", "she", "def", "dst"]);

function normalize(s) {
  return s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9'\s.-]/g, " ").replace(/\s+/g, " ").trim();
}

// Build a lookup from every name/alias -> player, keyed by normalized string.
// Also index by bare last name for loose matching (with ambiguity tracking).
export function buildNameIndex(players) {
  const exact = new Map();      // "ja'marr chase" -> player
  const lastName = new Map();   // "chase" -> [players]
  const add = (key, p, bucket) => {
    key = normalize(key);
    if (!key) return;
    if (bucket === "exact") { if (!exact.has(key)) exact.set(key, p); }
    else { (lastName.get(key) || lastName.set(key, []).get(key)).push(p); }
  };
  for (const p of players) {
    add(p.name, p, "exact");
    // Only multi-word aliases (full names, "F. Last") go into the exact index —
    // single-token last names would collide with common/sentiment words.
    for (const a of p.aliases || []) {
      if (normalize(a).includes(" ")) add(a, p, "exact");
    }
    if (p.pos !== "DEF") {
      const parts = normalize(p.name.replace(/\s+(jr|sr|ii|iii|iv)\.?$/i, "")).split(" ");
      if (parts.length >= 2) add(parts.slice(1).join(" "), p, "last");
    } else {
      add(p.team, p, "exact");
      add(p.name.replace(/ dst$/i, ""), p, "exact");
    }
  }
  return { exact, lastName };
}

// Resolve a single player name (e.g. from seed intel) to a player via the index.
// Handles suffix differences ("James Cook" -> "James Cook III") and unambiguous
// last names; returns null if not found or ambiguous.
export function resolvePlayer(name, index) {
  const key = normalize(name);
  if (index.exact.has(key)) return index.exact.get(key);
  const parts = key.replace(/\s+(jr|sr|ii|iii|iv)\.?$/i, "").split(" ");
  const ln = parts.length >= 2 ? parts.slice(1).join(" ") : parts[0];
  const cands = index.lastName.get(ln);
  return cands && cands.length === 1 ? cands[0] : null;
}

// Scan text, return matches: [{player, snippet, sentiment, magnitude, ambiguous, candidates}]
export function parseIntel(text, players, lexicon) {
  const index = buildNameIndex(players);
  const norm = normalize(text);
  const sentences = text.split(/(?<=[.!?\n])\s+/);
  const found = new Map(); // playerId -> match

  // Try to locate each player by exact name/alias first (longest keys first).
  const keys = [...index.exact.keys()].sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (key.length < 3) continue;
    const re = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (re.test(norm)) registerMatch(index.exact.get(key), key, text, sentences, lexicon, found);
  }
  // Loose last-name matches (only if unambiguous and not already found).
  const reserved = new Set([...Object.keys(lexicon.boost), ...Object.keys(lexicon.fade),
    ...lexicon.negators, ...STOP]);
  const foundLastNames = new Set();
  for (const m of found.values())
    if (m.player) foundLastNames.add(lastNameOf(m.player));
  for (const [ln, cands] of index.lastName) {
    if (ln.length < 4) continue;
    if (reserved.has(ln)) continue; // e.g. "love", "high" — too ambiguous with plain English
    if (foundLastNames.has(ln)) continue; // surname already explained by a full-name match
    const re = new RegExp(`\\b${ln.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (!re.test(norm)) continue;
    const fresh = cands.filter((c) => !found.has(c.id));
    if (fresh.length === 1) registerMatch(fresh[0], ln, text, sentences, lexicon, found);
    else if (fresh.length > 1) {
      // ambiguous: surface for manual resolution
      found.set("amb:" + ln, { player: null, ambiguous: true, token: ln,
        candidates: fresh, snippet: sentenceContaining(sentences, ln), sentiment: 0, magnitude: 0 });
    }
  }
  return [...found.values()];
}

function registerMatch(player, key, fullText, sentences, lexicon, found) {
  if (!player || found.has(player.id)) return;
  const snippet = sentenceContaining(sentences, key) || fullText.slice(0, 140);
  const { score } = scoreSentiment(snippet, lexicon);
  found.set(player.id, {
    player, ambiguous: false, snippet: snippet.trim(),
    sentiment: score, magnitude: Math.round(score * lexicon.baseMagnitude * 10) / 10
  });
}

function lastNameOf(p) {
  if (p.pos === "DEF") return "";
  const parts = normalize(p.name.replace(/\s+(jr|sr|ii|iii|iv)\.?$/i, "")).split(" ");
  return parts.length >= 2 ? parts.slice(1).join(" ") : parts[0];
}

function sentenceContaining(sentences, key) {
  const nk = normalize(key);
  for (const s of sentences) if (normalize(s).includes(nk)) return s;
  return "";
}

// Sum boost/fade cues in a snippet; simple negation flips the nearest cue.
export function scoreSentiment(snippet, lexicon) {
  const words = normalize(snippet).split(" ");
  let score = 0;
  const merge = { ...lexicon.boost, ...lexicon.fade, ...lexicon.tierCues };
  // multi-word phrases first
  const lc = normalize(snippet);
  for (const phrase in merge) {
    if (phrase.includes(" ") && lc.includes(phrase)) score += merge[phrase];
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i].replace(/[.,]/g, "");
    let v = lexicon.boost[w] ?? lexicon.fade[w];
    if (v == null) continue;
    const prev = (words[i - 1] || "").replace(/[.,]/g, "");
    const prev2 = (words[i - 2] || "").replace(/[.,]/g, "");
    if (lexicon.negators.includes(prev) || lexicon.negators.includes(prev2)) v = -v;
    score += v;
  }
  return { score: clamp(score, -3.5, 3.5) };
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Final signed delta an intel entry contributes to a player's blended score.
export function intelDelta(entry, lexicon, trustOverrides = {}) {
  const trust = trustOverrides[entry.source]
    ?? (lexicon.sources && lexicon.sources[entry.source])
    ?? lexicon.defaultTrust
    ?? 1;
  // entry.magnitude is user-confirmed (may be edited via slider); trust scales it.
  return Math.round(entry.magnitude * trust * 10) / 10;
}

export function alphaFreshness(publishedAt, now = Date.now()) {
  const age = now - Date.parse(publishedAt || 0);
  if (!Number.isFinite(age) || age < 0) return 1;
  const days = age / 86400000;
  if (days <= 7) return 1;
  if (days <= 21) return 0.75;
  if (days <= 45) return 0.5;
  return 0;
}

export function alphaDelta(rawDelta, sourceTrust = 1, publishedAt, now = Date.now()) {
  return Math.round(rawDelta * sourceTrust * alphaFreshness(publishedAt, now) * 10) / 10;
}
