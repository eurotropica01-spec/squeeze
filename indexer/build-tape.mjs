#!/usr/bin/env node
/**
 * build-tape.mjs — build data/tape.json from live Robinhood Chain state.
 *
 *   node indexer/build-tape.mjs
 *
 * What this is: the v0 Squeeze Setup Score. It is NOT short interest.
 * Short interest cannot exist until the borrow market does; until then this
 * ranks how violently a token could move on buying pressure, using proxies
 * that are computable today. The formula is documented in README and printed
 * into the output file so anyone can recompute it.
 *
 * Every field is either read from chain / Blockscout, or null. Nothing is
 * estimated, smoothed, or invented — a missing input drops that component's
 * weight instead of substituting a guess.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ADDR, FEE_TIER, rpc, blockscout, getPool, readSlot0, readBalance,
  readTotalSupply, readDecimals, readString, observe, avgTick, tickToPrice, SEL,
} from './lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'data', 'tape.json');

const WINDOW_LONG = 1800;
const WINDOW_SHORT = 300;

/* Candidate symbols. Membership is NOT assumed — each one must resolve to a
   real Uniswap V3 pool against WETH at the 1% tier on the Pons V3 factory,
   which only Pons-launched tokens have. Anything else is dropped. */
const CANDIDATES = [
  'PONS', 'HMM', 'YOLO', 'NASDANQ', 'WIRE', 'LOCK', 'DICE',
  'NEUT', 'BULL', 'IMAGINE', 'HOOJA', 'KANSO',
];

/* ---------- score model -------------------------------------------------- */

const WEIGHTS = { thinness: 35, concentration: 25, volatility: 20, turnover: 20 };
const MIN_COVERAGE = 0.6;

const RANGES = {
  thinness:      [0.001, 0.05], // pool ETH / market cap ETH — inverted
  concentration: [0.10, 0.70],  // top-10 holders share of supply
  volatility:    [0, 5],        // |5m vs 30m TWAP| in %
  turnover:      [0, 0.5],      // 24h volume / market cap
};

const norm = (x, [lo, hi]) => Math.min(1, Math.max(0, (x - lo) / (hi - lo)));

/**
 * Weighted score over whichever components have data.
 * Missing inputs are excluded and the remaining weights are renormalised,
 * so a token with partial data is scored fairly rather than penalised.
 */
function setupScore(parts) {
  let total = 0;
  let used = 0;
  const detail = {};
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    const v = parts[key];
    if (v === null || v === undefined || !Number.isFinite(v)) {
      detail[key] = null;
      continue;
    }
    const n = key === 'thinness' ? 1 - norm(v, RANGES[key]) : norm(v, RANGES[key]);
    detail[key] = Math.round(n * 100) / 100;
    total += weight * n;
    used += weight;
  }
  const coverage = Math.round((used / 100) * 100) / 100;
  /* Renormalising over too few components inflates the result: a token
     missing half its inputs would otherwise outrank one that has them all.
     Below 60% coverage the score is not meaningful, so publish nothing. */
  if (!used || coverage < MIN_COVERAGE) return { score: null, detail, coverage };
  return { score: Math.round((total / used) * 100), detail, coverage };
}

/* Listing criteria from SPEC.md §4, evaluated against live state. */
const MIN_POOL_ETH = 30;
const MIN_HOLDERS = 500;

function eligibility({ poolEth, holders, oracleReady }) {
  const failed = [];
  if (!(poolEth >= MIN_POOL_ETH)) failed.push(`pool < ${MIN_POOL_ETH} ETH`);
  if (!(holders >= MIN_HOLDERS)) failed.push(`holders < ${MIN_HOLDERS}`);
  if (!oracleReady) failed.push('no usable TWAP');
  return { eligible: failed.length === 0, failedCriteria: failed };
}

/* ---------- discovery ---------------------------------------------------- */

async function resolveToken(symbol) {
  const res = await blockscout(`/search?q=${encodeURIComponent(symbol)}`);
  const items = res?.items?.filter((i) => i.is_smart_contract_address && i.symbol) ?? [];

  for (const item of items.slice(0, 6)) {
    if (item.symbol.toUpperCase() !== symbol.toUpperCase()) continue;
    const addr = item.address_hash;
    let pool = null;
    try {
      pool = await getPool(ADDR.weth, addr, FEE_TIER);
    } catch {
      continue;
    }
    if (pool) return { addr, pool, meta: item };
  }
  return null;
}

