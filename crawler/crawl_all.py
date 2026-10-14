#!/usr/bin/env python3
"""Batch crawl all top commanders from edhtop16 and cluster decklists into archetypes.

Fetches the top 32 commanders (matching the edhtop16 homepage with "Load more"),
crawls all tournament entries, normalizes card indices, computes archetypes and
t-SNE 2D coordinates, and saves them as offline .js files in data/.
"""
import json
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from crawl import API, crawl, normalize, slugify, write
from cluster import compute_clusters

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

TOP_QUERY = """
query {
  commanders(first: 32, sortBy: POPULARITY) {
    edges {
      node {
        name
      }
    }
  }
}
"""


def get_top_commanders():
    req = urllib.request.Request(
        API,
        json.dumps({"query": TOP_QUERY}).encode(),
        {"content-type": "application/json", "user-agent": "cedh-commander-analyzer/0.1"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        res = json.load(r)
    if "errors" in res:
        raise RuntimeError(res["errors"])
    return [e["node"]["name"] for e in res["data"]["commanders"]["edges"]]


def main():
    names = get_top_commanders()
    print(f"Found {len(names)} top commanders from edhtop16:")
    for i, n in enumerate(names, 1):
        print(f"  {i:2d}. {n}")

    for i, name in enumerate(names, 1):
        slug = slugify(name)
        target = DATA_DIR / f"{slug}.js"
        if target.exists() and target.stat().st_size > 5000:
            # Check if it already has archetypes
            content = target.read_text(encoding="utf-8")
            if '"archetypes"' in content:
                print(f"\n[{i}/{len(names)}] Already crawled & clustered: {name} ({slug}) - skipping")
                continue

        print(f"\n[{i}/{len(names)}] Crawling {name} ...")
        try:
            cmdr, entries = crawl(name)
            payload = normalize(cmdr, entries)
            print(f"  Clustering {len(payload['decks'])} decks...")
            payload = compute_clusters(payload)
            write(slug, payload)
            print(f"  -> Saved data/{slug}.js ({len(payload['decks'])} decks, {len(payload.get('archetypes', []))} archetypes)")
        except Exception as e:
            print(f"  ERROR crawling {name}: {e}", file=sys.stderr)
        time.sleep(0.5)

    print("\nBatch crawl complete! All top commanders ready for offline use.")


if __name__ == "__main__":
    main()
