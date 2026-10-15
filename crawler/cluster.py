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


def mine_greedy_packages(cards, decks, archetypes_map=None):
    """Precomputes greedy mutually co-dependent non-staple tech packages."""
    import numpy as np

    num_decks = len(decks)
    num_cards = len(cards)
    if num_decks < 10 or num_cards < 5:
        return []

    deck_sets = [set(ci for ci, _ in d["cards"] if ci < num_cards) for d in decks]
    card_pop = [sum(1 for s in deck_sets if i in s) for i in range(num_cards)]

    # Candidate non-staple tech cards: 1.5% to 60% inclusion, in at least 4 decks
    candidates = []
    for i in range(num_cards):
        pop = card_pop[i]
        ratio = pop / num_decks
        c_name = cards[i]["name"]
        c_type = cards[i].get("type") or ""
        if "Basic Land" in c_type:
            continue
        if 0.015 <= ratio <= 0.60 and pop >= 4:
            candidates.append(i)

    if len(candidates) < 2:
        return []

    # Count pairwise occurrences
    pair_counts = {}
    for s in deck_sets:
        active = [i for i in candidates if i in s]
        for a in range(len(active)):
            ia = active[a]
            for b in range(a + 1, len(active)):
                ib = active[b]
                k = (ia, ib) if ia < ib else (ib, ia)
                pair_counts[k] = pair_counts.get(k, 0) + 1

    # Find strong co-dependent pairs (>=75% mutual or >=85% directed)
    seed_pairs = []
    for (ia, ib), nab in pair_counts.items():
        if nab < 4:
            continue
        na, nb = card_pop[ia], card_pop[ib]
        p_a_b = nab / nb
        p_b_a = nab / na
        if (p_a_b >= 0.75 and p_b_a >= 0.75) or (p_a_b >= 0.85 and p_b_a >= 0.55) or (p_b_a >= 0.85 and p_a_b >= 0.55):
            seed_pairs.append((ia, ib, nab, p_a_b * p_b_a))

    seed_pairs.sort(key=lambda x: x[3], reverse=True)

    packages = []
    seen_keys = set()

    for ia, ib, nab, _ in seed_pairs:
        current_pkg = [ia, ib]
        current_decks = [s for s in deck_sets if ia in s and ib in s]

        # Greedily search for candidate card C
        for cand in candidates:
            if cand in current_pkg:
                continue
            cand_in_pkg = sum(1 for s in current_decks if cand in s)
            cand_total = card_pop[cand]
            if len(current_decks) >= 4 and cand_total >= 4:
                p_c_pkg = cand_in_pkg / len(current_decks)
                p_pkg_c = cand_in_pkg / cand_total
                if p_c_pkg >= 0.75 and p_pkg_c >= 0.60:
                    current_pkg.append(cand)
                    current_decks = [s for s in current_decks if cand in s]
                    if len(current_pkg) >= 6:
                        break

        current_pkg.sort()
        key = tuple(current_pkg)
        if key not in seen_keys and len(current_decks) >= 4:
            seen_keys.add(key)
            cnt = len(current_decks)
            share = cnt / num_decks

            matching_indices = [i for i, s in enumerate(deck_sets) if set(key).issubset(s)]
            non_matching_indices = [i for i, s in enumerate(deck_sets) if not set(key).issubset(s)]

            wrs_with = [float(decks[i].get("winRate") or 0) for i in matching_indices]
            wrs_without = [float(decks[i].get("winRate") or 0) for i in non_matching_indices]

            wr_with = float(np.mean(wrs_with)) if wrs_with else 0.0
            wr_without = float(np.mean(wrs_without)) if wrs_without else 0.0
            top_with = sum(1 for i in matching_indices if decks[i].get("top")) / cnt

            # Random chance expectation capped at 999.0
            prod_prob = 1.0
            for ci in key:
                prod_prob *= (card_pop[ci] / num_decks)
            exp_count = prod_prob * num_decks
            raw_lift = (cnt / exp_count) if exp_count > 0 else 1.0
            lift = min(999.0, raw_lift)

            # Dominant archetype
            dom_arch = "Standard"
            if archetypes_map:
                arch_counts = {}
                for i in matching_indices:
                    cid = decks[i].get("c", 0)
                    arch_counts[cid] = arch_counts.get(cid, 0) + 1
                if arch_counts:
                    top_cid = max(arch_counts.keys(), key=lambda c: arch_counts[c])
                    dom_arch = archetypes_map.get(top_cid, "Standard")

            card_names = [cards[ci]["name"] for ci in key]
            packages.append({
                "cards": card_names,
                "name": " + ".join(card_names),
                "count": cnt,
                "size": len(key),
                "share": round(share, 3),
                "lift": round(lift, 1),
                "wrWith": round(wr_with, 3),
                "wrWithout": round(wr_without, 3),
                "delta": round(wr_with - wr_without, 3),
                "topWith": round(top_with, 3),
                "domArch": dom_arch,
            })

    # Subsumption & Overlap Deduplication: Keep maximal, distinct packages
    packages.sort(key=lambda p: (p["size"], p["count"]), reverse=True)
    maximal_packages = []
    for p in packages:
        p_set = set(p["cards"])
        is_redundant = False
        for mp in maximal_packages:
            mp_set = set(mp["cards"])
            overlap = len(p_set & mp_set) / min(len(p_set), len(mp_set))
            if overlap >= 0.50:
                is_redundant = True
                break
        if not is_redundant:
            maximal_packages.append(p)

    return maximal_packages[:20]