/* ---------- per-token read ------------------------------------------------ */

async function readToken({ addr, pool, meta }) {
  const [slot0, decimals, name, supply, wethInPool, tokenInPool] = await Promise.all([
    readSlot0(pool),
    readDecimals(addr).catch(() => 18),
    readString(addr, SEL.name).catch(() => null),
    readTotalSupply(addr).catch(() => null),
    readBalance(ADDR.weth, pool).catch(() => null),
    readBalance(addr, pool).catch(() => null),
  ]);

  const rawCums = await observe(pool, [WINDOW_LONG, WINDOW_SHORT, 0]);

  /* A pool with cardinality 1 still answers observe() — it extrapolates from
     the single stored observation using the current tick. That is spot price
     wearing a TWAP costume: it carries no history, so it offers no
     manipulation resistance and both "windows" collapse onto the same number.
     Treat it as no oracle at all rather than trusting a flat 0% divergence. */
  const hasHistory = (slot0?.observationCardinality ?? 0) > 1;
  const cums = hasHistory ? rawCums : null;

  const token0IsWeth = ADDR.weth.toLowerCase() < addr.toLowerCase();
  const scale = Math.pow(10, 18 - decimals);
  const priceInEth = (tick) => (token0IsWeth ? 1 / tickToPrice(tick) : tickToPrice(tick)) / scale;

  const tick30 = cums ? avgTick(cums, 0, 2, WINDOW_LONG) : null;
  const tick5 = cums ? avgTick(cums, 1, 2, WINDOW_SHORT) : null;

  const p30 = tick30 === null ? null : priceInEth(tick30);
  const p5 = tick5 === null ? null : priceInEth(tick5);
  const spot = slot0 ? priceInEth(slot0.tick) : null;
  const divergence = p30 && p5 ? (p5 / p30 - 1) * 100 : null;

  const poolEth = wethInPool === null ? null : Number(wethInPool) / 1e18;
  const supplyN = supply === null ? null : Number(supply) / Math.pow(10, decimals);
  const mcapEth = supplyN !== null && p30 !== null ? supplyN * p30 : null;

  /* Holder concentration, excluding the pool and the Pons locker — those are
     protocol-held, not a whale sitting on supply. */
  const holdersRes = await blockscout(`/tokens/${addr}/holders`);
  const counters = await blockscout(`/tokens/${addr}/counters`);

  const excluded = new Set([pool.toLowerCase(), ADDR.locker.toLowerCase(), ADDR.positionManager.toLowerCase()]);
  let concentration = null;
  if (holdersRes?.items?.length && supply) {
    const top = holdersRes.items
      .filter((h) => !excluded.has((h.address?.hash || '').toLowerCase()))
      .slice(0, 10)
      .reduce((acc, h) => acc + Number(h.value || 0), 0);
    concentration = top / Number(supply);
  }

  const mcapUsd = meta.circulating_market_cap ? Number(meta.circulating_market_cap) : null;
  const vol24 = meta.volume_24h ? Number(meta.volume_24h) : null;
  const turnover = mcapUsd && vol24 ? vol24 / mcapUsd : null;

  const thinness = poolEth !== null && mcapEth ? poolEth / mcapEth : null;

  const scored = setupScore({
    thinness,
    concentration,
    volatility: divergence === null ? null : Math.abs(divergence),
    turnover,
  });

  const holders = counters?.token_holders_count ? Number(counters.token_holders_count) : null;
  const gate = eligibility({
    poolEth,
    holders,
    oracleReady: cums !== null,
  });

  return {
    ...gate,
    symbol: meta.symbol,
    name: name || meta.name || null,
    address: addr,
    pool,
    decimals,

    // live pool state
    poolEth: poolEth === null ? null : Number(poolEth.toFixed(4)),
    tokensInPool: tokenInPool === null ? null : Number(Number(tokenInPool) / Math.pow(10, decimals)),
    observationCardinality: slot0?.observationCardinality ?? null,
    oracleReady: cums !== null,
    oracleNote: hasHistory
      ? (rawCums ? null : 'observe() reverted — window exceeds stored history')
      : 'cardinality 1 — observe() returns extrapolated spot, not a TWAP',

    // prices, in ETH, straight from the pool oracle
    twap30: p30,
    twap5: p5,
    spot,
    divergencePct: divergence === null ? null : Number(divergence.toFixed(3)),

    // supply / market
    totalSupply: supplyN,
    marketCapEth: mcapEth === null ? null : Number(mcapEth.toFixed(2)),
    marketCapUsd: mcapUsd,
    volume24hUsd: vol24,
    holders,

    // score inputs, exposed so the number can be recomputed by hand
    inputs: {
      thinness: thinness === null ? null : Number(thinness.toFixed(6)),
      concentration: concentration === null ? null : Number(concentration.toFixed(4)),
      volatility: divergence === null ? null : Number(Math.abs(divergence).toFixed(3)),
      turnover: turnover === null ? null : Number(turnover.toFixed(4)),
    },
    normalised: scored.detail,
    coverage: scored.coverage,
    setupScore: scored.score,

    // real short-interest fields, deliberately null until the Desk is live
    shortInterestPct: null,
    daysToCover: null,
    utilization: null,
    borrowApr: null,
  };
}

