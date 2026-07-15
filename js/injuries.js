// injuries.js — normalize the public Sleeper player feed into Draft HQ records.
// Pure helpers live here so name matching and designation formatting are testable.

export const SLEEPER_PLAYERS_URL = "https://api.sleeper.app/v1/players/nfl";

export function normalizePlayerName(name) {
  return String(name || "").toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+(jr|sr|ii|iii|iv)\.?$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function injuryFromSleeper(player) {
  const status = String(player?.injury_status || "").trim();
  if (!status || ["NA", "DNR"].includes(status.toUpperCase())) return null;
  const details = [
    player.injury_body_part,
    player.injury_notes,
    player.practice_description || player.practice_participation,
  ].filter(Boolean).map(String);
  return {
    status,
    bodyPart: player.injury_body_part || null,
    note: [...new Set(details)].join(" · "),
    practice: player.practice_description || player.practice_participation || null,
    sourceUpdatedAt: Number.isFinite(player.news_updated) ? player.news_updated : null,
    sleeperPlayerId: player.player_id || null,
  };
}

export function matchSleeperInjuries(players, sleeperPlayers) {
  const byName = new Map();
  for (const player of Object.values(sleeperPlayers || {})) {
    if (player?.full_name) byName.set(normalizePlayerName(player.full_name), player);
  }
  const injuries = {};
  let matched = 0;
  for (const player of players) {
    if (player.pos === "DEF") continue;
    const sleeper = byName.get(normalizePlayerName(player.name));
    if (!sleeper) continue;
    matched++;
    const injury = injuryFromSleeper(sleeper);
    if (injury) injuries[player.id] = injury;
  }
  return { injuries, matched };
}

export function injuryAbbreviation(status) {
  const value = String(status || "").toUpperCase();
  return ({ QUESTIONABLE: "Q", DOUBTFUL: "D", OUT: "O", SUSPENDED: "SUS" })[value]
    || value.replace(/[^A-Z]/g, "").slice(0, 3)
    || "INJ";
}

const DAY = 86400000;
const SEASON_ENDING = /season[- ]ending|out for (?:the )?(?:entire )?season|miss (?:the )?(?:entire )?season|torn acl|acl tear|ruptured achilles|torn achilles/i;

function reportedGamesMissed(text) {
  const range = text.match(/(\d+)\s*(?:-|–|to)\s*(\d+)\s*(?:weeks?|games?)/i);
  if (range) return Math.max(+range[1], +range[2]);
  const games = text.match(/(?:miss|out|suspended)[^\d]{0,18}(\d+)\s*(?:weeks?|games?)/i);
  if (games) return +games[1];
  const numberedWeeks = [...text.matchAll(/week\s*(\d+)/gi)].map((m) => +m[1]);
  if (numberedWeeks.length >= 2) return new Set(numberedWeeks).size;
  return null;
}

// Translate a designation into a conservative score adjustment. This never removes
// a player on status alone: removal requires explicit season-ending language.
export function injuryImpact(injury, options = {}) {
  if (!injury) return { severity: "none", scorePenalty: 0, projectedGamesMissed: 0, unavailable: false };
  const now = options.now ?? Date.now();
  const maxAgeDays = options.maxAgeDays ?? 45;
  const updated = Number(injury.sourceUpdatedAt);
  const updatedMs = updated > 100000000000 ? updated : updated > 1000000000 ? updated * 1000 : null;
  if (updatedMs && now - updatedMs > maxAgeDays * DAY) {
    return { severity: "stale", scorePenalty: 0, projectedGamesMissed: null, unavailable: false,
      rationale: "Old designation; shown for context but not scored" };
  }

  const status = String(injury.status || "").toUpperCase();
  const text = `${status} ${injury.bodyPart || ""} ${injury.note || ""}`;
  if (SEASON_ENDING.test(text)) {
    return { severity: "season-ending", scorePenalty: -1000, projectedGamesMissed: 17,
      unavailable: true, rationale: "Explicit season-ending report" };
  }

  const games = reportedGamesMissed(text);
  let severity = "minor", penalty = -4;
  if (games >= 6) { severity = "long-term"; penalty = -35; }
  else if (games >= 3) { severity = "multi-week"; penalty = -22; }
  else if (games >= 1) { severity = "short-term"; penalty = -12; }
  else if (/\b(?:ACL|ACHILLES)\b/i.test(text) && /surgery|repair|tear|rupture/i.test(text)) { severity = "long-term"; penalty = -35; }
  else if (/surgery|procedure|repair/i.test(text)) { severity = "multi-week"; penalty = -18; }
  else if (/\b(?:IR|PUP|NFI)\b/.test(status)) { severity = "long-term"; penalty = -28; }
  else if (status === "OUT") { severity = "out"; penalty = -16; }
  else if (status === "DOUBTFUL") { severity = "doubtful"; penalty = -10; }
  else if (status === "SUSPENDED") { severity = "suspended"; penalty = -18; }
  else if (status === "QUESTIONABLE") { severity = "questionable"; penalty = -4; }

  if (/full (?:practice|participant)|practiced in full/i.test(text)) {
    severity = "minor";
    penalty = Math.max(penalty, -1);
  }

  return { severity, scorePenalty: penalty, projectedGamesMissed: games, unavailable: false,
    rationale: games ? `Reported absence: about ${games} game${games === 1 ? "" : "s"}` : `${injury.status} designation` };
}
