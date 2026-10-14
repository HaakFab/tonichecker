/* cEDH Commander Analyzer – viewer. Vanilla JS, no build step, works from file://. */
(function () {
  'use strict';

  // ---------- helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const fmtDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const debounce = (fn, ms = 180) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const frontFace = (n) => n.split(' // ')[0];

  const PALETTE = ['#ffd600', '#ff385c', '#00f0ff', '#39ff14', '#ff9100', '#b388ff', '#ffffff', '#00e5ff'];
  const INK = '#f4fbff', BLUE = '#0b4676';
  const hatch = (shape = '/') => ({ color: 'rgba(0,0,0,0)', pattern: { shape, fgcolor: INK, bgcolor: 'rgba(0,0,0,0)', size: 7, solidity: 0.35 }, line: { color: INK, width: 1.5 } });
  const sq = (c = INK) => ({ size: 7, symbol: 'square', color: BLUE, line: { color: c, width: 2 } });
  const AXIS = { gridcolor: 'rgba(244,251,255,.18)', zerolinecolor: 'rgba(244,251,255,.5)', linecolor: INK, linewidth: 1.5, ticks: 'outside', tickcolor: INK, mirror: true };
  const plotLayout = (extra = {}) => Object.assign({
    paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
    font: { family: "'Share Tech Mono', Menlo, monospace", color: INK, size: 12 },
    margin: { l: 48, r: 24, t: 14, b: 42 },
    legend: { orientation: 'h', y: -0.2 }, hoverlabel: { bgcolor: BLUE, bordercolor: '#ffe58a', font: { color: INK, family: "'Share Tech Mono', monospace" } },
  }, extra, { xaxis: Object.assign({}, AXIS, extra.xaxis), yaxis: Object.assign({}, AXIS, extra.yaxis) },
  extra.yaxis2 ? { yaxis2: Object.assign({}, AXIS, { mirror: false, showgrid: false }, extra.yaxis2) } : {});
  const plotCfg = { displaylogo: false, responsive: true, displayModeBar: false };
  function plot(id, traces, layout) { const el = document.getElementById(id); if (el) Plotly.react(el, traces, plotLayout(layout), plotCfg); }

  // ---------- state ----------
  let D = null;            // current commander payload
  let decks = [];          // enriched decks
  let filtered = [];       // decks passing the filters
  let slug = null;
  let activeTab = 'overview';
  const DEFAULT_F = () => ({ from: '', to: '', size: 0, standing: 'all', wr: 0, player: '', tourn: '', inc: [], exc: [] });
  let F = DEFAULT_F();
  let dataMin = '', dataMax = '';
  let cardType = [];       // grouped type per card index
  const sortState = { cards: { key: 'inclusion', dir: -1 }, decks: { key: 'date', dir: -1 } };
  const limits = { cards: 150, decks: 100 };
  let trendCards = null;   // user-chosen cards for trend chart (indices)

  // ---------- data loading ----------
  function loadCommander(s) {
    slug = s;
    const start = () => { D = window.CEDH_DATA[s]; prepare(); };
    if (window.CEDH_DATA && window.CEDH_DATA[s]) { start(); afterLoad(); return; }
    $('#subtitle').textContent = 'Loading data…';
    const sc = document.createElement('script');
    sc.src = `data/${s}.js`;
    sc.onload = () => { start(); afterLoad(); };
    sc.onerror = () => { $('#subtitle').textContent = 'Could not load data file.'; };
    document.head.appendChild(sc);
  }

  function groupOf(typeLine) {
    const t = frontFace(typeLine).split('—')[0];
    if (/Land/.test(t)) return 'Land';
    if (/Creature/.test(t)) return 'Creature';
    if (/Planeswalker/.test(t)) return 'Planeswalker';
    if (/Instant/.test(t)) return 'Instant';
    if (/Sorcery/.test(t)) return 'Sorcery';
    if (/Artifact/.test(t)) return 'Artifact';
    if (/Enchantment/.test(t)) return 'Enchantment';
    if (/Battle/.test(t)) return 'Battle';
    return 'Other';
  }

  function prepare() {
    cardType = D.cards.map((c) => groupOf(c.type));
    decks = D.decks.map((d) => {
      const t = D.tournaments[d.t];
      const set = new Set(d.cards.map((c) => c[0]));
      const cut = t.topCut > 0 ? t.topCut : 4;
      let lands = 0, cmcSum = 0, nonland = 0;
      for (const [ci, n] of d.cards) {
        if (cardType[ci] === 'Land') lands += n; else { cmcSum += D.cards[ci].cmc * n; nonland += n; }
      }
      return Object.assign({}, d, { date: t.date, tname: t.name, tsize: t.size, set, top: d.standing <= cut, lands, avgCmc: nonland ? cmcSum / nonland : 0,
        tid: t.id, search: (d.player + ' ').toLowerCase(), tsearch: t.name.toLowerCase() });
    });
    dataMin = decks.reduce((m, d) => (d.date < m ? d.date : m), '9999');
    dataMax = decks.reduce((m, d) => (d.date > m ? d.date : m), '0000');
    $('#card-list').innerHTML = D.cards.map((c) => `<option value="${esc(c.name)}">`).join('');
  }

  function afterLoad() {
    $('#subtitle').textContent = '"Aber ich kann kein Excel"';
    $('#edh-link').href = 'https://edhtop16.com/commander/' + encodeURIComponent(D.commander);
    trendCards = null;
    $('#foot-cmdr').textContent = D.commander;
    $('#foot-date').textContent = new Date(D.updated).toLocaleDateString();
    if (!restoreHash()) F = DEFAULT_F();
    syncFilterUI();
    applyFilters();
  }

  // ---------- filters ----------
  function cardIdx(name) { return D.cards.findIndex((c) => c.name.toLowerCase() === name.toLowerCase()); }

  function applyFilters() {
    const incI = F.inc.map(cardIdx).filter((i) => i >= 0);
    const excI = F.exc.map(cardIdx).filter((i) => i >= 0);
    const p = F.player.trim().toLowerCase(), t = F.tourn.trim().toLowerCase();
    filtered = decks.filter((d) => {
      if (F.from && d.date < F.from) return false;
      if (F.to && d.date > F.to) return false;
      if (d.tsize < F.size) return false;
      if (F.standing === 'cut') { if (!d.top) return false; } else if (F.standing !== 'all' && d.standing > +F.standing) return false;
      if (d.winRate * 100 < F.wr) return false;
      if (p && !d.search.includes(p)) return false;
      if (t && !d.tsearch.includes(t)) return false;
      for (const i of incI) if (!d.set.has(i)) return false;
      for (const i of excI) if (d.set.has(i)) return false;
      return true;
    });
    $('#result-pill').innerHTML = `<b>${filtered.length.toLocaleString()}</b> of ${decks.length.toLocaleString()} decks`;
    writeHash();
    limits.cards = 150; limits.decks = 100;
    renderTab(activeTab);
  }

  function renderChips() {
    for (const k of ['inc', 'exc']) {
      $('#chips-' + k).innerHTML = F[k].map((n, i) => `<span class="chip ${k}"><span class="cardname" data-card="${esc(n)}">${esc(n)}</span><button data-rm="${k}:${i}" aria-label="Remove">×</button></span>`).join('');
    }
  }

  function syncFilterUI() {
    $('#f-from').value = F.from; $('#f-to').value = F.to;
    $('#f-from').min = $('#f-to').min = dataMin; $('#f-from').max = $('#f-to').max = dataMax;
    $('#f-size').value = F.size; $('#f-size-val').textContent = F.size;
    $('#f-standing').value = F.standing;
    $('#f-wr').value = F.wr; $('#f-wr-val').textContent = F.wr + '%';
    $('#f-player').value = F.player; $('#f-tourn').value = F.tourn;
    $$('#date-presets button').forEach((b) => b.classList.toggle('active', !F.from && !F.to && b.dataset.days === '0'));
    renderChips();
  }

  function initFilters() {
    const onChange = () => {
      F.from = $('#f-from').value; F.to = $('#f-to').value;
      F.size = +$('#f-size').value; F.standing = $('#f-standing').value; F.wr = +$('#f-wr').value;
      F.player = $('#f-player').value; F.tourn = $('#f-tourn').value;
      $('#f-size-val').textContent = F.size; $('#f-wr-val').textContent = F.wr + '%';
      $$('#date-presets button').forEach((b) => b.classList.remove('active'));
      applyFilters();
    };
    const deb = debounce(onChange, 160);
    ['f-from', 'f-to', 'f-standing'].forEach((id) => $('#' + id).addEventListener('change', onChange));
    ['f-size', 'f-wr', 'f-player', 'f-tourn'].forEach((id) => $('#' + id).addEventListener('input', deb));

    $('#date-presets').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const days = +b.dataset.days;
      if (days === 0) { F.from = ''; F.to = ''; } else {
        const end = new Date(dataMax + 'T00:00:00'); end.setDate(end.getDate() - days);
        F.from = end.toISOString().slice(0, 10); F.to = '';
      }
      syncFilterUI(); $$('#date-presets button').forEach((x) => x.classList.toggle('active', x === b)); applyFilters();
    });

    for (const k of ['inc', 'exc']) {
      const input = $('#f-' + k);
      const add = () => {
        const i = cardIdx(input.value.trim());
        if (i >= 0 && !F[k].includes(D.cards[i].name)) { F[k].push(D.cards[i].name); renderChips(); applyFilters(); }
        if (i >= 0) input.value = '';
      };
      input.addEventListener('change', add);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    }
    $('#filters').addEventListener('click', (e) => {
      const b = e.target.closest('[data-rm]'); if (!b) return;
      const [k, i] = b.dataset.rm.split(':'); F[k].splice(+i, 1); renderChips(); applyFilters();
    });
    $('#reset-filters').addEventListener('click', () => { F = DEFAULT_F(); syncFilterUI(); applyFilters(); });
  }

  // ---------- URL hash ----------
  function writeHash() {
    const diff = {}; const def = DEFAULT_F();
    for (const k in F) if (JSON.stringify(F[k]) !== JSON.stringify(def[k])) diff[k] = F[k];
    const h = `#c=${encodeURIComponent(slug)}&t=${activeTab}` + (Object.keys(diff).length ? `&f=${encodeURIComponent(JSON.stringify(diff))}` : '');
    history.replaceState(null, '', h);
  }
  function parseHash() { const o = {}; location.hash.slice(1).split('&').forEach((p) => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i)] = decodeURIComponent(p.slice(i + 1)); }); return o; }
  function restoreHash() {
    const h = parseHash();
    if (!h.f || h.c !== slug) return false;
    try { F = Object.assign(DEFAULT_F(), JSON.parse(h.f)); return true; } catch (e) { return false; }
  }

  // ---------- tabs ----------
  function initTabs() {
    $('.tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      setTab(b.dataset.tab);
    });
  }
  function setTab(t) {
    activeTab = t;
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    $$('.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + t));
    renderTab(t); writeHash();
  }
  const ALL_TABS = ['overview', 'cards', 'trends', 'archetypes', 'archetype-trends', 'packages', 'decks'];
  function renderTab(t) {
    if (!D) return;
    const idx = ALL_TABS.indexOf(t);
    $('#foot-sheet').textContent = (idx >= 0 ? idx + 1 : 1) + '/7';
    ({
      overview: renderOverview,
      cards: renderCards,
      trends: renderTrends,
      archetypes: renderArchetypes,
      'archetype-trends': renderArchetypeTrends,
      packages: renderPackages,
      decks: renderDecks,
    }[t] || (() => {}))();
  }

  // ---------- badges ----------
  const ord = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 >> 3 ^ 1) && n % 10 < 4 ? n % 10 : 0]);
  function standingBadge(s, top) {
    if (s === 1) return '<span class="badge gold">★ 1st</span>';
    if (s <= 4) return `<span class="badge silver">${ord(s)}</span>`;
    return top ? `<span class="badge cut">${ord(s)}</span>` : `<span class="badge">${ord(s)}</span>`;
  }
  const noData = () => '<div class="glass empty"><h3>No decks match your filters</h3><p>Try relaxing the filters on the left.</p></div>';

  // ---------- Overview ----------
  function monthly(list) {
    const m = new Map();
    for (const d of list) { const k = d.date.slice(0, 7); if (!m.has(k)) m.set(k, []); m.get(k).push(d); }
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }

  function renderOverview() {
    const el = $('#tab-overview');
    if (!filtered.length) { el.innerHTML = noData(); return; }
    const n = filtered.length;
    const wr = mean(filtered.map((d) => d.winRate));
    const tops = filtered.filter((d) => d.top).length;
    const wins = filtered.filter((d) => d.standing === 1).length;
    const players = new Set(filtered.map((d) => d.player)).size;
    const tourns = new Set(filtered.map((d) => d.tid)).size;
    el.innerHTML = `
      <div class="kpis">
        ${kpi('Decklists', n.toLocaleString(), `${tourns} tournaments`)}
        ${kpi('Avg. win rate', pct(wr), 'across all games')}
        ${kpi('Top-cut rate', pct(tops / n), `${tops} top-cut finishes`)}
        ${kpi('Tournament wins', wins, pct(wins / n) + ' of decks')}
        ${kpi('Pilots', players, `${(n / players).toFixed(1)} decks each`)}
      </div>
      <div class="grid2">
        <div class="glass panel"><h3>Activity & performance over time</h3><div class="hint">Decks per month (bars) and average win rate (line)</div><div id="p-monthly" class="plot"></div></div>
        <div class="glass panel"><h3>Tournament size vs. result</h3><div class="hint">Each dot is a deck; larger events are harder</div><div id="p-size" class="plot"></div></div>
      </div>
      <div class="grid2">
        <div class="glass panel"><h3>Win rate distribution</h3><div class="hint">How individual decks performed</div><div id="p-wrhist" class="plot"></div></div>
        <div class="glass panel"><h3>Final standing</h3><div class="hint">Distribution of finishes</div><div id="p-standing" class="plot"></div></div>
      </div>
      <div class="two-tables">
        <div class="glass panel"><h3>Top pilots</h3><div class="hint">By number of decks in current selection</div><div id="t-players"></div></div>
        <div class="glass panel"><h3>Recent winners</h3><div class="hint">Click a row to open the decklist</div><div id="t-winners"></div></div>
      </div>`;

    const mo = monthly(filtered);
    plot('p-monthly', [
      { type: 'bar', x: mo.map((m) => m[0]), y: mo.map((m) => m[1].length), name: 'Decks', marker: hatch('/'), hovertemplate: '%{y} decks<extra></extra>' },
      { type: 'scatter', mode: 'lines+markers', x: mo.map((m) => m[0]), y: mo.map((m) => mean(m[1].map((d) => d.winRate)) * 100), name: 'Avg win rate', yaxis: 'y2',
        line: { color: '#ffe58a', width: 2.5, dash: 'solid' }, marker: sq('#ffe58a'), hovertemplate: '%{y:.1f}%<extra></extra>' },
    ], { yaxis: { gridcolor: 'rgba(244,251,255,.18)', title: 'Decks' }, yaxis2: { overlaying: 'y', side: 'right', ticksuffix: '%', showgrid: false, rangemode: 'tozero' } });

    const buckets = [['1st', (s) => s === 1], ['2nd', (s) => s === 2], ['3–4th', (s) => s >= 3 && s <= 4], ['5–8th', (s) => s >= 5 && s <= 8], ['9–16th', (s) => s >= 9 && s <= 16], ['17th+', (s) => s > 16]];
    plot('p-standing', [{ type: 'bar', x: buckets.map((b) => b[0]), y: buckets.map((b) => filtered.filter((d) => b[1](d.standing)).length),
      marker: Object.assign(hatch('x'), { line: { color: INK, width: 1.5 } }), hovertemplate: '%{y} decks<extra></extra>' }]);

    const bins = new Array(20).fill(0);
    filtered.forEach((d) => { bins[Math.min(19, Math.floor(d.winRate * 20))]++; });
    plot('p-wrhist', [{ type: 'bar', x: bins.map((_, i) => i * 5 + 2.5), width: 4.4, y: bins, marker: hatch('x'), customdata: bins.map((_, i) => `${i * 5}–${i * 5 + 5}%`), hovertemplate: '%{customdata} win rate: %{y} decks<extra></extra>' }],
      { xaxis: { ticksuffix: '%', range: [0, 100] } });

    plot('p-size', [{ type: 'scattergl', mode: 'markers', x: filtered.map((d) => d.tsize), y: filtered.map((d) => d.winRate * 100),
      text: filtered.map((d) => `${esc(d.player)} · ${esc(d.tname)}`), marker: { size: 6, opacity: 0.8, symbol: 'cross-thin-open', line: { width: 1.5 }, color: filtered.map((d) => d.standing), colorscale: [[0, '#ffe58a'], [0.15, '#f4fbff'], [1, 'rgba(244,251,255,.45)']], cmax: 40, cmin: 1 },
      hovertemplate: '%{text}<br>%{x} players · %{y:.0f}% WR<extra></extra>' }],
      { xaxis: { title: 'Tournament size', gridcolor: 'rgba(244,251,255,.18)' }, yaxis: { ticksuffix: '%', title: 'Win rate', gridcolor: 'rgba(244,251,255,.18)' } });

    const pm = new Map();
    for (const d of filtered) { const o = pm.get(d.player) || { n: 0, wr: 0, w: 0, t: 0 }; o.n++; o.wr += d.winRate; o.w += d.standing === 1; o.t += d.top; pm.set(d.player, o); }
    const prow = [...pm.entries()].sort((a, b) => b[1].n - a[1].n || b[1].wr - a[1].wr).slice(0, 10);
    $('#t-players').innerHTML = `<table><thead><tr><th title="Tournament pilot name">Player</th><th class="num" title="Number of decklists entered in selected tournaments">Decks</th><th class="num" title="Number of 1st-place tournament victories">Wins</th><th class="num" title="Number of top-cut playoff appearances">Top cuts</th><th class="num" title="Average tournament match win rate">Avg WR</th></tr></thead><tbody>${
      prow.map(([p, o]) => `<tr><td>${esc(p)}</td><td class="num">${o.n}</td><td class="num">${o.w}</td><td class="num">${o.t}</td><td class="num">${pct(o.wr / o.n, 0)}</td></tr>`).join('')}</tbody></table>`;
    const win = filtered.filter((d) => d.standing === 1).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 10);
    $('#t-winners').innerHTML = `<table><thead><tr><th title="Date of the tournament victory">Date</th><th title="Winning pilot">Player</th><th title="Tournament event name and location">Tournament</th><th class="num" title="Total number of players in the event">Size</th></tr></thead><tbody>${
      win.map((d) => `<tr class="tr-click" data-deck="${esc(d.id)}"><td>${d.date}</td><td>${esc(d.player)}</td><td class="wrap">${esc(d.tname)}</td><td class="num">${d.tsize}</td></tr>`).join('') || '<tr><td colspan="4" class="dim">No winners in selection</td></tr>'}</tbody></table>`;
  }
  const kpi = (l, v, s) => `<div class="glass kpi"><div class="k-label">${l}</div><div class="k-value">${v}</div><div class="k-sub">${s}</div></div>`;

  // ---------- Packages & N-grams (Co-occurrence mining up to N=6) ----------
  function getPackages(deckList) {
    if (!D || !deckList || !deckList.length) return { packages: [], cardPkgMap: new Map() };
    const n = deckList.length;
    if (n < 10) return { packages: [], cardPkgMap: new Map() };

    const cardCounts = new Int32Array(D.cards.length);
    for (const d of deckList) {
      for (const i of d.set) cardCounts[i]++;
    }

    // Filter candidate cards: between 1.5% and 92% inclusion
    const minCount = Math.max(5, Math.round(n * 0.015));
    const maxCount = Math.round(n * 0.92);
    const candidateIdxs = [];
    for (let i = 0; i < D.cards.length; i++) {
      if (cardCounts[i] >= minCount && cardCounts[i] <= maxCount) candidateIdxs.push(i);
    }

    // Pairwise co-occurrence
    const pairCount = new Map();
    for (const d of deckList) {
      const active = [];
      for (const i of candidateIdxs) if (d.set.has(i)) active.push(i);
      for (let a = 0; a < active.length; a++) {
        const ia = active[a];
        for (let b = a + 1; b < active.length; b++) {
          const ib = active[b];
          const k = ia < ib ? ia * 100000 + ib : ib * 100000 + ia;
          pairCount.set(k, (pairCount.get(k) || 0) + 1);
        }
      }
    }

    // Statistically coupled pairs (chi-square >= 9.5, lift >= 1.25, count >= minCount)
    const pairs = [];
    const adj = new Map();
    for (const [k, nab] of pairCount.entries()) {
      if (nab < minCount) continue;
      const ia = Math.floor(k / 100000);
      const ib = k % 100000;
      const na = cardCounts[ia], nb = cardCounts[ib];
      const expected = (na * nb) / n;
      const lift = nab / expected;
      if (lift < 1.25) continue;

      const denom = Math.sqrt(na * (n - na) * nb * (n - nb));
      if (!denom) continue;
      const phi = (n * nab - na * nb) / denom;
      const chi2 = n * phi * phi;
      if (chi2 >= 9.5) {
        pairs.push({ ia, ib, nab, lift, phi });
        if (!adj.has(ia)) adj.set(ia, new Set());
        if (!adj.has(ib)) adj.set(ib, new Set());
        adj.get(ia).add(ib);
        adj.get(ib).add(ia);
      }
    }

    // Mine cliques up to size 6
    let currentCliques = pairs.map((p) => ({ cards: [Math.min(p.ia, p.ib), Math.max(p.ia, p.ib)], count: p.nab, size: 2, lift: p.lift }));
    const allCliques = [...currentCliques];

    for (let sz = 3; sz <= 6; sz++) {
      const nextCliques = [];
      const seen = new Set();
      for (const cq of currentCliques) {
        const cCards = cq.cards;
        const firstAdj = adj.get(cCards[0]);
        if (!firstAdj) continue;
        for (const cand of firstAdj) {
          if (cCards.includes(cand)) continue;
          if (cand < cCards[cCards.length - 1]) continue;

          let ok = true;
          for (let i = 1; i < cCards.length; i++) {
            const cadj = adj.get(cCards[i]);
            if (!cadj || !cadj.has(cand)) { ok = false; break; }
          }
          if (!ok) continue;

          const newCards = [...cCards, cand];
          const key = newCards.join('-');
          if (seen.has(key)) continue;
          seen.add(key);

          let count = 0;
          for (const d of deckList) {
            let hasAll = true;
            for (const ci of newCards) if (!d.set.has(ci)) { hasAll = false; break; }
            if (hasAll) count++;
          }
          if (count >= minCount) {
            let prodProb = 1.0;
            for (const ci of newCards) prodProb *= (cardCounts[ci] / n);
            const expectedDecks = prodProb * n;
            const lift = expectedDecks > 0 ? count / expectedDecks : 1.0;
            const item = { cards: newCards, count, size: sz, lift };
            nextCliques.push(item);
            allCliques.push(item);
          }
        }
      }
      if (!nextCliques.length) break;
      currentCliques = nextCliques;
    }

    // Subsumption check (detect when a smaller sub-package is covered by a larger one)
    allCliques.sort((a, b) => b.size - a.size || b.count - a.count);
    for (let i = 0; i < allCliques.length; i++) {
      const ci = allCliques[i];
      ci.isSub = false;
      for (let j = 0; j < i; j++) {
        const cj = allCliques[j];
        if (cj.size > ci.size && ci.cards.every((c) => cj.cards.includes(c))) {
          if (cj.count >= ci.count * 0.82) {
            ci.isSub = true;
            ci.parentName = cj.cards.map((c) => D.cards[c].name).join(' + ');
            break;
          }
        }
      }
    }

    const packages = [];
    const cardPkgMap = new Map();
    const archetypes = D.archetypes || [];

    for (let id = 0; id < allCliques.length; id++) {
      const rp = allCliques[id];
      const cardNames = rp.cards.map((i) => D.cards[i].name);
      const withDecks = [], withoutDecks = [];
      for (const d of deckList) {
        let hasAll = true;
        for (const ci of rp.cards) if (!d.set.has(ci)) { hasAll = false; break; }
        if (hasAll) withDecks.push(d); else withoutDecks.push(d);
      }
      const nWith = withDecks.length, nWithout = withoutDecks.length;
      if (nWith < 4) continue;

      const wrWith = mean(withDecks.map((d) => d.winRate));
      const wrWithout = nWithout ? mean(withoutDecks.map((d) => d.winRate)) : 0;
      const topWith = withDecks.filter((d) => d.top).length / nWith;
      const topWithout = nWithout ? withoutDecks.filter((d) => d.top).length / nWithout : 0;
      const delta = wrWith - wrWithout;

      let sig = false, z = 0;
      if (nWith >= 15 && nWithout >= 15) {
        const pP = (nWith * wrWith + nWithout * wrWithout) / n;
        const se = Math.sqrt(pP * (1 - pP) * (1 / nWith + 1 / nWithout));
        if (se > 0) { z = Math.abs(delta) / se; sig = z >= 1.96; }
      }

      let domArch = '–';
      if (archetypes.length) {
        const archCounts = new Map();
        for (const d of withDecks) archCounts.set(d.c, (archCounts.get(d.c) || 0) + 1);
        let maxC = 0, bestA = null;
        for (const [aid, c] of archCounts.entries()) if (c > maxC) { maxC = c; bestA = aid; }
        if (bestA !== null && archetypes[bestA]) {
          domArch = `${archetypes[bestA].name} (${(maxC / nWith * 100).toFixed(0)}%)`;
        }
      }

      const pObj = {
        id,
        name: cardNames.join(' + '),
        cards: cardNames,
        cardIdxs: rp.cards,
        size: rp.size,
        isSub: rp.isSub,
        parentName: rp.parentName || '',
        count: nWith,
        share: nWith / n,
        lift: rp.lift,
        wrWith,
        wrWithout,
        delta,
        sig,
        z,
        topWith,
        topWithout,
        domArch,
      };
      packages.push(pObj);

      if (!rp.isSub) {
        for (const ci of rp.cards) {
          if (!cardPkgMap.has(ci)) cardPkgMap.set(ci, []);
          cardPkgMap.get(ci).push(pObj);
        }
      }
    }

    return { packages, cardPkgMap };
  }

  // ---------- Card statistics ----------
  function cardStats(list) {
    const n = list.length;
    const { packages, cardPkgMap } = getPackages(list);
    const cnt = new Float64Array(D.cards.length), wrS = new Float64Array(D.cards.length), topC = new Float64Array(D.cards.length);
    let wrAll = 0, topAll = 0;
    for (const d of list) {
      wrAll += d.winRate; topAll += d.top;
      for (const i of d.set) { cnt[i]++; wrS[i] += d.winRate; topC[i] += d.top; }
    }
    const rows = [];
    for (let i = 0; i < D.cards.length; i++) {
      if (!cnt[i]) continue;
      const n1 = cnt[i];
      const n2 = n - n1;
      const wrWith = wrS[i] / n1;
      const wrWithout = n2 ? (wrAll - wrS[i]) / n2 : NaN;
      const topWith = topC[i] / n1;
      const topWithout = n2 ? (topAll - topC[i]) / n2 : NaN;
      const delta = isNaN(wrWithout) ? NaN : wrWith - wrWithout;

      // Two-proportion z-test (H0: wrWith == wrWithout)
      let sig = false;
      let z = 0;
      if (n1 >= 25 && n2 >= 25 && !isNaN(delta)) {
        const pPooled = (n1 * wrWith + n2 * wrWithout) / n;
        const se = Math.sqrt(pPooled * (1 - pPooled) * (1 / n1 + 1 / n2));
        if (se > 0) {
          z = Math.abs(delta) / se;
          sig = z >= 1.96; // p < 0.05
        }
      }

      const pkgs = cardPkgMap.get(i) || [];
      rows.push({
        i, name: D.cards[i].name, type: cardType[i], cmc: D.cards[i].cmc,
        n: n1, n1, n2, inclusion: n1 / n,
        hasPkg: pkgs.length > 0 ? 1 : 0, pkgs,
        wrWith, wrWithout, topWith, topWithout, delta, sig, z,
      });
    }
    return { rows, n, wrAll, topAll, packages, cardPkgMap };
  }

  const cardState = { q: '', type: 'all', hideStaples: true };
  function renderCards() {
    const el = $('#tab-cards');
    if (!filtered.length) { el.innerHTML = noData(); return; }
    const { rows, cardPkgMap } = cardStats(filtered);
    const types = ['all', ...new Set(rows.map((r) => r.type))].sort((a, b) => (a === 'all' ? -1 : a.localeCompare(b)));
    if (!$('#cards-table')) {
      el.innerHTML = `
        <div class="glass panel">
          <h3>Card statistics</h3>
          <div class="hint">Inclusion, synergistic package coupling, and performance in current selection. “Δ win rate” compares decks with vs. without card; statistically insignificant deltas are marked <span class="insig-tag">insig.</span></div>
          <div class="toolbar">
            <input type="search" id="c-q" placeholder="Search cards…" value="${esc(cardState.q)}">
            <select id="c-type">${types.map((t) => `<option value="${t}">${t === 'all' ? 'All types' : t}</option>`).join('')}</select>
            <label class="chk"><input type="checkbox" id="c-staples" ${cardState.hideStaples ? 'checked' : ''}> Hide staples (≥ 95%)</label>
            <span class="spacer"></span><span class="dim" id="c-count"></span>
          </div>
          <div class="table-wrap"><table id="cards-table"><thead></thead><tbody></tbody></table></div>
          <div class="more" id="c-more"></div>
        </div>`;
      $('#c-q').addEventListener('input', debounce((e) => { cardState.q = e.target.value; limits.cards = 150; renderCards(); }));
      $('#c-type').addEventListener('change', (e) => { cardState.type = e.target.value; limits.cards = 150; renderCards(); });
      $('#c-staples').addEventListener('change', (e) => { cardState.hideStaples = e.target.checked; limits.cards = 150; renderCards(); });
    }
    $('#c-type').value = types.includes(cardState.type) ? cardState.type : 'all';

    const q = cardState.q.toLowerCase();
    let list = rows.filter((r) => (!q || r.name.toLowerCase().includes(q)) && (cardState.type === 'all' || r.type === cardState.type) && (!cardState.hideStaples || r.inclusion < 0.95));
    const { key, dir } = sortState.cards;
    list.sort((a, b) => {
      const x = a[key], y = b[key];
      if (typeof x === 'string') return dir * x.localeCompare(y);
      return dir * ((isNaN(x) ? -Infinity : x) - (isNaN(y) ? -Infinity : y));
    });
    const cols = [
      ['name', 'Card', 0, 'Card name (hover to view card art)'],
      ['type', 'Type', 0, 'Primary card type (Creature, Instant, Sorcery, etc.)'],
      ['inclusion', 'Inclusion', 0, 'Percentage of filtered decks playing this card'],
      ['hasPkg', 'Package', 1, 'Statistically coupled with other cards in an N-gram package (Lift ≥ 1.25×, χ² p < 0.001)'],
      ['n', 'Decks', 1, 'Total number of decks running this card'],
      ['wrWith', 'WR with', 1, 'Average match win rate when this card is included in the deck'],
      ['wrWithout', 'WR without', 1, 'Average match win rate when this card is omitted'],
      ['delta', 'Δ WR', 1, 'Win rate difference (with vs. without). Tagged as insig. if sample < 25 or p ≥ 0.05'],
      ['topWith', 'Top-cut w/', 1, 'Percentage of decks with this card reaching top bracket/cut'],
      ['topWithout', 'Top-cut w/o', 1, 'Percentage of decks without this card reaching top bracket/cut']
    ];
    $('#cards-table thead').innerHTML = '<tr>' + cols.map(([k, l, num, tip]) => `<th data-sort="${k}" title="${esc(tip || l)}" class="${num ? 'num ' : ''}${k === key ? 'sorted' + (dir > 0 ? ' asc' : '') : ''}">${l}</th>`).join('') + '</tr>';
    const shown = list.slice(0, limits.cards);
    const f = (x) => (isNaN(x) ? '–' : pct(x, 1));
    $('#cards-table tbody').innerHTML = shown.map((r) => {
      const low = r.n < 25 ? ' dim' : '';
      let dl;
      if (isNaN(r.delta)) {
        dl = '–';
      } else {
        const sign = r.delta > 0 ? '+' : '';
        const formatted = `${sign}${(r.delta * 100).toFixed(1)}%`;
        if (r.sig) {
          dl = `<span class="${r.delta > 0 ? 'pos' : 'neg'}" title="Statistically significant difference (z = ${r.z.toFixed(2)}, p < 0.05, N = ${r.n1})">${formatted}</span>`;
        } else {
          const reason = r.n1 < 25 ? `n = ${r.n1} < 25 (sample too small)` : (r.n2 < 25 ? `non-inclusions (${r.n2}) < 25` : `z = ${r.z.toFixed(2)} < 1.96, p ≥ 0.05`);
          dl = `<span class="delta-insig dim" title="Statistically insignificant (${reason})">${formatted} <small class="insig-tag">insig.</small></span>`;
        }
      }
      const pkgCell = r.hasPkg
        ? `<span class="pkg-tag" title="Coupled in ${r.pkgs.length} package(s):\n${r.pkgs.map((p) => p.name).join('\n')}">YES</span>`
        : `<span class="pkg-tag none">–</span>`;

      return `<tr><td><span class="cardname" data-card="${esc(r.name)}">${esc(r.name)}</span></td><td class="dim">${r.type}</td>
        <td><div class="bar"><i style="width:${(r.inclusion * 100).toFixed(1)}%"></i><span>${pct(r.inclusion)}</span></div></td>
        <td class="num">${pkgCell}</td>
        <td class="num">${r.n}</td><td class="num${low}">${f(r.wrWith)}</td><td class="num${low}">${f(r.wrWithout)}</td><td class="num">${dl}</td>
        <td class="num${low}">${f(r.topWith)}</td><td class="num${low}">${f(r.topWithout)}</td></tr>`;
    }).join('');
    $('#c-count').textContent = `${list.length} cards`;
    $('#c-more').innerHTML = list.length > shown.length ? `<button class="btn" id="c-more-btn">Show more (${list.length - shown.length} left)</button>` : '';
    const mb = $('#c-more-btn'); if (mb) mb.onclick = () => { limits.cards += 200; renderCards(); };
    $$('#cards-table th').forEach((th) => th.onclick = () => {
      const k = th.dataset.sort; sortState.cards = { key: k, dir: sortState.cards.key === k ? -sortState.cards.dir : (k === 'name' || k === 'type' ? 1 : -1) }; renderCards();
    });
  }

  // ---------- Trends ----------
  function renderTrends() {
    const el = $('#tab-trends');
    if (!filtered.length) { el.innerHTML = noData(); return; }
    const mo = monthly(filtered).filter((m) => m[1].length >= 5);
    if (mo.length < 2) { el.innerHTML = '<div class="glass empty"><h3>Not enough data over time</h3><p>Widen the time period – trends need at least two months with ≥ 5 decks each.</p></div>'; return; }

    // risers / fallers: last 3 months vs. everything before (within selection)
    const months = mo.map((m) => m[0]);
    const recentKeys = new Set(months.slice(-3));
    const recent = filtered.filter((d) => recentKeys.has(d.date.slice(0, 7))), older = filtered.filter((d) => !recentKeys.has(d.date.slice(0, 7)));
    let movers = [];
    if (recent.length >= 10 && older.length >= 10) {
      const a = cardStats(recent).rows, b = new Map(cardStats(older).rows.map((r) => [r.i, r]));
      movers = a.map((r) => ({ name: r.name, r: r.inclusion, o: b.get(r.i) ? b.get(r.i).inclusion : 0, n: r.n + (b.get(r.i) ? b.get(r.i).n : 0) }))
        .concat([...b.values()].filter((r) => !a.find((x) => x.i === r.i)).map((r) => ({ name: r.name, r: 0, o: r.inclusion, n: r.n })))
        .filter((m) => m.n >= 15).map((m) => Object.assign(m, { d: m.r - m.o }));
    }
    const risers = [...movers].sort((x, y) => y.d - x.d).slice(0, 12), fallers = [...movers].sort((x, y) => x.d - y.d).slice(0, 12);
    if (!trendCards) trendCards = [...risers.slice(0, 3), ...fallers.slice(0, 3)].map((m) => m.name);

    const mtable = (arr) => `<table><thead><tr><th title="Card name (hover to view card art)">Card</th><th class="num" title="Inclusion rate prior to the last 3 months">Before</th><th class="num" title="Inclusion rate over the most recent 3 months">Last 3 mo.</th><th class="num" title="Percentage point change in inclusion (Recent - Before)">Δ</th></tr></thead><tbody>${
      arr.map((m) => `<tr><td><span class="cardname" data-card="${esc(m.name)}">${esc(m.name)}</span></td><td class="num dim">${pct(m.o, 0)}</td><td class="num">${pct(m.r, 0)}</td><td class="num ${m.d > 0 ? 'pos' : 'neg'}">${m.d > 0 ? '+' : ''}${(m.d * 100).toFixed(0)} pp</td></tr>`).join('')}</tbody></table>`;

    el.innerHTML = `
      <div class="glass panel" style="margin-bottom:16px">
        <h3>Card inclusion over time</h3><div class="hint">Share of decks playing each card per month (months with ≥ 5 decks). Add cards below.</div>
        <div class="toolbar"><input type="text" id="t-add" list="card-list" placeholder="Add a card to the chart…"><button class="btn" id="t-reset">Auto-pick movers</button></div>
        <div class="chips" id="t-chips" style="margin:0 0 8px"></div>
        <div id="p-trend" class="plot tall"></div>
      </div>
      <div class="two-tables">
        <div class="glass panel"><h3>Rising cards</h3><div class="hint">Inclusion in last 3 months vs. before</div>${movers.length ? mtable(risers) : '<span class="dim">Not enough data</span>'}</div>
        <div class="glass panel"><h3>Falling cards</h3><div class="hint">Inclusion in last 3 months vs. before</div>${movers.length ? mtable(fallers) : '<span class="dim">Not enough data</span>'}</div>
      </div>
      <div class="grid2">
        <div class="glass panel"><h3>Average land count</h3><div class="hint">Lands per deck (incl. fetches, duals, utility)</div><div id="p-lands" class="plot"></div></div>
        <div class="glass panel"><h3>Average mana value (nonland)</h3><div class="hint">Lower = faster, more ritual-based decks</div><div id="p-cmc" class="plot"></div></div>
      </div>`;

    const drawChips = () => {
      $('#t-chips').innerHTML = trendCards.map((n, i) => `<span class="chip" style="border-color:${PALETTE[i % 8]}88;background:${PALETTE[i % 8]}22"><span class="cardname" data-card="${esc(n)}">${esc(n)}</span><button data-trm="${i}">×</button></span>`).join('');
    };
    const drawTrend = () => {
      drawChips();
      const traces = trendCards.map((name, k) => {
        const ci = cardIdx(name);
        return { type: 'scatter', mode: 'lines+markers', name, x: mo.map((m) => m[0]), y: mo.map((m) => (m[1].filter((d) => d.set.has(ci)).length / m[1].length) * 100),
          line: { width: 2.5, color: PALETTE[k % 8], dash: ['solid', 'dash', 'dot', 'dashdot', 'solid', 'dash', 'dot', 'dashdot'][k % 8] }, marker: sq(PALETTE[k % 8]), hovertemplate: `${esc(name)}: %{y:.0f}%<extra></extra>` };
      });
      plot('p-trend', traces, { yaxis: { ticksuffix: '%', range: [0, 100], gridcolor: 'rgba(244,251,255,.18)' }, legend: { orientation: 'h', y: -0.15 } });
    };
    drawTrend();
    $('#t-add').addEventListener('change', (e) => { const i = cardIdx(e.target.value.trim()); if (i >= 0 && !trendCards.includes(D.cards[i].name)) { trendCards.push(D.cards[i].name); drawTrend(); } e.target.value = ''; });
    $('#t-reset').addEventListener('click', () => { trendCards = null; renderTrends(); });
    $('#t-chips').addEventListener('click', (e) => { const b = e.target.closest('[data-trm]'); if (b) { trendCards.splice(+b.dataset.trm, 1); drawTrend(); } });

    plot('p-lands', [{ type: 'scatter', mode: 'lines+markers', x: months, y: mo.map((m) => mean(m[1].map((d) => d.lands))), line: { color: '#c4ff8a', width: 2.5 }, marker: sq('#c4ff8a'), hovertemplate: '%{y:.1f} lands<extra></extra>' }], { yaxis: { gridcolor: 'rgba(244,251,255,.18)' } });
    plot('p-cmc', [{ type: 'scatter', mode: 'lines+markers', x: months, y: mo.map((m) => mean(m[1].map((d) => d.avgCmc))), line: { color: '#ffab94', width: 2.5 }, marker: sq('#ffab94'), hovertemplate: '%{y:.2f}<extra></extra>' }], { yaxis: { gridcolor: 'rgba(244,251,255,.18)' } });
  }

  // ---------- Decks ----------
  function renderDecks() {
    const el = $('#tab-decks');
    if (!filtered.length) { el.innerHTML = noData(); return; }
    if (!$('#decks-table')) {
      el.innerHTML = `<div class="glass panel"><h3>Decklists</h3><div class="hint">Click a row to open the deck. Win rate = swiss + bracket games.</div>
        <div class="toolbar"><span class="dim" id="d-count"></span></div>
        <div class="table-wrap"><table id="decks-table"><thead></thead><tbody></tbody></table></div><div class="more" id="d-more"></div></div>`;
    }
    const { key, dir } = sortState.decks;
    const list = [...filtered].sort((a, b) => {
      const x = a[key], y = b[key];
      return dir * (typeof x === 'string' ? x.localeCompare(y) : x - y) || (a.date < b.date ? 1 : -1);
    });
    const cols = [
      ['date', 'Date', 0, 'Tournament date (YYYY-MM-DD)'],
      ['player', 'Player', 0, 'Pilot / player name'],
      ['tname', 'Tournament', 0, 'Tournament / event name'],
      ['tsize', 'Size', 1, 'Total player attendance in tournament'],
      ['standing', 'Finish', 0, 'Final tournament standing / bracket cut (1st, Top 4, Top 16, etc.)'],
      ['winRate', 'Win rate', 1, 'Overall tournament match win rate (wins / total rounds)'],
      ['w', 'W-L-D', 0, 'Match record: Wins - Losses - Draws'],
      ['lands', 'Lands', 1, 'Total number of lands in the 99'],
      ['avgCmc', 'Avg MV', 1, 'Average mana value of non-land cards (lower = faster curve)']
    ];
    $('#decks-table thead').innerHTML = '<tr>' + cols.map(([k, l, num, tip]) => `<th data-sort="${k}" title="${esc(tip || l)}" class="${num ? 'num ' : ''}${k === key ? 'sorted' + (dir > 0 ? ' asc' : '') : ''}">${l}</th>`).join('') + '</tr>';
    const shown = list.slice(0, limits.decks);
    $('#decks-table tbody').innerHTML = shown.map((d) => `<tr class="tr-click" data-deck="${esc(d.id)}"><td>${d.date}</td><td>${esc(d.player)}</td><td class="wrap">${esc(d.tname)}</td>
      <td class="num">${d.tsize}</td><td>${standingBadge(d.standing, d.top)}</td><td class="num">${pct(d.winRate, 0)}</td><td>${d.w}-${d.l}-${d.d}</td>
      <td class="num">${d.lands}</td><td class="num">${d.avgCmc.toFixed(2)}</td></tr>`).join('');
    $('#d-count').textContent = `${list.length.toLocaleString()} decks`;
    $('#d-more').innerHTML = list.length > shown.length ? `<button class="btn" id="d-more-btn">Show more (${list.length - shown.length} left)</button>` : '';
    const mb = $('#d-more-btn'); if (mb) mb.onclick = () => { limits.decks += 200; renderDecks(); };
    $$('#decks-table th').forEach((th) => th.onclick = () => {
      const k = th.dataset.sort; sortState.decks = { key: k, dir: sortState.decks.key === k ? -sortState.decks.dir : (k === 'player' || k === 'tname' ? 1 : -1) }; renderDecks();
    });
  }

  // ---------- Archetypes ----------
  const archState = { selected: null, colorBy: 'archetype', viewMode: 'dim' };

  function renderArchetypes() {
    const el = $('#tab-archetypes');
    if (!filtered.length) { el.innerHTML = noData(); return; }

    const archetypes = D.archetypes || [];
    if (!archetypes.length || decks[0]?.x === undefined) {
      el.innerHTML = `
        <div class="glass empty">
          <h3>Archetype Clusters Not Ready</h3>
          <p>Run <code>python3 crawler/cluster.py "${esc(slug)}"</code> to generate clusters and 2D coordinates for this commander.</p>
        </div>`;
      return;
    }

    const filteredSet = new Set(filtered.map((d) => d.id));
    const archCounts = new Map();
    filtered.forEach((d) => {
      const c = d.c !== undefined ? d.c : 0;
      archCounts.set(c, (archCounts.get(c) || 0) + 1);
    });

    const isAll = archState.selected === null;

    el.innerHTML = `
      <div class="glass panel" style="margin-bottom:24px">
        <div style="display:flex; justify-content:space-between; align-items:baseline; flex-wrap:wrap; gap:12px; margin-bottom:8px">
          <div>
            <h3>Archetype Point Cloud (2D Manifold)</h3>
            <div class="hint">Vector embeddings based on card composition projected via t-SNE. Decks closer together share similar packages. Click any point to open the decklist.</div>
          </div>
          <div class="toolbar" style="margin-bottom:0">
            <label style="font-size:12px; color:var(--ink-dim)">COLOR:
              <select id="a-colorby" style="width:auto; margin-left:6px">
                <option value="archetype" ${archState.colorBy === 'archetype' ? 'selected' : ''}>Archetype</option>
                <option value="winrate" ${archState.colorBy === 'winrate' ? 'selected' : ''}>Win Rate</option>
                <option value="finish" ${archState.colorBy === 'finish' ? 'selected' : ''}>Finish (Standing)</option>
              </select>
            </label>
            <label style="font-size:12px; color:var(--ink-dim); margin-left:8px">UNFILTERED:
              <select id="a-viewmode" style="width:auto; margin-left:6px">
                <option value="dim" ${archState.viewMode === 'dim' ? 'selected' : ''}>Show Dimmed</option>
                <option value="hide" ${archState.viewMode === 'hide' ? 'selected' : ''}>Hide</option>
              </select>
            </label>
            ${!isAll ? '<button class="btn" id="a-clear-filter" style="font-size:11.5px; padding:4px 10px; margin-left:8px">Show All</button>' : ''}
          </div>
        </div>
        <div id="p-arch-scatter" class="plot tall" style="height:540px"></div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px; font-size:11.5px; color:var(--ink-dim); flex-wrap:wrap; gap:8px">
          <div>★ 1st Place &nbsp;·&nbsp; ◆ Top Cut &nbsp;·&nbsp; ● Swiss Finish</div>
          <div style="font-family:var(--f-hand); color:var(--yellow)">Tip: Click any deck dot to inspect its decklist</div>
        </div>
      </div>

      <div style="margin-bottom:12px; display:flex; justify-content:space-between; align-items:baseline">
        <h3 style="font-size:24px">Archetype Profiles</h3>
        <span class="hint" style="margin:0">${archetypes.length} clusters identified · Click an archetype card to focus</span>
      </div>

      <div class="arch-grid" id="arch-cards-container">
        ${archetypes.map((a) => {
          const count = archCounts.get(a.id) || 0;
          const pctFiltered = filtered.length ? (count / filtered.length) * 100 : 0;
          const isSelected = archState.selected === a.id;
          const color = PALETTE[a.id % PALETTE.length];
          const wr = a.winRate ? (a.winRate * 100).toFixed(1) + '%' : '–';

          return `
            <div class="arch-card ${isSelected ? 'selected' : ''}" data-arch="${a.id}">
              <div class="arch-header">
                <div class="arch-title">
                  <span class="arch-dot" style="background:${color}"></span>
                  <span>${esc(a.name)}</span>
                </div>
                <span class="badge ${isSelected ? 'gold' : ''}" style="font-size:11px">${count} decks</span>
              </div>
              <div class="arch-stats">
                <span>Filtered: <b>${count}</b> (${pctFiltered.toFixed(1)}%)</span>
                <span>Base WR: <b>${wr}</b></span>
                <span>Total: <b>${a.count}</b></span>
              </div>
              <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:var(--ink-dim); margin-top:6px">Signature Cards:</div>
              <div class="arch-sigs">
                ${(a.signatures || []).slice(0, 5).map((s) => `
                  <span class="arch-sig-badge cardname" data-card="${esc(s.card)}">
                    ${esc(s.card)} <b>+${(s.diff * 100).toFixed(0)}%</b>
                  </span>
                `).join('')}
              </div>
            </div>
          `;
        }).join('')}
      </div>

      <div class="grid2">
        <div class="glass panel">
          <h3>Archetype Share Over Time</h3>
          <div class="hint">Monthly distribution of archetypes (% share)</div>
          <div id="p-arch-time" class="plot"></div>
        </div>
        <div class="glass panel">
          <h3>${isAll ? 'Signature Cards Across Archetypes' : `Signature Cards: ${esc(archetypes[archState.selected]?.name || '')}`}</h3>
          <div class="hint">${isAll ? 'Top differential cards defining each cluster' : 'Specific card inclusions that separate this archetype from the rest'}</div>
          <div id="t-arch-details"></div>
        </div>
      </div>
    `;

    $('#a-colorby').onchange = (e) => { archState.colorBy = e.target.value; drawScatter(); };
    $('#a-viewmode').onchange = (e) => { archState.viewMode = e.target.value; drawScatter(); };
    const clearBtn = $('#a-clear-filter');
    if (clearBtn) clearBtn.onclick = () => { archState.selected = null; renderArchetypes(); };

    $$('.arch-card').forEach((card) => {
      card.onclick = (e) => {
        if (e.target.closest('[data-card]')) return;
        const aid = +card.dataset.arch;
        archState.selected = (archState.selected === aid) ? null : aid;
        renderArchetypes();
      };
    });

    drawScatter();
    drawArchetypeTimeline();
    drawArchetypeDetails();
  }

  function drawScatter() {
    const el = document.getElementById('p-arch-scatter');
    if (!el || !D.archetypes) return;

    const archetypes = D.archetypes;
    const filteredSet = new Set(filtered.map((d) => d.id));
    const traces = [];

    // Background unfiltered trace (dimmed) if viewMode === 'dim'
    if (archState.viewMode === 'dim') {
      const dimDecks = decks.filter((d) => !filteredSet.has(d.id));
      if (dimDecks.length > 0) {
        traces.push({
          type: 'scattergl',
          mode: 'markers',
          name: 'Unfiltered Decks',
          x: dimDecks.map((d) => d.x),
          y: dimDecks.map((d) => d.y),
          customdata: dimDecks.map((d) => d.id),
          hoverinfo: 'text',
          hovertext: dimDecks.map((d) => `${esc(d.player)} (${d.date})<br>${esc(d.tname)}<br>Standing: ${ord(d.standing)} · WR: ${(d.winRate * 100).toFixed(0)}%<br>Archetype: ${esc(archetypes[d.c]?.name || '')}`),
          marker: {
            size: 5,
            opacity: 0.12,
            color: 'rgba(244,251,255,0.2)',
            symbol: 'circle',
          },
          showlegend: false,
        });
      }
    }

    // Active filtered decks
    const activeDecks = filtered;
    if (archState.colorBy === 'archetype') {
      archetypes.forEach((arch) => {
        const archDecks = activeDecks.filter((d) => d.c === arch.id);
        if (!archDecks.length) return;

        const isHighlighted = archState.selected === null || archState.selected === arch.id;
        const archColor = PALETTE[arch.id % PALETTE.length];

        const symbols = archDecks.map((d) => (d.standing === 1 ? 'star' : (d.top ? 'square' : 'circle')));
        const sizes = archDecks.map((d) => (d.standing === 1 ? 14 : (d.top ? 9.5 : 7.5)));

        traces.push({
          type: 'scattergl',
          mode: 'markers',
          name: arch.name,
          x: archDecks.map((d) => d.x),
          y: archDecks.map((d) => d.y),
          customdata: archDecks.map((d) => d.id),
          hoverinfo: 'text',
          hovertext: archDecks.map((d) => `<b>${esc(d.player)}</b> (${d.date})<br>${esc(d.tname)}<br>Finish: <b>${ord(d.standing)}</b> (${d.w}-${d.l}-${d.d})<br>Win Rate: <b>${(d.winRate * 100).toFixed(0)}%</b><br>Archetype: <i>${esc(arch.name)}</i>`),
          marker: {
            size: sizes,
            symbol: symbols,
            color: archColor,
            opacity: isHighlighted ? 0.96 : 0.12,
            line: { width: 1.4, color: isHighlighted ? '#031c36' : 'transparent' },
          },
        });
      });
    } else if (archState.colorBy === 'winrate') {
      const symbols = activeDecks.map((d) => (d.standing === 1 ? 'star' : (d.top ? 'square' : 'circle')));
      const sizes = activeDecks.map((d) => (d.standing === 1 ? 14 : (d.top ? 9.5 : 7.5)));

      traces.push({
        type: 'scattergl',
        mode: 'markers',
        name: 'Decks by Win Rate',
        x: activeDecks.map((d) => d.x),
        y: activeDecks.map((d) => d.y),
        customdata: activeDecks.map((d) => d.id),
        hoverinfo: 'text',
        hovertext: activeDecks.map((d) => `<b>${esc(d.player)}</b> (${d.date})<br>${esc(d.tname)}<br>Finish: <b>${ord(d.standing)}</b><br>Win Rate: <b>${(d.winRate * 100).toFixed(0)}%</b>`),
        marker: {
          size: sizes,
          symbol: symbols,
          color: activeDecks.map((d) => d.winRate * 100),
          colorscale: [[0, '#ff385c'], [0.35, '#ff9100'], [0.65, '#ffd600'], [1, '#39ff14']],
          colorbar: { title: 'Win %', ticksuffix: '%', len: 0.7, thickness: 14, outlinecolor: '#f4fbff' },
          opacity: 0.92,
          line: { width: 1.2, color: '#031c36' },
        },
      });
    } else { // finish
      const symbols = activeDecks.map((d) => (d.standing === 1 ? 'star' : (d.top ? 'square' : 'circle')));
      const sizes = activeDecks.map((d) => (d.standing === 1 ? 14 : (d.top ? 9.5 : 7.5)));

      traces.push({
        type: 'scattergl',
        mode: 'markers',
        name: 'Decks by Standing',
        x: activeDecks.map((d) => d.x),
        y: activeDecks.map((d) => d.y),
        customdata: activeDecks.map((d) => d.id),
        hoverinfo: 'text',
        hovertext: activeDecks.map((d) => `<b>${esc(d.player)}</b><br>${esc(d.tname)}<br>Finish: <b>${ord(d.standing)}</b>`),
        marker: {
          size: sizes,
          symbol: symbols,
          color: activeDecks.map((d) => d.standing),
          colorscale: [[0, '#ffd600'], [0.15, '#39ff14'], [0.45, '#00f0ff'], [1, '#0e2a47']],
          cmin: 1,
          cmax: 32,
          colorbar: { title: 'Rank', len: 0.7, thickness: 14, outlinecolor: '#f4fbff' },
          opacity: 0.92,
          line: { width: 1.2, color: '#031c36' },
        },
      });
    }

    const layout = plotLayout({
      margin: { l: 30, r: 20, t: 20, b: 30 },
      xaxis: { showticklabels: false, zeroline: false },
      yaxis: { showticklabels: false, zeroline: false },
      legend: { orientation: 'h', y: -0.05, font: { size: 11 } },
      hovermode: 'closest',
    });

    Plotly.react(el, traces, layout, plotCfg);

    if (!el._clickBound) {
      el._clickBound = true;
      el.on('plotly_click', (data) => {
        if (data && data.points && data.points[0] && data.points[0].customdata) {
          openDeck(data.points[0].customdata);
        }
      });
    }
  }

  function drawArchetypeTimeline() {
    const el = document.getElementById('p-arch-time');
    if (!el || !D.archetypes) return;

    const archetypes = D.archetypes;
    const mo = monthly(filtered).filter((m) => m[1].length >= 4);
    if (mo.length < 2) {
      el.innerHTML = '<div class="empty" style="padding:20px">Not enough monthly data for timeline</div>';
      return;
    }

    const months = mo.map((m) => m[0]);
    const traces = archetypes.map((arch, k) => {
      const shares = mo.map((m) => {
        const total = m[1].length;
        const matching = m[1].filter((d) => d.c === arch.id).length;
        return total ? (matching / total) * 100 : 0;
      });
      return {
        type: 'scatter',
        mode: 'lines+markers',
        name: arch.name,
        x: months,
        y: shares,
        line: { width: 2, color: PALETTE[k % PALETTE.length], dash: ['solid', 'dash', 'dot', 'dashdot', 'solid', 'dash'][k % 6] },
        marker: sq(PALETTE[k % PALETTE.length]),
        hovertemplate: `${esc(arch.name)}: %{y:.1f}%<extra></extra>`,
      };
    });

    plot('p-arch-time', traces, {
      yaxis: { ticksuffix: '%', range: [0, 100], gridcolor: 'rgba(244,251,255,.18)' },
      legend: { orientation: 'h', y: -0.18, font: { size: 10 } },
    });
  }

  function drawArchetypeDetails() {
    const el = document.getElementById('t-arch-details');
    if (!el || !D.archetypes) return;

    const archetypes = D.archetypes;
    const isSelected = archState.selected !== null && archetypes[archState.selected];

    if (isSelected) {
      const a = archetypes[archState.selected];
      const sigs = a.signatures || [];
      const { packages } = getPackages(filtered);
      const archDecks = filtered.filter((d) => d.c === a.id);
      const archPkgs = packages.filter((p) => {
        if (!archDecks.length) return false;
        const countInArch = archDecks.filter((d) => {
          for (const ci of p.cardIdxs) if (!d.set.has(ci)) return false;
          return true;
        }).length;
        return (countInArch / archDecks.length) >= 0.20;
      });

      el.innerHTML = `
        <div class="table-wrap" style="max-height:360px">
          <table class="arch-sig-table">
            <thead>
              <tr>
                <th class="col-card" title="Distinctive card that characterizes this archetype">Signature Card</th>
                <th class="col-type" title="Primary card type">Type</th>
                <th class="num" title="Inclusion rate within this archetype">In Archetype</th>
                <th class="num" title="Inclusion rate across all other archetypes of this commander">In Others</th>
                <th class="num" title="Difference in inclusion rate (+X percentage points more frequent here)">Differential</th>
              </tr>
            </thead>
            <tbody>
              ${sigs.map((s) => `
                <tr>
                  <td class="col-card"><span class="cardname" data-card="${esc(s.card)}">${esc(s.card)}</span></td>
                  <td class="col-type dim" title="${esc(s.type || '')}">${esc(s.type || '')}</td>
                  <td class="num">${pct(s.inCluster, 0)}</td>
                  <td class="num dim">${pct(s.outCluster, 0)}</td>
                  <td class="num pos">+${pct(s.diff, 0)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        ${archPkgs.length ? `
          <div style="margin-top:14px; padding-top:10px; border-top:1px dashed var(--line-soft)">
            <div style="font-size:12px; color:var(--yellow); font-family:var(--f-head); letter-spacing:.05em; margin-bottom:6px">ASSOCIATED PACKAGES &amp; N-GRAMS</div>
            <div style="display:flex; flex-wrap:wrap; gap:8px">
              ${archPkgs.map((p) => `
                <div class="chip" style="border-color:var(--lime); background:rgba(57,255,20,0.08); font-size:12px">
                  <span class="cardname">${esc(p.name)}</span>
                  <span class="badge cut" style="margin-left:4px; font-size:10px">${p.cards.length}-gram</span>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}
      `;
    } else {
      el.innerHTML = `
        <div class="table-wrap">
          <table class="arch-sig-table">
            <thead>
              <tr>
                <th title="Clustered deck archetype name">Archetype</th>
                <th class="num" title="Percentage share among all decks of this commander">Share</th>
                <th class="num" title="Average tournament win rate for decks in this cluster">Win Rate</th>
                <th class="col-card" title="Card with highest differential inclusion identifying this archetype">Top Defining Signature Card</th>
              </tr>
            </thead>
            <tbody>
              ${archetypes.map((a, k) => {
                const topSig = (a.signatures && a.signatures[0]) ? a.signatures[0] : null;
                const color = PALETTE[k % PALETTE.length];
                return `
                  <tr class="tr-click" data-arch-row="${a.id}">
                    <td><span class="arch-dot" style="background:${color}; vertical-align:middle; margin-right:6px"></span>${esc(a.name)}</td>
                    <td class="num">${pct(a.share || 0, 1)}</td>
                    <td class="num">${a.winRate ? pct(a.winRate, 1) : '–'}</td>
                    <td class="col-card">${topSig ? `<span class="cardname" data-card="${esc(topSig.card)}">${esc(topSig.card)}</span> <span class="pos">(+${pct(topSig.diff, 0)})</span>` : 'Core Staples'}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      `;
      $$('#t-arch-details tr[data-arch-row]').forEach((tr) => {
        tr.onclick = () => {
          archState.selected = +tr.dataset.archRow;
          renderArchetypes();
        };
      });
    }
  }

  // ---------- Archetype Trends Tab ----------
  function renderArchetypeTrends() {
    const el = $('#tab-archetype-trends');
    if (!filtered.length || !D.archetypes || !D.archetypes.length) {
      el.innerHTML = '<div class="glass empty"><h3>No archetype data available</h3><p>Archetype trends require clustered data.</p></div>';
      return;
    }

    const archetypes = D.archetypes;
    const mo = monthly(filtered).filter((m) => m[1].length >= 4);
    if (mo.length < 2) {
      el.innerHTML = '<div class="glass empty"><h3>Not enough historical data</h3><p>Widen the date filters on the left to see archetype trends across time.</p></div>';
      return;
    }

    const months = mo.map((m) => m[0]);
    const timeline = months.map((m) => {
      const dlist = filtered.filter((d) => d.date.startsWith(m));
      const total = dlist.length;
      const shares = {};
      const winrates = {};
      const topcuts = {};
      archetypes.forEach((a) => {
        const ad = dlist.filter((d) => d.c === a.id);
        shares[a.id] = total ? (ad.length / total) * 100 : 0;
        winrates[a.id] = ad.length ? mean(ad.map((d) => d.winRate)) * 100 : 0;
        topcuts[a.id] = ad.length ? (ad.filter((d) => d.top).length / ad.length) * 100 : 0;
      });
      return { month: m, shares, winrates, topcuts, total };
    });

    // Recent 3 months vs prior for trend calculation
    const recentKeys = new Set(months.slice(-3));
    const recentDecks = filtered.filter((d) => recentKeys.has(d.date.slice(0, 7)));
    const olderDecks = filtered.filter((d) => !recentKeys.has(d.date.slice(0, 7)));

    const summaryRows = archetypes.map((a, k) => {
      const allA = filtered.filter((d) => d.c === a.id);
      const recA = recentDecks.filter((d) => d.c === a.id);
      const oldA = olderDecks.filter((d) => d.c === a.id);

      const allShare = filtered.length ? allA.length / filtered.length : 0;
      const recShare = recentDecks.length ? recA.length / recentDecks.length : 0;
      const oldShare = olderDecks.length ? oldA.length / olderDecks.length : 0;
      const shareDelta = recShare - oldShare;

      const allWr = allA.length ? mean(allA.map((d) => d.winRate)) : 0;
      const recWr = recA.length ? mean(recA.map((d) => d.winRate)) : 0;
      const wrDelta = recWr - allWr;

      const topCutRate = allA.length ? allA.filter((d) => d.top).length / allA.length : 0;

      return {
        a, k, count: allA.length, allShare, recShare, shareDelta,
        allWr, recWr, wrDelta, topCutRate
      };
    });

    el.innerHTML = `
      <div class="glass panel" style="margin-bottom:24px">
        <h3>Archetype Meta Share Over Time</h3>
        <div class="hint">Percentage of decks running each archetype per month</div>
        <div id="p-arch-meta-share" class="plot tall" style="height:360px"></div>
      </div>
      <div class="grid2">
        <div class="glass panel">
          <h3>Archetype Win Rate Over Time</h3>
          <div class="hint">Monthly average win rate across tournaments</div>
          <div id="p-arch-wr-timeline" class="plot"></div>
        </div>
        <div class="glass panel">
          <h3>Archetype Top-Cut Conversion</h3>
          <div class="hint">Share of decks reaching top-cut brackets per month</div>
          <div id="p-arch-topcut-timeline" class="plot"></div>
        </div>
      </div>
      <div class="glass panel" style="margin-top:24px">
        <h3>Archetype Momentum &amp; Comparative Performance</h3>
        <div class="hint">Comparing recent 3-month momentum vs all-time baseline</div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th title="Clustered deck archetype name">Archetype</th>
                <th class="num" title="Total number of tournament decklists in this cluster">Decks</th>
                <th class="num" title="All-time percentage share among this commander's decks">Overall Share</th>
                <th class="num" title="Percentage share over the most recent 3 months">Recent 3M Share</th>
                <th class="num" title="Percentage point shift in meta share (Recent 3M vs Baseline)">Share Trend</th>
                <th class="num" title="All-time average match win rate">Overall Win Rate</th>
                <th class="num" title="Average match win rate over the most recent 3 months">Recent 3M Win Rate</th>
                <th class="num" title="Percentage of decks reaching tournament top bracket / cut">Top Cut Rate</th>
              </tr>
            </thead>
            <tbody>
              ${summaryRows.map((r) => {
                const color = PALETTE[r.k % PALETTE.length];
                const trClass = r.shareDelta >= 0.02 ? 'up' : (r.shareDelta <= -0.02 ? 'down' : '');
                const trPill = r.shareDelta !== 0
                  ? `<span class="trend-pill ${trClass}">${r.shareDelta > 0 ? '+' : ''}${(r.shareDelta * 100).toFixed(1)} pp</span>`
                  : '–';
                return `
                  <tr>
                    <td><span class="arch-dot" style="background:${color}; vertical-align:middle; margin-right:6px"></span><b>${esc(r.a.name)}</b></td>
                    <td class="num">${r.count}</td>
                    <td class="num">${pct(r.allShare, 1)}</td>
                    <td class="num">${pct(r.recShare, 1)}</td>
                    <td class="num">${trPill}</td>
                    <td class="num">${pct(r.allWr, 1)}</td>
                    <td class="num">${pct(r.recWr, 1)}</td>
                    <td class="num">${pct(r.topCutRate, 1)}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;

    const tracesShare = archetypes.map((a, k) => ({
      type: 'scatter',
      mode: 'lines+markers',
      name: a.name,
      x: timeline.map((d) => d.month),
      y: timeline.map((d) => d.shares[a.id]),
      line: { width: 2.5, color: PALETTE[k % PALETTE.length], dash: ['solid', 'dash', 'dot', 'dashdot', 'solid', 'dash'][k % 6] },
      marker: sq(PALETTE[k % PALETTE.length]),
      hovertemplate: `${esc(a.name)}: %{y:.1f}%<extra></extra>`,
    }));
    plot('p-arch-meta-share', tracesShare, { yaxis: { ticksuffix: '%', title: 'Meta Share' } });

    const tracesWr = archetypes.map((a, k) => ({
      type: 'scatter',
      mode: 'lines+markers',
      name: a.name,
      x: timeline.map((d) => d.month),
      y: timeline.map((d) => d.winrates[a.id]),
      line: { width: 2, color: PALETTE[k % PALETTE.length] },
      marker: sq(PALETTE[k % PALETTE.length]),
      hovertemplate: `${esc(a.name)}: %{y:.1f}%<extra></extra>`,
    }));
    plot('p-arch-wr-timeline', tracesWr, { yaxis: { ticksuffix: '%', title: 'Win Rate' } });

    const tracesTop = archetypes.map((a, k) => ({
      type: 'scatter',
      mode: 'lines+markers',
      name: a.name,
      x: timeline.map((d) => d.month),
      y: timeline.map((d) => d.topcuts[a.id]),
      line: { width: 2, color: PALETTE[k % PALETTE.length] },
      marker: sq(PALETTE[k % PALETTE.length]),
      hovertemplate: `${esc(a.name)}: %{y:.1f}%<extra></extra>`,
    }));
    plot('p-arch-topcut-timeline', tracesTop, { yaxis: { ticksuffix: '%', title: 'Top-Cut %' } });
  }

  // ---------- Packages & N-Grams Tab ----------
  const pkgState = { q: '', size: 'all', hideSub: true, sort: 'count', dir: -1 };
  function renderPackages() {
    const el = $('#tab-packages');
    if (!filtered.length) { el.innerHTML = noData(); return; }

    const { packages } = getPackages(filtered);
    if (!packages.length) {
      el.innerHTML = '<div class="glass empty"><h3>No statistically coupled packages found</h3><p>Try widening your filters to increase sample size for co-occurrence detection.</p></div>';
      return;
    }

    const n = filtered.length;
    const topWrPkg = [...packages].sort((a, b) => b.wrWith - a.wrWith)[0];
    const topDecksPkg = [...packages].sort((a, b) => b.count - a.count)[0];
    const highestLiftPkg = [...packages].sort((a, b) => (b.lift || 0) - (a.lift || 0))[0];

    const q = (pkgState.q || '').toLowerCase();
    let list = packages.filter((p) => {
      if (pkgState.hideSub && p.isSub) return false;
      if (pkgState.size !== 'all' && p.size !== +pkgState.size) return false;
      if (q && !p.name.toLowerCase().includes(q)) return false;
      return true;
    });

    const { sort: sKey, dir: sDir } = pkgState;
    list.sort((a, b) => {
      const x = a[sKey], y = b[sKey];
      if (typeof x === 'string') return sDir * x.localeCompare(y);
      return sDir * ((isNaN(x) ? -Infinity : x) - (isNaN(y) ? -Infinity : y));
    });

    el.innerHTML = `
      <div class="kpis">
        ${kpi('Detected Packages', packages.length, 'statistically coupled N-grams (N=2..6)')}
        ${kpi('Most Popular', topDecksPkg.name.split(' + ')[0] + '…', `${topDecksPkg.count} decks (${pct(topDecksPkg.share, 0)})`)}
        ${kpi('Top Win Rate', topWrPkg.name.split(' + ')[0] + '…', `${pct(topWrPkg.wrWith, 1)} WR (${topWrPkg.count} decks)`)}
        ${kpi('Max Lift Ratio', `${highestLiftPkg.lift ? highestLiftPkg.lift.toFixed(1) + '×' : '–'}`, 'coupling over expectation')}
      </div>

      <div class="glass panel" style="margin-bottom:24px">
        <h3>Card Packages &amp; Co-Occurrence N-Grams</h3>
        <div class="hint">Synergistic card clusters that appear together significantly more than random chance (χ² p &lt; 0.001, Lift &gt; 1.25×). Sub-packages can be collapsed into their superset engines.</div>
        <div class="toolbar" style="flex-wrap:wrap; gap:12px; align-items:center">
          <input type="search" id="pkg-search" placeholder="Search cards in packages…" value="${esc(pkgState.q)}" style="min-width:200px">
          
          <label style="display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--ink-dim)">
            SIZE N:
            <select id="pkg-size" style="width:auto">
              <option value="all" ${pkgState.size === 'all' ? 'selected' : ''}>All sizes (N=2–6)</option>
              <option value="2" ${pkgState.size === '2' ? 'selected' : ''}>N = 2 (Synergy Pairs)</option>
              <option value="3" ${pkgState.size === '3' ? 'selected' : ''}>N = 3 (Triples)</option>
              <option value="4" ${pkgState.size === '4' ? 'selected' : ''}>N = 4 (Core Engines)</option>
              <option value="5" ${pkgState.size === '5' ? 'selected' : ''}>N = 5 (5-Card Lines)</option>
              <option value="6" ${pkgState.size === '6' ? 'selected' : ''}>N = 6 (6-Card Suites)</option>
            </select>
          </label>

          <label style="display:inline-flex; align-items:center; gap:8px; font-size:12px; color:var(--ink-dim)">
            SLIDER:
            <input type="range" id="pkg-slider" min="2" max="6" value="${pkgState.size === 'all' ? 3 : pkgState.size}" style="width:80px; vertical-align:middle">
            <span id="pkg-slider-label" style="font-family:var(--f-mono); color:var(--cyan); min-width:40px">${pkgState.size === 'all' ? 'All' : `N=${pkgState.size}`}</span>
          </label>

          <label class="chk" title="When a 3+ card engine is found (e.g. Underworld Breach + Brain Freeze + LED), hide the smaller 2-card sub-pairs that are already part of it">
            <input type="checkbox" id="pkg-hidesub" ${pkgState.hideSub ? 'checked' : ''}>
            Hide redundant sub-packages
          </label>

          <span class="spacer"></span>
          <span class="dim">${list.length} packages shown (${packages.length} total)</span>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th data-pkg-sort="name" class="${sKey === 'name' ? 'sorted' + (sDir > 0 ? ' asc' : '') : ''}" title="Synergistic card group appearing together significantly more than random expectation">Package (N-Gram Cards)</th>
                <th class="num ${sKey === 'size' ? 'sorted' + (sDir > 0 ? ' asc' : '') : ''}" data-pkg-sort="size" title="Number of coupled cards in this package (N = 2 to 6)">Size</th>
                <th class="num ${sKey === 'count' ? 'sorted' + (sDir > 0 ? ' asc' : '') : ''}" data-pkg-sort="count" title="Number of decklists containing every card in this package">Decks</th>
                <th class="num ${sKey === 'share' ? 'sorted' + (sDir > 0 ? ' asc' : '') : ''}" data-pkg-sort="share" title="Percentage of all filtered decks running this entire package">Share</th>
                <th class="num ${sKey === 'lift' ? 'sorted' + (sDir > 0 ? ' asc' : '') : ''}" data-pkg-sort="lift" title="Lift ratio: observed frequency divided by expected random chance (>1.0 = positive synergy)">Lift Ratio</th>
                <th class="num ${sKey === 'wrWith' ? 'sorted' + (sDir > 0 ? ' asc' : '') : ''}" data-pkg-sort="wrWith" title="Average match win rate of decks containing all cards in this package">WR with Pack</th>
                <th class="num ${sKey === 'delta' ? 'sorted' + (sDir > 0 ? ' asc' : '') : ''}" data-pkg-sort="delta" title="Win rate difference compared to decks missing one or more package cards (insig. if sample is small or p ≥ 0.05)">Δ Win Rate</th>
                <th class="num ${sKey === 'topWith' ? 'sorted' + (sDir > 0 ? ' asc' : '') : ''}" data-pkg-sort="topWith" title="Percentage of decks with this package that reached tournament top-cut">Top-Cut Rate</th>
                <th data-pkg-sort="domArch" class="${sKey === 'domArch' ? 'sorted' + (sDir > 0 ? ' asc' : '') : ''}" title="Primary archetype cluster where this package is most heavily utilized">Primary Archetype</th>
              </tr>
            </thead>
            <tbody>
              ${list.map((p) => {
                const f = (x) => (isNaN(x) ? '–' : pct(x, 1));
                const sign = p.delta > 0 ? '+' : '';
                const deltaFormatted = `${sign}${(p.delta * 100).toFixed(1)}%`;
                const deltaHtml = p.sig
                  ? `<span class="${p.delta > 0 ? 'pos' : 'neg'}" title="Statistically significant (z=${p.z.toFixed(2)}, p < 0.05)">${deltaFormatted}</span>`
                  : `<span class="delta-insig dim" title="z=${p.z.toFixed(2)}">${deltaFormatted} <small class="insig-tag">insig.</small></span>`;

                const subNotice = p.isSub ? `<span class="dim" style="font-size:10px; display:block">sub-pack of: ${esc(p.parentName)}</span>` : '';

                return `
                  <tr>
                    <td>
                      <div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center">
                        ${p.cards.map((c) => `<span class="cardname" data-card="${esc(c)}">${esc(c)}</span>`).join(' <span class="dim">+</span> ')}
                      </div>
                      ${subNotice}
                    </td>
                    <td class="num"><span class="badge cut" style="font-size:11px">${p.size}-gram</span></td>
                    <td class="num">${p.count}</td>
                    <td class="num">${pct(p.share, 1)}</td>
                    <td class="num">${p.lift ? p.lift.toFixed(2) + '×' : '–'}</td>
                    <td class="num">${f(p.wrWith)}</td>
                    <td class="num">${deltaHtml}</td>
                    <td class="num">${f(p.topWith)}</td>
                    <td><span class="dim">${esc(p.domArch)}</span></td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div class="glass panel">
        <h3>Package Schematic Cards</h3>
        <div class="hint">Detailed component view of top packages</div>
        <div class="pkg-grid">
          ${list.slice(0, 9).map((p) => `
            <div class="pkg-card">
              <div class="pkg-card-head">
                <span class="pkg-title">${p.size}-Card Package</span>
                <span class="badge cut">${p.lift ? p.lift.toFixed(1) + '× Lift' : 'Coupled'}</span>
              </div>
              <div class="pkg-cards-list">
                ${p.cards.map((c) => `
                  <div class="pkg-card-row">
                    <span class="cardname" data-card="${esc(c)}">${esc(c)}</span>
                  </div>
                `).join('')}
              </div>
              <div class="pkg-stats-row">
                <div>Decks: <b>${p.count}</b> (${pct(p.share, 0)})</div>
                <div>WR: <b>${pct(p.wrWith, 1)}</b></div>
                <div>Δ WR: <b class="${p.delta > 0 ? 'pos' : 'neg'}">${p.delta > 0 ? '+' : ''}${(p.delta * 100).toFixed(1)}%</b></div>
                <div>Top Cut: <b>${pct(p.topWith, 0)}</b></div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    const sIn = $('#pkg-search');
    if (sIn) {
      sIn.oninput = debounce((e) => {
        pkgState.q = e.target.value;
        renderPackages();
      });
    }
    const szSel = $('#pkg-size');
    if (szSel) {
      szSel.onchange = (e) => {
        pkgState.size = e.target.value;
        const sl = $('#pkg-slider');
        if (sl && e.target.value !== 'all') sl.value = e.target.value;
        renderPackages();
      };
    }
    const slIn = $('#pkg-slider');
    if (slIn) {
      slIn.oninput = (e) => {
        pkgState.size = e.target.value;
        const sel = $('#pkg-size');
        if (sel) sel.value = e.target.value;
        renderPackages();
      };
    }
    const hsChk = $('#pkg-hidesub');
    if (hsChk) {
      hsChk.onchange = (e) => {
        pkgState.hideSub = e.target.checked;
        renderPackages();
      };
    }
    $$('#tab-packages th[data-pkg-sort]').forEach((th) => {
      th.onclick = () => {
        const k = th.dataset.pkgSort;
        if (pkgState.sort === k) {
          pkgState.dir = -pkgState.dir;
        } else {
          pkgState.sort = k;
          pkgState.dir = (k === 'name' || k === 'domArch') ? 1 : -1;
        }
        renderPackages();
      };
    });
  }
  const GROUP_ORDER = ['Creature', 'Planeswalker', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Battle', 'Other', 'Land'];
  function openDeck(id) {
    const d = decks.find((x) => x.id === id); if (!d) return;
    const groups = {};
    let total = 0;
    for (const [ci, n] of d.cards) { const g = cardType[ci]; (groups[g] = groups[g] || []).push({ c: D.cards[ci], n }); total += n; }
    const body = GROUP_ORDER.filter((g) => groups[g]).map((g) => {
      const items = groups[g].sort((a, b) => a.c.cmc - b.c.cmc || a.c.name.localeCompare(b.c.name));
      const cnt = items.reduce((s, x) => s + x.n, 0);
      return `<div class="deck-group"><h4>${g} (${cnt})</h4>${items.map((x) => `<div>${x.n > 1 ? x.n + '× ' : ''}<span class="cardname" data-card="${esc(x.c.name)}">${esc(x.c.name)}</span><span class="cmc">${x.c.cmc || ''}</span></div>`).join('')}</div>`;
    }).join('');
    const imgs = d.cards.map(([ci]) => D.cards[ci]).sort((a, b) => a.cmc - b.cmc).map((c) => `<img loading="lazy" alt="${esc(c.name)}" src="${imgUrl(c.name, 'small')}">`).join('');
    $('#modal-body').innerHTML = `
      <div class="deck-head"><h2>${esc(d.player)} ${standingBadge(d.standing, d.top)}</h2></div>
      <div class="deck-meta"><span><b>${esc(d.tname)}</b></span><span>${fmtDate(d.date)}</span><span>${d.tsize} players</span><span>Record <b>${d.w}-${d.l}-${d.d}</b></span><span>Win rate <b>${pct(d.winRate, 0)}</b></span><span>${total} cards · ${d.lands} lands · avg MV ${d.avgCmc.toFixed(2)}</span></div>
      <div class="deck-actions"><button class="btn" id="m-view">🖼 Image view</button><button class="btn" id="m-copy">📋 Copy decklist</button><a class="btn" target="_blank" rel="noopener" href="https://edhtop16.com${esc(d.url)}">Open on EDHTop16 ↗</a></div>
      <div id="m-list" class="deck-cols">${body}</div><div id="m-imgs" class="deck-imgs" style="display:none">${imgs}</div>`;
    let img = false;
    $('#m-view').onclick = () => { img = !img; $('#m-list').style.display = img ? 'none' : ''; $('#m-imgs').style.display = img ? '' : 'none'; $('#m-view').textContent = img ? '📄 List view' : '🖼 Image view'; };
    $('#m-copy').onclick = (e) => {
      const txt = d.cards.map(([ci, n]) => `${n} ${D.cards[ci].name}`).join('\n');
      (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => { e.target.textContent = '✅ Copied!'; }).catch(() => { prompt('Copy decklist:', txt); });
    };
    $('#modal').classList.add('open'); $('#modal').setAttribute('aria-hidden', 'false'); document.body.style.overflow = 'hidden';
    $('.modal-card').scrollTop = 0; hidePopup();
  }
  function closeModal() { $('#modal').classList.remove('open'); $('#modal').setAttribute('aria-hidden', 'true'); document.body.style.overflow = ''; hidePopup(); }

  // ---------- card hover popup ----------
  const imgUrl = (name, version = 'normal') => `https://api.scryfall.com/cards/named?format=image&version=${version}&exact=${encodeURIComponent(name)}`;
  const popup = () => $('#card-popup');
  function showPopup(name, x, y) {
    const p = popup(), img = $('img', p);
    const rot = (Math.random() * 3.0 - 1.5).toFixed(2);
    p.style.setProperty('--popup-rot', rot + 'deg');
    if (p.dataset.name !== name) {
      p.dataset.name = name; img.classList.remove('loaded');
      img.onload = () => img.classList.add('loaded');
      img.onerror = () => { img.onerror = null; img.src = imgUrl(frontFace(name)); };
      img.src = imgUrl(name);
    }
    movePopup(x, y); p.classList.add('show');
  }
  function movePopup(x, y) {
    const p = popup(), w = 260, h = 363, pad = 18;
    let left = x + pad, top = y - h / 3;
    if (left + w > innerWidth - 8) left = x - w - pad;
    top = Math.max(8, Math.min(top, innerHeight - h - 8));
    p.style.left = left + 'px'; p.style.top = top + 'px';
  }
  function hidePopup() { popup().classList.remove('show'); }
  function initPopup() {
    document.addEventListener('mouseover', (e) => { const t = e.target.closest('[data-card]'); if (t) showPopup(t.dataset.card, e.clientX, e.clientY); });
    document.addEventListener('mousemove', (e) => { if (popup().classList.contains('show')) movePopup(e.clientX, e.clientY); });
    document.addEventListener('mouseout', (e) => { const t = e.target.closest('[data-card]'); if (t && !t.contains(e.relatedTarget)) hidePopup(); });
    document.addEventListener('scroll', hidePopup, true);
  }

  // ---------- boot ----------
  function init() {
    const idx = window.CEDH_INDEX || [];
    const sel = $('#commander-select');
    if (!idx.length) { $('#subtitle').textContent = 'No data found. Run: python3 crawler/crawl.py "<commander>"'; return; }
    sel.innerHTML = idx.map((c) => `<option value="${esc(c.slug)}">${esc(c.name)}</option>`).join('');
    sel.addEventListener('change', () => { F = DEFAULT_F(); loadCommander(sel.value); });
    initFilters(); initTabs(); initPopup();
    document.addEventListener('click', (e) => {
      const r = e.target.closest('[data-deck]'); if (r) openDeck(r.dataset.deck);
      if (e.target === $('#modal') || e.target.id === 'modal-close') closeModal();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
    const h = parseHash();
    if (h.t && $(`.tabs button[data-tab="${h.t}"]`)) { activeTab = h.t; setTabUI(); }
    const start = idx.find((c) => c.slug === h.c) ? h.c : idx[0].slug;
    sel.value = start;
    loadCommander(start);
  }
  function setTabUI() {
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === activeTab));
    $$('.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + activeTab));
  }
  init();
})();
