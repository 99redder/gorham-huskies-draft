# Draft HQ — Gorham Huskies Somersworth 🏈

A league-specific fantasy football **draft-day decision tool**, built as a static
PWA for the *Gorham Huskies Somersworth* Yahoo league (ID 160121). It recomputes
every player's value for **this league's exact scoring** and ranks by **Value Over
Replacement (VOR)** for the shallow 6-team format, then blends in consensus ADP,
computed tiers, your roster needs, and hand-entered analyst "alpha" intel.

**Live:** https://99redder.github.io/gorham-huskies-draft/

> Offline draft tool — it does **not** connect to Yahoo. You mark picks yourself as
> the draft happens.

## What it does

- **League-accurate scoring** — 0.5 PPR, 4pt pass TD, 6pt everywhere, return yards
  (25/pt), 4th-down stops (2 ea), tiered long FGs, and the full custom DST table are
  encoded in [`data/league.json`](data/league.json). Every projection is scored by
  these rules ([`js/scoring.js`](js/scoring.js)).
- **VOR for a 6-team league** — replacement levels are computed for *this* roster
  (1QB / 3RB / 3WR / 1TE / 1FLEX / K / DEF × 6 teams), so scarce-position premiums are
  correctly compressed vs a 12-teamer. Tiers are detected from projection cliffs
  ([`js/value.js`](js/value.js)).
- **Independent market ranks** — the board shows FFC ADP, actual Sleeper-draft ADP,
  Yahoo's public default preseason rank, and a disagreement spread. Each source has
  its own blend weight, so platform bias is visible instead of silently averaged.
- **Analyst intel ingest** — paste the *text* of a post (e.g. `@JagSays`), tag the
  source, and the app matches players + detects a bullish/bearish take, proposing an
  adjustable, source-weighted boost/fade you confirm before it moves the board
  ([`js/intel.js`](js/intel.js)). Everything is logged and editable.
- **Draft board + My Team** — mark players drafted (to you or another team), auto-fill
  your roster slots, see remaining needs, get live **Best Pick** recommendations and
  **positional-run alerts** ([`js/draft.js`](js/draft.js)).
- **Works offline / installable** — service worker + manifest; state persists in
  localStorage with JSON export/import.

## Data & provenance

- **Draft order / consensus ADP:** FantasyFootballCalculator Half-PPR consensus (a live
  aggregate of public mock drafts), captured **2026-07-14**.
- **Projected stat lines:** *modeled* from positional archetypes + targeted overrides
  (pass-catching backs, rushing QBs, kick/punt returners). They are a transparent
  **starting point meant to be edited** — every player carries `provenance: "modeled-2026"`.

To refresh before your draft, edit the `ADP` list (and any overrides) in
[`scripts/build-players.mjs`](scripts/build-players.mjs) and regenerate:

```bash
node scripts/build-players.mjs   # writes data/players.json
```

You can also edit [`data/players.json`](data/players.json) directly.

Refresh Yahoo and Sleeper market data separately (this writes
[`data/rankings.json`](data/rankings.json)):

```bash
node scripts/refresh-market-data.mjs
```

Yahoo's public rank is its default preseason/pre-draft rank, not its separate
Expert Rank. Sleeper ADP is calculated from recent 8-team, 1-QB, half-PPR redraft
pick distributions published by YAFSB, the closest public format to this 6-team league.

## Run locally

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Test

```bash
node test/scoring.test.mjs   # scoring math + VOR sanity checks
```

## Tuning the "Best Pick" blend

Open **⚙ Weights** to adjust how VOR, ADP value, roster need, and analyst intel combine
into the board's Score column. Defaults are tuned for a 6-team league.

## Notes

- X/Twitter has no free, CORS-open API, so intel is entered by pasting post text — by
  design. Trust weights per source live in [`data/intel-lexicon.json`](data/intel-lexicon.json).
- No backend, no build step, no framework — plain ES modules served statically.