/* ---------- main ---------------------------------------------------------- */

console.log('Squeeze indexer — reading live Robinhood Chain state\n');

const block = Number(BigInt(await rpc('eth_blockNumber', [])));
const chainId = Number(BigInt(await rpc('eth_chainId', [])));
if (chainId !== 4663) {
  console.error(`Refusing to index: chainId ${chainId} is not Robinhood Chain.`);
  process.exit(1);
}
console.log(`  chain 4663 · block ${block.toLocaleString()}\n`);

const rows = [];
for (const symbol of CANDIDATES) {
  process.stdout.write(`  ${symbol.padEnd(9)}`);
  try {
    const found = await resolveToken(symbol);
    if (!found) {
      console.log('skip — no 1% WETH pool on the Pons V3 factory');
      continue;
    }
    const row = await readToken(found);
    rows.push(row);
    console.log(
      `${row.eligible ? 'ELIGIBLE' : 'watch   '} ` +
      `pool ${String(row.poolEth ?? '?').padStart(9)} ETH  ` +
      `card ${String(row.observationCardinality ?? '?').padStart(6)}  ` +
      `score ${row.setupScore === null ? ' n/a' : String(row.setupScore).padStart(4)}` +
      (row.eligible ? '' : `   ${row.failedCriteria.join(', ')}`),
    );
  } catch (e) {
    console.log(`error — ${e.message}`);
  }
}

/* Eligible markets first, then watchlist. Within each group, by score.
   Ranking an ineligible token above an eligible one would imply it is
   tradeable, which is the opposite of what the gate is for. */
rows.sort((a, b) => {
  if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
  return (b.setupScore ?? -1) - (a.setupScore ?? -1);
});

const out = {
  $schema: 'squeeze-tape-v0',
  generatedAt: new Date().toISOString(),
  chainId,
  block,
  rpc: 'https://rpc.mainnet.chain.robinhood.com',
  note:
    'v0 Setup Score on proxy data. This is NOT short interest — that requires ' +
    'the borrow market to exist. Short-interest fields are null by design.',
  model: {
    weights: WEIGHTS,
    ranges: RANGES,
    minCoverage: MIN_COVERAGE,
    windows: { long: WINDOW_LONG, short: WINDOW_SHORT },
    listingCriteria: { minPoolEth: MIN_POOL_ETH, minHolders: MIN_HOLDERS, feeTier: FEE_TIER },
  },
  counts: { total: rows.length, eligible: rows.filter((r) => r.eligible).length },
  contracts: ADDR,
  tokens: rows,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');

const eligible = rows.filter((r) => r.eligible);
console.log(`\n  ${rows.length} tokens indexed · ${eligible.length} eligible under SPEC.md §4`);
console.log(`  eligible: ${eligible.map((r) => '$' + r.symbol).join(', ') || 'none'}`);
console.log(`  written to data/tape.json at block ${block.toLocaleString()}`);
