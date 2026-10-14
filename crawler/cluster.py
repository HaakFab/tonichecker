#!/usr/bin/env python3
"""Clustering and 2D projection for cEDH Commander decklists.

Takes a normalized commander payload and computes:
- Archetype clusters via TF-IDF + SVD + KMeans
- 2D embedding (x, y) via t-SNE for interactive point-cloud visualization
- Archetype signature cards and performance metrics

Usage:
    python3 crawler/cluster.py [slug]
"""
import json
import re
import sys
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def compute_clusters(payload):
    """Adds x, y coordinates, cluster ID to each deck, and adds 'archetypes' list to payload."""
    try:
        import numpy as np
        from sklearn.feature_extraction.text import TfidfTransformer
        from sklearn.decomposition import TruncatedSVD
        from sklearn.cluster import KMeans
        from sklearn.manifold import TSNE
    except ImportError:
        print("  Warning: scikit-learn / numpy not found, skipping clustering.", file=sys.stderr)
        return payload

    cards = payload.get("cards", [])
    decks = payload.get("decks", [])
    num_decks = len(decks)
    num_cards = len(cards)

    if num_decks < 10 or num_cards < 10:
        print("  Not enough decks/cards to cluster.")
        return payload

    # Build binary matrix (decks x cards)
    X = np.zeros((num_decks, num_cards), dtype=np.float32)
    for i, d in enumerate(decks):
        for ci, _ in d["cards"]:
            if ci < num_cards:
                X[i, ci] = 1.0

    card_pop = X.sum(axis=0) / num_decks
    # Filter out staples (>93%) and super-rare noise (<2.5%)
    var_mask = (card_pop >= 0.025) & (card_pop <= 0.93)
    if var_mask.sum() < 10:
        var_mask = (card_pop >= 0.01) & (card_pop <= 0.98)

    X_var = X[:, var_mask]
    if X_var.shape[1] < 5:
        return payload

    # TF-IDF
    tfidf = TfidfTransformer(norm="l2", sublinear_tf=True)
    X_tfidf = tfidf.fit_transform(X_var).toarray()

    # SVD dimensionality reduction
    n_components = min(25, X_tfidf.shape[1] - 1, num_decks - 1)
    if n_components < 2:
        return payload

    svd = TruncatedSVD(n_components=n_components, random_state=42)
    X_svd = svd.fit_transform(X_tfidf)

    # Determine K (number of clusters)
    k = min(6, max(3, num_decks // 220))
    if num_decks < 50:
        k = 2

    km = KMeans(n_clusters=k, random_state=42, n_init=15).fit(X_svd)
    labels = km.labels_

    # 2D t-SNE for point cloud
    perp = min(35, max(5, num_decks // 15))
    if perp >= num_decks:
        perp = max(2, num_decks - 1)
    tsne = TSNE(n_components=2, perplexity=perp, random_state=42, init="pca", learning_rate="auto")
    coords_2d = tsne.fit_transform(X_svd)

    # Normalize to [-100, 100] scale
    std = coords_2d.std(axis=0)
    std[std == 0] = 1.0
    coords_norm = ((coords_2d - coords_2d.mean(axis=0)) / std * 38).round(1)

    # Assign coordinates and cluster to decks
    for i, d in enumerate(decks):
        d["x"] = float(coords_norm[i, 0])
        d["y"] = float(coords_norm[i, 1])
        d["c"] = int(labels[i])

    # Extract signature cards and stats for each archetype
    archetypes = []
    for c in range(k):
        c_mask = labels == c
        c_count = int(c_mask.sum())
        if c_count == 0:
            continue

        c_indices = np.where(c_mask)[0]
        wrs = [float(decks[i]["winRate"] or 0) for i in c_indices]
        c_wr = float(np.mean(wrs)) if wrs else 0.0

        in_cluster = X[c_mask].mean(axis=0)
        out_cluster = X[~c_mask].mean(axis=0) if (~c_mask).sum() > 0 else in_cluster
        diff = in_cluster - out_cluster

        # Rank cards by differential
        diff_sorted_idx = np.argsort(diff)[::-1]
        signatures = []
        name_cards = []

        for idx in diff_sorted_idx:
            inc = float(in_cluster[idx])
            outc = float(out_cluster[idx])
            d_val = float(diff[idx])
            card_name = cards[idx]["name"]
            card_type = cards[idx].get("type") or ""
            is_land = "Land" in card_type

            # Filter signature candidates: must have meaningful presence in cluster
            if inc >= 0.20 and d_val >= 0.12:
                signatures.append({
                    "card": card_name,
                    "inCluster": round(inc, 3),
                    "outCluster": round(outc, 3),
                    "diff": round(d_val, 3),
                    "type": card_type,
                    "cmc": cards[idx]["cmc"],
                })
                if len(name_cards) < 2 and inc >= 0.35 and not is_land:
                    name_cards.append(card_name)

            if len(signatures) >= 8:
                break

        # Fallback naming if no extreme single card
        if not name_cards:
            top_avail = [signatures[j]["card"] for j in range(min(2, len(signatures)))]
            name_cards = top_avail or [f"Variant {c+1}"]

        arch_name = " + ".join(name_cards)

        archetypes.append({
            "id": c,
            "name": arch_name,
            "count": c_count,
            "share": round(c_count / num_decks, 3),
            "winRate": round(c_wr, 3),
            "signatures": signatures,
        })

    # Sort archetypes by count descending, re-index
    archetypes.sort(key=lambda a: a["count"], reverse=True)
    old_to_new = {a["id"]: new_id for new_id, a in enumerate(archetypes)}
    for new_id, a in enumerate(archetypes):
        a["id"] = new_id
    for d in decks:
        d["c"] = old_to_new.get(d["c"], 0)

    payload["archetypes"] = archetypes
    print(f"  Clustered {num_decks} decks into {len(archetypes)} archetypes:")
    for a in archetypes:
        print(f"    - {a['name']}: {a['count']} decks ({a['share']:.1%}), WR {a['winRate']:.1%}")

    return payload


def process_slug(slug):
    js_path = DATA_DIR / f"{slug}.js"
    if not js_path.exists():
        print(f"File not found: {js_path}", file=sys.stderr)
        return False

    text = js_path.read_text(encoding="utf-8")
    m = re.search(r'window\.CEDH_DATA\[".*?"\] = (\{.*\});', text)
    if not m:
        print(f"Could not parse payload in {js_path}", file=sys.stderr)
        return False

    payload = json.loads(m.group(1))
    print(f"Clustering {payload.get('commander', slug)}...")
    payload = compute_clusters(payload)

    # Write back
    js_path.write_text(
        "window.CEDH_DATA = window.CEDH_DATA || {};\n"
        f"window.CEDH_DATA[{json.dumps(slug)}] = {json.dumps(payload, separators=(',', ':'))};\n",
        encoding="utf-8",
    )
    print(f"Updated {js_path.name} with archetypes & coordinates.")
    return True


def main():
    if len(sys.argv) > 1:
        slug = sys.argv[1].replace(".js", "").replace("data/", "")
        process_slug(slug)
    else:
        # Cluster all data files
        for f in sorted(DATA_DIR.glob("*.js")):
            if f.name != "index.js":
                process_slug(f.stem)


if __name__ == "__main__":
    main()
