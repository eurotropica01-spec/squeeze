/* ==========================================================================
   SQUEEZE — site interactions

   Live panels render data/tape.json, produced by indexer/build-tape.mjs from
   Robinhood Chain. If that file cannot be loaded, panels say so and stay
   empty. There is deliberately no fallback dataset: showing invented numbers
   when the real ones are unavailable is the failure mode this whole page
   exists to avoid.
   ========================================================================== */

(() => {
  'use strict';

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const nf = (n, d = 0) =>
    n === null || n === undefined || !Number.isFinite(n)
      ? '—'
      : n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

  const pct = (n, d = 2) =>
    n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`;

  const sci = (n) => (Number.isFinite(n) ? n.toExponential(4) : '—');
  const clamp01 = (x) => Math.min(1, Math.max(0, x));

  /* ---------- scroll reveal ------------------------------------------- */

  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      e.target.classList.add('in');
      io.unobserve(e.target);
    });
  }, { rootMargin: '0px 0px -12% 0px', threshold: 0.08 });
  $$('.rv').forEach((el) => io.observe(el));

  /* ---------- sticky nav ----------------------------------------------- */

  const nav = $('#nav');
  let ticking = false;
  addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      nav.classList.toggle('is-stuck', scrollY > 12);
      ticking = false;
    });
  }, { passive: true });

  /* ---------- statement rotor ------------------------------------------ */

  const rotor = $('#rotor');
  if (rotor && !reduced) {
    const words = $$('i', rotor);
    let i = 0;
    setInterval(() => {
      words[i].classList.replace('on', 'off');
      const prev = words[i];
      setTimeout(() => prev.classList.remove('off'), 600);
      i = (i + 1) % words.length;
      words[i].classList.add('on');
      rotor.setAttribute('aria-label', words[i].textContent);
    }, 2100);
  }

  /* ---------- steps <-> panes ------------------------------------------ */

  const steps = $$('#steps .step');
  const panes = $$('#panes .pane');
  let active = 0;
  let autoTimer = null;

  const setStep = (n) => {
    active = n;
    steps.forEach((s, i) => s.classList.toggle('on', i === n));
    panes.forEach((p, i) => p.classList.toggle('on', i === n));
  };

  const stopAuto = () => { clearInterval(autoTimer); autoTimer = null; };

  steps.forEach((s) => s.addEventListener('click', () => { setStep(+s.dataset.i); stopAuto(); }));

  const howSection = $('#how');
  if (howSection && !reduced) {
    new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting && autoTimer === null) {
          autoTimer = setInterval(() => setStep((active + 1) % steps.length), 5200);
        } else if (!e.isIntersecting) stopAuto();
      });
    }, { threshold: 0.35 }).observe(howSection);
  }

  /* The Tape and The Oracle are panes, not sections — deep links to them
     have to select the pane as well as scroll to it. */
  const focusPane = (hash) => {
    const idx = { '#tape': 3, '#oracle': 2 }[hash];
    if (idx === undefined) return;
    setStep(idx);
    stopAuto();
  };
  addEventListener('hashchange', () => focusPane(location.hash));
  $$('a[href="#tape"], a[href="#oracle"]').forEach((a) =>
    a.addEventListener('click', () => setTimeout(() => focusPane(a.getAttribute('href')), 0)));

  /* ---------- short ticket (mockup, but the maths is the real formula) -- */

  const slider = $('#collSlider');
  const NOTIONAL = 2.940;
  const LIQ_THRESHOLD = 1.20;

  const paintTicket = (ratioPct) => {
    const ratio = ratioPct / 100;
    const hf = ratio / LIQ_THRESHOLD;
    $('#tColl').textContent = (NOTIONAL * ratio).toFixed(3) + ' ETH';
    const hfEl = $('#tHf');
    hfEl.textContent = hf.toFixed(2);
    hfEl.className = 'hf__v ' + (hf < 1.15 ? 'hot' : 'up');
    $('#tLiq').textContent = `Liq. price +${((hf - 1) * 100).toFixed(0)}%`;
    $$('#seg button').forEach((b) =>
      b.classList.toggle('on', Math.round(parseFloat(b.textContent) * 100) === ratioPct));
  };

  slider?.addEventListener('input', () => paintTicket(+slider.value));
  $$('#seg button').forEach((b) => b.addEventListener('click', () => {
    const p = Math.round(parseFloat(b.textContent) * 100);
    slider.value = p;
    paintTicket(p);
  }));
  if (slider) paintTicket(+slider.value);

  /* ====================================================================== */
  /*  Live data                                                             */
  /* ====================================================================== */

  const unavailable = (msg) => {
    $('#navBlock').textContent = 'offline';
    $('#heroNote').innerHTML = `<i class="pulse"></i> ${msg}`;
    $('#tapeBody').innerHTML =
      `<tr><td colspan="6" style="text-align:center;color:var(--t-3)">${msg}</td></tr>`;
    $('#tapeMeta').textContent = msg;
    $('#orVerdict').innerHTML = `<i class="pulse"></i> ${msg}`;
    $('#term').innerHTML = `<span class="l in c-dim">${msg}</span>`;
  };

  const scoreClass = (s) => (s === null ? 'score' : s >= 60 ? 'score score--hi' : s >= 35 ? 'score score--mid' : 'score');

  function renderTape(d) {
    const rows = d.tokens;

    /* --- nav + meta --- */
    $('#navBlock').textContent = `block ${nf(d.block)}`;

    const age = Math.round((Date.now() - new Date(d.generatedAt)) / 60000);
    $('#tapeMeta').innerHTML =
      `${d.counts.eligible} of ${d.counts.total} tokens meet the listing criteria · ` +
      `indexed at block ${nf(d.block)}, ${age < 1 ? 'just now' : `${age} min ago`} · ` +
      `<a href="https://github.com/eurotropica01-spec/squeeze/blob/main/data/tape.json">raw data</a>`;

    /* --- hero: highest-scoring eligible market --- */
    const lead = rows.filter((r) => r.eligible && r.setupScore !== null)[0] || rows[0];
    if (lead) {
      $('#heroTk').textContent = '$' + lead.symbol;
      $('#heroNote').innerHTML = lead.eligible
        ? '<i class="pulse"></i> Meets every listing criterion'
        : '<i class="pulse"></i> Watchlist · ' + lead.failedCriteria.join(', ');

      const bars = {
        poolEth: { v: `${nf(lead.poolEth, 1)} ETH`, w: clamp01(lead.poolEth / 500) },
        holders: { v: nf(lead.holders), w: clamp01((lead.holders || 0) / 45000) },
        card:    { v: nf(lead.observationCardinality), w: clamp01((lead.observationCardinality || 0) / 20000) },
        div:     { v: pct(lead.divergencePct), w: clamp01(Math.abs(lead.divergencePct || 0) / 10) },
      };
      Object.entries(bars).forEach(([k, { v, w }], i) => {
        const label = $(`#heroBars [data-k="${k}"].mono`);
        const fill = $(`#heroBars i.bar__fill[data-k="${k}"]`);
        setTimeout(() => {
          if (label) label.textContent = v;
          if (fill) fill.style.transform = `scaleX(${w})`;
        }, 120 + i * 90);
      });

      const target = lead.setupScore ?? 0;
      const el = $('#heroScore');

      /* Write the real value first. requestAnimationFrame does not fire in a
         tab that is not compositing (opened in the background, another window
         in front), so an animation that owns the final value would leave the
         placeholder on screen forever. The count-up is decoration; the number
         is not. */
      el.textContent = lead.setupScore ?? '—';

      if (!reduced && target) {
        const t0 = performance.now();
        const tick = (t) => {
          const p = Math.min((t - t0) / 1100, 1);
          el.textContent = Math.round((1 - (1 - p) ** 3) * target);
          if (p < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }
    }

    /* --- marquee: real pool depth per market --- */
    const marquee = $('#marquee');
    if (marquee) {
      const row = rows.map((t) =>
        `<div class="chip"><b>$${t.symbol}</b><span class="si">${nf(t.poolEth, 1)} ETH</span></div>`).join('');
      marquee.innerHTML = row + row;
    }

    /* --- oracle pane: the lead market's actual TWAP windows --- */
    if (lead) {
      $('#orTk').textContent = '$' + lead.symbol + ' / WETH';
      $('#orCard').textContent = nf(lead.observationCardinality);
      $('#orT30').textContent = sci(lead.twap30) + ' ETH';
      $('#orT5').textContent = sci(lead.twap5) + ' ETH';
      $('#orSpot').textContent = sci(lead.spot) + ' ETH';
      $('#orDiv').textContent = pct(lead.divergencePct, 3);
      $('#orVerdict').innerHTML = lead.oracleReady
        ? '<i class="pulse"></i> Both windows served from stored observations'
        : `<i class="pulse"></i> ${lead.oracleNote}`;
    }

    /* --- the tape --- */
    $('#tapeBody').innerHTML = rows.map((t) => {
      const dim = t.eligible ? '' : ' style="opacity:.55"';
      const obs = t.oracleReady
        ? nf(t.observationCardinality)
        : `<span class="hot" title="${t.oracleNote || ''}">${nf(t.observationCardinality)}</span>`;
      return `<tr${dim}>
        <td>$${t.symbol}</td>
        <td><span class="${scoreClass(t.setupScore)}">${t.setupScore ?? '—'}</span></td>
        <td>${nf(t.poolEth, 1)}</td>
        <td>${nf(t.holders)}</td>
        <td>${obs}</td>
        <td class="${Math.abs(t.divergencePct || 0) > 3 ? 'hot' : ''}">${pct(t.divergencePct, 1)}</td>
      </tr>`;
    }).join('');

    /* --- terminal: the indexer's actual verdicts --- */
    const term = $('#term');
    const lines = [
      ['c-dim', '$ node indexer/build-tape.mjs'],
      ['c-dim', `  chain ${d.chainId} · block ${nf(d.block)}`],
      ['', ''],
    ];
    rows.forEach((t) => {
      const tag = t.eligible ? 'ELIGIBLE' : 'watch   ';
      const cls = t.eligible ? 'c-up' : 'c-dim';
      lines.push([cls,
        `  ${tag} $${t.symbol.padEnd(8)} ${String(nf(t.poolEth, 1)).padStart(8)} ETH  ` +
        `obs ${String(nf(t.observationCardinality)).padStart(6)}  ` +
        `score ${t.setupScore === null ? ' n/a' : String(t.setupScore).padStart(4)}`]);
      if (!t.eligible) lines.push(['c-hot', `           ${t.failedCriteria.join(', ')}`]);
    });
    lines.push(['', '']);
    lines.push(['c-am', `  ${d.counts.eligible} of ${d.counts.total} eligible under SPEC.md section 4`]);

    term.innerHTML = '';
    lines.forEach(([cls, text], i) => {
      const line = document.createElement('span');
      line.className = 'l ' + cls;
      line.textContent = text || ' ';
      term.appendChild(line);
      setTimeout(() => line.classList.add('in'), reduced ? 0 : 60 + i * 90);
    });
    const caret = document.createElement('span');
    caret.className = 'l in';
    caret.innerHTML = '<span class="caret"></span>';
    term.appendChild(caret);
  }

  fetch('../data/tape.json', { cache: 'no-cache' })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then(renderTape)
    .catch(() => unavailable('Live data unavailable — serve the repo over HTTP to load it'));

  /* ---------- faq -------------------------------------------------------- */

  $$('#faqList .q').forEach((q) => {
    $('.q__h', q).addEventListener('click', () => {
      const open = q.classList.contains('on');
      $$('#faqList .q').forEach((o) => o.classList.remove('on'));
      q.classList.toggle('on', !open);
    });
  });

  if (location.hash) setTimeout(() => focusPane(location.hash), 60);
})();
