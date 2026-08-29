/* ==========================================================================
   SQUEEZE — interactions
   Transform/opacity only. Everything degrades to static if JS is off.
   ========================================================================== */

(() => {
  'use strict';

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

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

  /* ---------- copy contract address ------------------------------------ */

  const copyBtn = $('#copyAddr');
  const addrText = $('#addrText');
  const ADDR = '0x7c4E00000000000000000000000000000000',
        SHORT = '0x7c4E…9aF1';
  copyBtn?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(ADDR); } catch { /* clipboard blocked */ }
    addrText.textContent = 'Copied';
    setTimeout(() => { addrText.textContent = SHORT; }, 1400);
  });

  /* ---------- hero: score count-up + bars ------------------------------ */

  const scoreEl = $('#heroScore');
  const barsWrap = $('#heroBars');

  const runHero = () => {
    // bars
    $$('.bar__fill[data-w]', barsWrap).forEach((el, i) => {
      setTimeout(() => { el.style.transform = `scaleX(${+el.dataset.w / 100})`; }, 120 + i * 90);
    });
    // numeric labels
    $$('[data-v]', barsWrap).forEach((el, i) => {
      setTimeout(() => { el.textContent = el.dataset.v; }, 200 + i * 90);
    });
    // score
    const target = 84;
    if (reduced) { scoreEl.textContent = target; return; }
    const t0 = performance.now(), dur = 1100;
    const tick = (t) => {
      const p = Math.min((t - t0) / dur, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      scoreEl.textContent = Math.round(eased * target);
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  setTimeout(runHero, 380);

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

  /* ---------- marquee --------------------------------------------------- */

  const MARQ = [
    ['NASDANQ', '18.4%'], ['HMM', '14.1%'], ['YOLO', '11.7%'], ['WIRE', '9.3%'],
    ['LOCK', '8.8%'], ['DICE', '7.4%'], ['BULL', '6.1%'], ['NEUT', '5.2%'],
    ['IMAGINE', '4.6%'], ['HOOJA', '3.9%'], ['KANSO', '3.1%'], ['MKTCAT', '2.4%'],
  ];
  const marquee = $('#marquee');
  if (marquee) {
    const row = MARQ.map(([t, si]) =>
      `<div class="chip"><b>$${t}</b><span class="si">${si} SI</span></div>`).join('');
    marquee.innerHTML = row + row; // duplicated for the -50% loop
  }

  /* ---------- how it works: steps <-> panes ---------------------------- */

  const steps = $$('#steps .step');
  const panes = $$('#panes .pane');
  let active = 0, autoTimer = null;

  const setStep = (n) => {
    active = n;
    steps.forEach((s, i) => s.classList.toggle('on', i === n));
    panes.forEach((p, i) => p.classList.toggle('on', i === n));
  };

  steps.forEach((s) => s.addEventListener('click', () => {
    setStep(+s.dataset.i);
    clearInterval(autoTimer);
    autoTimer = null;
  }));

  // gentle auto-advance, only while the section is on screen, stops on click
  const howSection = $('#how');
  if (howSection && !reduced) {
    new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting && autoTimer === null) {
          autoTimer = setInterval(() => setStep((active + 1) % steps.length), 5200);
        } else if (!e.isIntersecting && autoTimer) {
          clearInterval(autoTimer); autoTimer = null;
        }
      });
    }, { threshold: 0.35 }).observe(howSection);
  }

  /* ---------- short ticket --------------------------------------------- */

  const slider = $('#collSlider');
  const NOTIONAL = 2.940;       // ETH proceeds from the sale
  const LIQ_THRESHOLD = 1.20;   // liquidates at 120% collateral ratio

  const paintTicket = (ratioPct) => {
    const ratio = ratioPct / 100;
    const coll  = NOTIONAL * ratio;
    const hf    = ratio / LIQ_THRESHOLD;
    const move  = (hf - 1) * 100;

    $('#tColl').textContent = coll.toFixed(3) + ' ETH';
    const hfEl = $('#tHf');
    hfEl.textContent = hf.toFixed(2);
    hfEl.className = 'hf__v ' + (hf < 1.15 ? 'hot' : 'up');
    $('#tLiq').textContent = `Liq. price +${move.toFixed(0)}%`;

    $$('#seg button').forEach((b) => {
      b.classList.toggle('on', Math.round(parseFloat(b.textContent) * 100) === ratioPct);
    });
  };

  slider?.addEventListener('input', () => paintTicket(+slider.value));

  $$('#seg button').forEach((b) => b.addEventListener('click', () => {
    const pct = Math.round(parseFloat(b.textContent) * 100);
    slider.value = pct;
    paintTicket(pct);
  }));

  if (slider) paintTicket(+slider.value);

  /* ---------- the tape -------------------------------------------------- */

  const ROWS = [
    { t: 'NASDANQ', s: 84, si: 18.4, d: 6.2, u: 91, b: 248 },
    { t: 'HMM',     s: 76, si: 14.1, d: 4.8, u: 87, b: 312 },
    { t: 'YOLO',    s: 61, si: 11.7, d: 3.1, u: 74, b: 96  },
    { t: 'WIRE',    s: 54, si:  9.3, d: 2.9, u: 68, b: 71  },
    { t: 'LOCK',    s: 47, si:  8.8, d: 2.2, u: 61, b: 58  },
    { t: 'DICE',    s: 39, si:  7.4, d: 1.8, u: 52, b: 44  },
    { t: 'BULL',    s: 28, si:  6.1, d: 1.1, u: 38, b: 31  },
    { t: 'NEUT',    s: 19, si:  5.2, d: 0.7, u: 24, b: 23  },
  ];

  const tapeBody = $('#tapeBody');
  const scoreClass = (s) => s >= 80 ? 'score score--hi' : s >= 60 ? 'score score--mid' : 'score';

  const paintTape = () => {
    tapeBody.innerHTML = ROWS.map((r) => `
      <tr>
        <td>$${r.t}</td>
        <td><span class="${scoreClass(r.s)}">${r.s}</span></td>
        <td class="hot">${r.si.toFixed(1)}%</td>
        <td>${r.d.toFixed(1)}d</td>
        <td>${r.u}%</td>
        <td class="hot">${r.b}%</td>
      </tr>`).join('');
  };

  if (tapeBody) {
    paintTape();
    // small live drift so the table reads as a running market
    if (!reduced) setInterval(() => {
      ROWS.forEach((r) => {
        r.si = Math.max(0.5, r.si + (Math.random() - 0.5) * 0.18);
        r.b  = Math.max(8, Math.round(r.b + (Math.random() - 0.5) * 7));
      });
      paintTape();
    }, 2600);
  }

  /* ---------- terminal feed --------------------------------------------- */

  const FEED = [
    ['c-dim', '$ squeeze feed --live'],
    ['c-dim', '  streaming Robinhood Chain · block 4,182,097'],
    ['', ''],
    ['c-hot', '! LIQUIDATED  $NASDANQ short · 4.21 ETH · HF 0.97'],
    ['c-dim', '  keeper 0x3f…a1 · bonus 0.336 ETH'],
    ['c-w',   '> OPEN        $HMM short · 124,000 HMM @ 0.0000237'],
    ['c-up',  '+ SUPPLY      812K HMM deposited · util 87% → 91%'],
    ['c-am',  '~ RATE        $HMM borrow 248% → 312% APR'],
    ['c-hot', '! LIQUIDATED  $NASDANQ short · 1.84 ETH · HF 0.94'],
    ['c-hot', '! LIQUIDATED  $NASDANQ short · 7.02 ETH · HF 0.91'],
    ['c-dim', '  cascade · 3 positions · 13.07 ETH · 41 s'],
    ['', ''],
    ['c-am',  '★ SQUEEZE WATCH  $NASDANQ score 79 → 84'],
    ['c-dim', '  posted to x.com/squeezetape'],
    ['c-up',  '+ CLOSE       $YOLO short · +0.62 ETH realised'],
    ['c-dim', '  fees to protocol 0.061 ETH · 80% → burn'],
  ];

  const term = $('#term');

  const playFeed = () => {
    term.innerHTML = '';
    FEED.forEach(([cls, text], i) => {
      const line = document.createElement('span');
      line.className = 'l ' + cls;
      line.textContent = text || ' ';
      term.appendChild(line);
      setTimeout(() => line.classList.add('in'), reduced ? 0 : 90 + i * 260);
    });
    const caret = document.createElement('span');
    caret.className = 'l in';
    caret.innerHTML = '<span class="caret"></span>';
    term.appendChild(caret);
  };

  if (term) {
    let played = false;
    new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting || played) return;
        played = true;
        playFeed();
        if (!reduced) setInterval(playFeed, FEED.length * 260 + 6000);
      });
    }, { threshold: 0.25 }).observe(term);
  }

  /* ---------- faq -------------------------------------------------------- */

  $$('#faqList .q').forEach((q) => {
    const head = $('.q__h', q);
    head.addEventListener('click', () => {
      const open = q.classList.contains('on');
      $$('#faqList .q').forEach((o) => o.classList.remove('on'));
      q.classList.toggle('on', !open);
    });
  });

})();
