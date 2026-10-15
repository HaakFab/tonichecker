#!/usr/bin/env python3
"""Crawl all entries + decklists of a commander (or partner pair) from edhtop16.

Pure standard library (no pip install needed).

Usage:
    python3 crawler/crawl.py "Rograkh, Son of Rohgahh / Silas Renn, Seeker Adept"

Writes:
    data/<slug>.js   -> window.CEDH_DATA["<slug>"] = {...}   (loaded via <script> by index.html)
    data/index.js    -> window.CEDH_INDEX = [{slug, name, decks, updated}, ...]
"""
import json
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API = "https://edhtop16.com/api/graphql"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
PAGE_SIZE = 200

QUERY = """
query($name: String!, $first: Int!, $after: String) {
  commander(name: $name) {
    name
    colorId
    entries(first: $first, after: $after, sortBy: NEW) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        id standing wins losses draws winRate decklistUrl hasDecklist
        player { name }
        tournament { name size tournamentDate TID topCut }
        decklistItems { count card { name type cmc colorId } }
      } }
    }
  }
}
"""


def gql(variables, retries=5):
    body = json.dumps({"query": QUERY, "variables": variables}).encode()
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                API, body, {"content-type": "application/json", "user-agent": "cedh-commander-analyzer/0.1"}
            )
            with urllib.request.urlopen(req, timeout=60) as r:
                res = json.load(r)
            if "errors" in res:
                raise RuntimeError(res["errors"])
            return res["data"]
        except Exception as e:  # noqa: BLE001
            wait = 2 ** attempt
            print(f"  request failed ({e}); retry in {wait}s", file=sys.stderr)
            time.sleep(wait)
    raise SystemExit("edhtop16 API unreachable")


def slugify(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def crawl(name):
    entries, cursor, cmdr = [], None, None
    while True:
        data = gql({"name": name, "first": PAGE_SIZE, "after": cursor})
        cmdr = data["commander"]
        if cmdr is None:
            raise SystemExit(f"Commander not found: {name!r}")
        conn = cmdr["entries"]
        entries += [e["node"] for e in conn["edges"]]
        print(f"  fetched {len(entries)} entries")
        if not conn["pageInfo"]["hasNextPage"]:
            break
        cursor = conn["pageInfo"]["endCursor"]
        time.sleep(0.3)
    return cmdr, entries


def normalize(cmdr, entries):
    """Compact format: card table once, decks reference card indices."""
    cards, card_idx, decks, tournaments, t_idx = [], {}, [], [], {}
    for e in entries:
        items = e["decklistItems"] or []
        if not e["hasDecklist"] or not items:
            continue
        t = e["tournament"]
        if t["TID"] not in t_idx:
            t_idx[t["TID"]] = len(tournaments)
            tournaments.append({"id": t["TID"], "name": t["name"], "size": t["size"],
                                "date": t["tournamentDate"][:10], "topCut": t["topCut"]})
        deck_cards = []
        for it in items:
            c = it["card"]
            if c["name"] not in card_idx:
                card_idx[c["name"]] = len(cards)
                cards.append({"name": c["name"], "type": c["type"], "cmc": c["cmc"], "color": c["colorId"]})
            deck_cards.append([card_idx[c["name"]], it["count"]])
        decks.append({
            "id": e["id"], "player": e["player"]["name"], "t": t_idx[t["TID"]],
            "standing": e["standing"], "w": e["wins"], "l": e["losses"], "d": e["draws"],
            "winRate": e["winRate"], "url": e["decklistUrl"], "cards": deck_cards,
        })
    return {"commander": cmdr["name"], "colorId": cmdr["colorId"],
            "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "cards": cards, "tournaments": tournaments, "decks": decks}


def rebuild_index():
    index = []
    for f in sorted(DATA_DIR.glob("*.js")):
        if f.name in ("index.js", "matchups.js"):
            continue
        try:
            head = f.read_text(encoding="utf-8")[:4000]
            m_slug = re.search(r'CEDH_DATA\["(.+?)"\]', head)
            m_cmdr = re.search(r'"commander":"(.*?)"', head)
            m_upd = re.search(r'"updated":"(.*?)"', head)
            if m_slug:
                s = m_slug.group(1)
                name = m_cmdr.group(1) if m_cmdr else s
                upd = m_upd.group(1) if m_upd else ""
                index.append({"slug": s, "name": name, "updated": upd})
        except Exception:
            pass
    index.sort(key=lambda x: x["name"])
    (DATA_DIR / "index.js").write_text(f"window.CEDH_INDEX = {json.dumps(index)};\n", encoding="utf-8")


def write(slug, payload):
    DATA_DIR.mkdir(exist_ok=True)
    (DATA_DIR / f"{slug}.js").write_text(
        "window.CEDH_DATA = window.CEDH_DATA || {};\n"
        f"window.CEDH_DATA[{json.dumps(slug)}] = {json.dumps(payload, separators=(',', ':'))};\n",
        encoding="utf-8")
    rebuild_index()


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    name = " ".join(sys.argv[1:])
    print(f"Crawling {name} ...")
    cmdr, entries = crawl(name)
    payload = normalize(cmdr, entries)
    try:
        from cluster import compute_clusters
        print("Clustering decklists into archetypes...")
        payload = compute_clusters(payload)
    except Exception as e:
        print(f"Clustering skipped: {e}")
    slug = slugify(cmdr["name"])
    write(slug, payload)
    print(f"Done: {len(payload['decks'])} decks with lists, {len(payload['cards'])} unique cards -> data/{slug}.js")


if __name__ == "__main__":
    main()
