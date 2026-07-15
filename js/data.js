// data.js — loads the static JSON data bundles.
export async function loadData() {
  const bust = "v=9";
  const [league, playersDoc, rankingsDoc, lexicon, seedIntel] = await Promise.all([
    fetch(`data/league.json?${bust}`).then((r) => r.json()),
    fetch(`data/players.json?${bust}`).then((r) => r.json()),
    fetch(`data/rankings.json?${bust}`).then((r) => r.json()).catch(() => ({ players: {} })),
    fetch(`data/intel-lexicon.json?${bust}`).then((r) => r.json()),
    fetch(`data/intel-seed.json?${bust}`).then((r) => r.json()).catch(() => ({ version: 0, entries: [] })),
  ]);
  const players = playersDoc.players.map((p) => ({ ...p, ...(rankingsDoc.players?.[p.id] || {}) }));
  return {
    league, players, lexicon, seedIntel,
    dataMeta: {
      source: playersDoc.source,
      generatedAt: playersDoc.generatedAt,
      rankingSources: rankingsDoc.sources || {},
      rankingsGeneratedAt: rankingsDoc.generatedAt || null,
    },
  };
}
