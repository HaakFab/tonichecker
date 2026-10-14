# ToniChecker: cEDH Analyzer

Analyze the performance, card choices and trends of a cEDH commander (or partner pair) using tournament data from [EDHTop16](https://edhtop16.com).

## Just want to look at the data?

1. Click **Code → Download ZIP** on GitHub and unzip it.
2. Double-click **`index.html`**. That's it – no installation.

(Card images need an internet connection.)

## Adding / updating a commander

Requires Python 3 (no extra packages):

```bash
python3 crawler/crawl.py "Rograkh, Son of Rohgahh / Silas Renn, Seeker Adept"
```

Use the exact commander name as on EDHTop16 (partners separated by ` / `). The crawl of a big commander takes a few minutes. Then reload `index.html` – the commander shows up in the dropdown.

## Features

- **Overview** – KPIs, activity & win rate over time, tournament size vs result, standings distribution, top pilots, recent winners
- **Cards** – inclusion %, win rate with/without each card, two-proportion z-test significance markings (`insig.`), top-cut rates, synergistic package tags
- **Trends** – card inclusion over time, rising/falling cards, land count & mana value distributions
- **Archetypes** – 2D vector embedding point cloud (t-SNE projection) grouping decks by card composition, cluster focus, signature card differentials, and associated packages
- **Archetype Trends** – meta share percentage over time, win rates, and top-cut conversion timelines per archetype
- **Packages (Card N-Grams)** – co-occurrence mining detecting statistically coupled combos, stax packages, and synergy clusters with Lift ratios and $\Delta$ win rates
- **Matchups & Pod Simulator** – pairwise head-to-head records against all top 32 cEDH commanders, opponent archetype breakdown, and an interactive 4-player pod simulator predicting win probabilities with seat-order weighting
- **Decks** – sortable tournament lists, interactive deck viewer (list/image view, copy decklist)
- **Filters** – date, tournament size, finish, win rate, player, tournament, include/exclude cards (shareable via URL)
- Hover any card name to see its card image popup live from Scryfall with subtle drafting tilt
- Preloaded with all top 32 cEDH commanders from EDHTop16 with precomputed archetype clustering
- Works offline directly via `file://` (double-click `index.html`), zero installation required
