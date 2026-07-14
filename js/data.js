// data.js — loads the static JSON data bundles.
export async function loadData() {
  const bust = "v=3";
  const [league, playersDoc, lexicon] = await Promise.all([
    fetch(`data/league.json?${bust}`).then((r) => r.json()),
    fetch(`data/players.json?${bust}`).then((r) => r.json()),
    fetch(`data/intel-lexicon.json?${bust}`).then((r) => r.json()),
  ]);
  return { league, players: playersDoc.players, dataMeta: { source: playersDoc.source, generatedAt: playersDoc.generatedAt }, lexicon };
}
