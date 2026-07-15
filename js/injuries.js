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
