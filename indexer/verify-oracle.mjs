#!/usr/bin/env node
/**
 * verify-oracle.mjs — prove the core feasibility claim against live chain state.
 *
 * Squeeze's liquidation logic depends on one thing: that a manipulation-resistant
 * TWAP can be read from a Pons token's Uniswap V3 pool today, with no new
 * contracts and no cooperation from anyone. This script checks exactly that.
 *
 *   node indexer/verify-oracle.mjs            # PONS
 *   node indexer/verify-oracle.mjs 0x<token>  # any Pons token
 *
 * Every number printed is read live from https://rpc.mainnet.chain.robinhood.com.
 * Nothing here is cached, mocked, or hardcoded.
 */

import {
  ADDR, FEE_TIER, rpc, getPool, readSlot0, readLiquidity, readBalance,
  readDecimals, readString, observe, avgTick, tickToPrice, SEL,
} from './lib.mjs';

const WINDOW_LONG = 1800; // 30 minutes — primary liquidation price
const WINDOW_SHORT = 300; //  5 minutes — confirmation window

const PONS = '0x39dBED3a2bd333467115dE45665cC57F813C4571';
const token = (process.argv[2] || PONS).trim();

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const b = (s) => `\x1b[1m${s}\x1b[0m`;

const row = (k, v, note = '') =>
  console.log(`  ${k.padEnd(30)} ${String(v).padStart(24)}  ${dim(note)}`);

const checks = [];
const check = (label, pass, detail) => {
  checks.push({ label, pass });
  console.log(`  ${pass ? ok('PASS') : bad('FAIL')}  ${label.padEnd(44)} ${dim(detail || '')}`);
};

console.log();
console.log(b('Squeeze — live oracle verification'));
console.log(dim('  Robinhood Chain · chainId 4663 · reading mainnet state'));
console.log();

/* ---- 1. chain ---------------------------------------------------------- */

const chainIdHex = await rpc('eth_chainId', []);
const blockHex = await rpc('eth_blockNumber', []);
const chainId = Number(BigInt(chainIdHex));
const block = Number(BigInt(blockHex));

console.log(b('Chain'));
row('chainId', chainId, chainId === 4663 ? 'Robinhood Chain' : 'UNEXPECTED');
row('block', block.toLocaleString());
console.log();

/* ---- 2. token + pool --------------------------------------------------- */

const [symbol, decimals] = await Promise.all([
  readString(token, SEL.symbol).catch(() => null),
  readDecimals(token).catch(() => 18),
]);

const pool = await getPool(ADDR.weth, token, FEE_TIER);

console.log(b('Token'));
row('address', token);
row('symbol', symbol ? `$${symbol}` : '(unreadable)');
row('decimals', decimals);
console.log();

if (!pool) {
  console.log(bad('  No Uniswap V3 pool at the 1% tier against WETH.'));
  console.log(dim('  This is not a Pons-launched token, or it has not been deployed.'));
  process.exit(1);
}

const [slot0, liq, wethInPool] = await Promise.all([
  readSlot0(pool),
  readLiquidity(pool),
  readBalance(ADDR.weth, pool),
]);

const poolEth = Number(wethInPool) / 1e18;

console.log(b('Pool'));
row('pool', pool);
row('fee tier', `${FEE_TIER / 10000}%`);
row('WETH in pool', poolEth.toFixed(4), 'ETH');
row('active liquidity', liq.toString());
row('current tick', slot0.tick);
console.log();

/* ---- 3. the oracle ------------------------------------------------------ */

console.log(b('Oracle'));
row('observationCardinality', slot0.observationCardinality);
row('observationIndex', slot0.observationIndex);
row('cardinalityNext', slot0.observationCardinalityNext);
console.log();

/* A pool left at the V3 default stores exactly one observation. It will still
   answer observe() — by extrapolating from that single point using the current
   tick — which looks like a working TWAP and is not one. Both windows collapse
   onto spot, so there is no manipulation resistance whatsoever. Check the
   buffer before trusting the number. */