def compute_clusters(payload):
    """Adds Consensus Core + Tech Variant clusters, 2D coordinates, and precomputed greedy packages."""
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

    # 1. Identify Consensus Core Staples (>= 55% inclusion, non-basic land)
    core_card_indices = []
    for ci in range(num_cards):
        c_type = cards[ci].get("type") or ""
        if "Basic Land" not in c_type and card_pop[ci] >= 0.55:
            core_card_indices.append(ci)

    if not core_card_indices:
        core_card_indices = list(np.where(card_pop >= 0.40)[0])

    core_mask = np.zeros(num_cards, dtype=bool)
    core_mask[core_card_indices] = True

    # Core overlap ratio for each deck
    core_overlap = (X[:, core_card_indices] > 0).sum(axis=1) / len(core_card_indices)
    overlap_threshold = float(np.percentile(core_overlap, 35))
    is_core_deck = core_overlap >= overlap_threshold

    # Cluster labels: 0 = Consensus Core
    labels = np.zeros(num_decks, dtype=int)

    # 2. Cluster the Tech Variant decks (is_core_deck == False)
    var_indices = np.where(~is_core_deck)[0]
    num_var = len(var_indices)

    # Non-staple features for variant differentiation
    var_feat_mask = (card_pop >= 0.02) & (card_pop <= 0.85)
    if var_feat_mask.sum() < 5:
        var_feat_mask = (card_pop >= 0.01)

    X_var = X[:, var_feat_mask]
    tfidf = TfidfTransformer(norm="l2", sublinear_tf=True)
    X_tfidf = tfidf.fit_transform(X_var).toarray()

    n_comp = min(20, X_tfidf.shape[1] - 1, num_decks - 1)
    if n_comp >= 2:
        svd = TruncatedSVD(n_components=n_comp, random_state=42)
        X_svd = svd.fit_transform(X_tfidf)
    else:
        X_svd = X_tfidf

    k_variants = min(4, max(2, num_var // 80)) if num_var >= 40 else 1
    if num_var >= 15 and k_variants > 1:
        km = KMeans(n_clusters=k_variants, random_state=42, n_init=10)
        var_labels = km.fit(X_svd[var_indices]).labels_
        for idx_pos, orig_idx in enumerate(var_indices):
            labels[orig_idx] = var_labels[idx_pos] + 1  # 1, 2, ...
    else:
        for orig_idx in var_indices:
            labels[orig_idx] = 1

    total_clusters = int(labels.max()) + 1

    # 3. 2D t-SNE for point cloud
    perp = min(35, max(5, num_decks // 15))
    if perp >= num_decks:
        perp = max(2, num_decks - 1)
    tsne = TSNE(n_components=2, perplexity=perp, random_state=42, init="pca", learning_rate="auto")
    coords_2d = tsne.fit_transform(X_svd)

    std = coords_2d.std(axis=0)
    std[std == 0] = 1.0
    coords_norm = ((coords_2d - coords_2d.mean(axis=0)) / std * 38).round(1)

    for i, d in enumerate(decks):
        d["x"] = float(coords_norm[i, 0])
        d["y"] = float(coords_norm[i, 1])
        d["c"] = int(labels[i])

    # 4. Extract Archetypes & Signatures
    archetypes = []
    for c in range(total_clusters):
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

        diff_sorted_idx = np.argsort(diff)[::-1]
        signatures = []
        name_cards = []

        is_core_cluster = (c == 0)

        for idx in diff_sorted_idx:
            inc = float(in_cluster[idx])
            outc = float(out_cluster[idx])
            d_val = float(diff[idx])
            card_name = cards[idx]["name"]
            card_type = cards[idx].get("type") or ""
            is_land = "Land" in card_type

            if inc >= 0.15 and (d_val >= 0.08 or (is_core_cluster and inc >= 0.70)):
                signatures.append({
                    "card": card_name,
                    "inCluster": round(inc, 3),
                    "outCluster": round(outc, 3),
                    "diff": round(d_val, 3),
                    "type": card_type,
                    "cmc": cards[idx]["cmc"],
                })
                if len(name_cards) < 2 and inc >= 0.25 and not is_land:
                    name_cards.append(card_name)

            if len(signatures) >= 8:
                break

        if is_core_cluster:
            arch_name = "Consensus Core (Standard Build)"
        else:
            if not name_cards:
                top_avail = [signatures[j]["card"] for j in range(min(2, len(signatures)))]
                name_cards = top_avail or [f"Tech Variant {c}"]
            arch_name = " + ".join(name_cards)

        archetypes.append({
            "id": c,
            "name": arch_name,
            "isCore": is_core_cluster,
            "count": c_count,
            "share": round(c_count / num_decks, 3),
            "winRate": round(c_wr, 3),
            "signatures": signatures,
        })

    payload["archetypes"] = archetypes

    # 5. Precompute Greedy Tech Packages
    arch_map = {a["id"]: a["name"] for a in archetypes}
    packages = mine_greedy_packages(cards, decks, arch_map)
    payload["packages"] = packages

    print(f"  Clustered {num_decks} decks into {len(archetypes)} archetypes:")
    for a in archetypes:
        core_tag = " [CORE]" if a.get("isCore") else ""
        print(f"    - {a['name']}{core_tag}: {a['count']} decks ({a['share']:.1%}), WR {a['winRate']:.1%}")
    print(f"  Precomputed {len(packages)} greedy tech packages.")

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
            if f.name not in ("index.js", "matchups.js"):
                process_slug(f.stem)


if __name__ == "__main__":
    main()
