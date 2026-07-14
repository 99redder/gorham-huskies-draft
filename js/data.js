// data.js — loads the static JSON data bundles.
export async function loadData() {
  const bust = "v=6";
  const [league, playersDoc, lexicon, seedIntel] = await Promise.all([
    fetch(`data/league.json?${bust}`).then((r) => r.json()),
    fetch(`data/players.json?${bust}`).then((r) => r.json()),
    fetch(`data/intel-lexicon.json?${bust}`).then((r) => r.json()),
    fetch(`data/intel-seed.json?${bust}`).then((r) => r.json()).catch(() => ({ version: 0, entries: [] })),
  ]);
  return { league, players: playersDoc.players, dataMeta: { source: playersDoc.source, generatedAt: playersDoc.generatedAt }, lexicon, seedIntel };
}
