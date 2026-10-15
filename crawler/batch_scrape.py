#!/usr/bin/env python3
"""Batch scrape commanders from edhtop16, cluster them, and save to data/."""
import json
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from crawl import API, crawl, normalize, slugify, write, rebuild_index
from cluster import compute_clusters

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

TOP_QUERY = """
query($first: Int!) {
  commanders(first: $first, sortBy: POPULARITY) {
    edges {
      node {
        name
      }
    }
  }
}
"""


def get_top_commanders(limit=120):
    req = urllib.request.Request(
        API,
        json.dumps({"query": TOP_QUERY, "variables": {"first": limit}}).encode(),
        {"content-type": "application/json", "user-agent": "cedh-commander-analyzer/0.1"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        res = json.load(r)
    return [e["node"]["name"] for e in res["data"]["commanders"]["edges"]]


def get_existing_names():
    idx_file = DATA_DIR / "index.js"
    if not idx_file.exists():
        return set()
    try:
        raw = idx_file.read_text(encoding="utf-8")
        idx = json.loads(raw.split("=", 1)[1].strip().rstrip(";"))
        return {x["name"] for x in idx}
    except Exception:
        return set()


def scrape_one(name):
    slug = slugify(name)
    target = DATA_DIR / f"{slug}.js"
    if target.exists() and target.stat().st_size > 5000:
        content = target.read_text(encoding="utf-8")
        if '"archetypes"' in content and '"packages"' in content:
            print(f"  Already exists with archetypes & packages: {name} -> skipping")
            return slug

    print(f"\n[{time.strftime('%H:%M:%S')}] Crawling: {name} (slug: {slug})")
    cmdr, entries = crawl(name)
    payload = normalize(cmdr, entries)
    print(f"  Normalizing: {len(payload['decks'])} decks with lists, {len(payload['cards'])} cards")
    if len(payload["decks"]) >= 4:
        print(f"  Clustering {len(payload['decks'])} decks and mining packages...")
        payload = compute_clusters(payload)
    else:
        print(f"  Too few decks ({len(payload['decks'])}), skipping archetype clustering.")
    write(slug, payload)
    print(f"  -> Saved data/{slug}.js")
    return slug


def main():
    count_to_scrape = int(sys.argv[1]) if len(sys.argv) > 1 else 5
    top_list = get_top_commanders(120)
    existing = get_existing_names()

    unscraped = [name for name in top_list if name not in existing]
    print(f"Found {len(top_list)} top commanders. Existing: {len(existing)}. Unscraped: {len(unscraped)}")

    to_process = unscraped[:count_to_scrape]
    print(f"Processing next {len(to_process)} commanders:")
    for i, n in enumerate(to_process, 1):
        print(f"  {i}. {n}")

    scraped = []
    for name in to_process:
        try:
            slug = scrape_one(name)
            scraped.append((name, slug))
        except Exception as e:
            print(f"  ERROR scraping {name}: {e}", file=sys.stderr)
        time.sleep(0.5)

    rebuild_index()
    print(f"\nFinished scraping {len(scraped)} commanders:")
    for name, slug in scraped:
        print(f"  - {name} ({slug})")


if __name__ == "__main__":
    main()