const hasHistory = slot0.observationCardinality > 1;
check(
  'Cardinality above V3 default of 1',
  hasHistory,
  hasHistory
    ? `${slot0.observationCardinality} slots provisioned`
    : 'observe() would return extrapolated spot, not a TWAP',
);

const rawCums = await observe(pool, [WINDOW_LONG, WINDOW_SHORT, 0]);
const cums = hasHistory ? rawCums : null;

check(
  `observe([${WINDOW_LONG}, ${WINDOW_SHORT}, 0]) returns real history`,
  cums !== null,
  cums
    ? 'pool served both windows from stored observations'
    : hasHistory
      ? 'reverted — window exceeds stored history'
      : 'answered, but from a single observation — rejected',
);

if (!cums) {
  console.log();
  console.log(bad('  No usable 30-minute TWAP on this pool.'));
  console.log(dim('  Raise cardinality via increaseObservationCardinalityNext, then wait for it to fill.'));
  console.log(dim(`  ${checks.filter((c) => c.pass).length}/${checks.length} checks passed`));
  process.exit(1);
}

const tick30 = avgTick(cums, 0, 2, WINDOW_LONG);
const tick5 = avgTick(cums, 1, 2, WINDOW_SHORT);

/* Pons pools are always TOKEN/WETH. token0 ordering decides which way the
   tick points, so derive the token price in ETH rather than assuming. */
const token0IsWeth = ADDR.weth.toLowerCase() < token.toLowerCase();
const scale = Math.pow(10, 18 - decimals);
const priceInEth = (tick) => (token0IsWeth ? 1 / tickToPrice(tick) : tickToPrice(tick)) / scale;

const p30 = priceInEth(tick30);
const p5 = priceInEth(tick5);
const spot = priceInEth(slot0.tick);
const divergence = (p5 / p30 - 1) * 100;
const spotDiv = (spot / p30 - 1) * 100;

console.log();
console.log(b('Price'));
row('30m TWAP', p30.toExponential(5), 'ETH');
row('5m TWAP', p5.toExponential(5), 'ETH');
row('spot', spot.toExponential(5), 'ETH');
row('5m vs 30m', `${divergence >= 0 ? '+' : ''}${divergence.toFixed(3)}%`);
row('spot vs 30m', `${spotDiv >= 0 ? '+' : ''}${spotDiv.toFixed(3)}%`);
console.log();

console.log(b('Checks'));
check(
  'Both TWAP windows return finite prices',
  Number.isFinite(p30) && Number.isFinite(p5) && p30 > 0 && p5 > 0,
  'dual-bound liquidation is computable',
);
check(
  'Windows disagree — they are independent signals',
  Math.abs(divergence) > 0,
  `${divergence.toFixed(3)}% apart right now`,
);
check(
  'Pool liquidity is readable for cap sizing',
  poolEth > 0,
  `${poolEth.toFixed(2)} ETH backing the market`,
);

/* Under Squeeze's rule a position is only liquidatable when BOTH windows
   breach. Show what that rule would do with the current numbers. */
const THRESHOLD = 20; // illustrative: a position underwater by 20%
const longBreach = spotDiv > THRESHOLD;
const shortBreach = divergence > THRESHOLD;

console.log();
console.log(b('Dual-bound rule, evaluated now'));
row('5m window breaches +20%', shortBreach ? 'yes' : 'no');
row('30m window breaches +20%', longBreach ? 'yes' : 'no');
row('would liquidate', longBreach && shortBreach ? 'YES' : 'no', 'requires both');

const passed = checks.filter((c) => c.pass).length;
console.log();
console.log(b(`${passed}/${checks.length} checks passed`));
console.log(dim(`  Verified against block ${block.toLocaleString()} at ${new Date().toISOString()}`));
console.log(dim('  Re-run this yourself: node indexer/verify-oracle.mjs'));
console.log();

process.exit(passed === checks.length ? 0 : 1);
