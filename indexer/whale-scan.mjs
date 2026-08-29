#!/usr/bin/env node
/**
 * whale-scan.mjs — find holders who cannot leave.
 *
 *   node indexer/whale-scan.mjs            # every eligible market
 *   node indexer/whale-scan.mjs HMM        # one market
 *
 * A position is "stuck" when it is larger than what the pool can absorb.
 * Selling it into the open market would move the price against the seller
 * for the entire size — so the position is worth far less than its quoted
 * value, and the holder has no way out at anything near the screen price.
 *
 * This is the demand side of a block-trade desk, and it is fully public:
 * balances and pool reserves are both on-chain. Nothing here uses private
 * data, off-chain identity, or anything but the ledger.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ADDR, blockscout, rpc } from './lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tape = JSON.parse(readFileSync(resolve(ROOT, 'data', 'tape.json'), 'utf8'));

const filter = (process.argv[2] || '').toUpperCase();

/* Constant-product approximation of how much of the quote reserve can be
   taken out before the price falls by `drop`. Exact for a full-range pool;
   for concentrated liquidity it is the right order of magnitude, which is
   all that is needed to tell "can exit" from "cannot possibly exit". */
const sellable = (poolEth, drop) => poolEth * (1 - Math.sqrt(1 - drop));

/**
 * What a seller actually receives for dumping a position worth `posEth` at
 * quoted price into a pool holding `poolEth` of quote.
 *
 * Constant product: proceeds = E·Δ/(T+Δ). Expressed in quoted-value terms
 * the token price cancels out entirely, so this needs no price input:
 *   proceeds = poolEth · posEth / (poolEth + posEth)
 *
 * The result is brutal and correct: a position equal to the pool's own size
 * realises half its quoted value. Ten times the pool realises nine percent.
 */
const dumpProceeds = (posEth, poolEth) => (poolEth * posEth) / (poolEth + posEth);

/* A block trade is priced at a discount to the oracle price, but on the
   whole size. Below this discount the seller is better off dumping. */
const BLOCK_DISCOUNT = 0.25;

/* Addresses that are protocol plumbing rather than someone's position. */
const INFRA = new Set(
  [ADDR.locker, ADDR.positionManager, ADDR.swapRouter, ADDR.v3Factory, ADDR.factory,
   '0x0000000000000000000000000000000000000000',
   '0x000000000000000000000000000000000000dEaD'].map((a) => a.toLowerCase()),
);

const fmt = (n, d = 1) =>
  Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';

const b = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const hot = (s) => `\x1b[31m${s}\x1b[0m`;
const amb = (s) => `\x1b[33m${s}\x1b[0m`;

const ethUsd = await (async () => {
  const s = await blockscout('/stats', { quiet: true });
  return s?.coin_price ? Number(s.coin_price) : null;
})();

const block = Number(BigInt(await rpc('eth_blockNumber', [])));

console.log();
console.log(b('Squeeze — stuck position scan'));
console.log(dim(`  Robinhood Chain · block ${block.toLocaleString()}${ethUsd ? ` · ETH $${fmt(ethUsd, 0)}` : ''}`));
console.log(dim('  A position is stuck when it exceeds what the pool can absorb.'));
console.log();

const markets = tape.tokens.filter(
  (t) => t.oracleReady && t.twap30 && t.poolEth && (!filter || t.symbol.toUpperCase() === filter),
);

const all = [];

for (const t of markets) {
  const holders = await blockscout(`/tokens/${t.address}/holders`);
  if (!holders?.items?.length) {
    console.log(`${b('$' + t.symbol)} ${dim('— holder data unavailable, skipped')}`);
    continue;
  }

  const exit10 = sellable(t.poolEth, 0.10);
  const exit20 = sellable(t.poolEth, 0.20);

  const rows = holders.items
    .filter((h) => {
      const a = (h.address?.hash || '').toLowerCase();
      return a && a !== t.pool.toLowerCase() && !INFRA.has(a) && !h.address?.is_contract;
    })
    .map((h) => {
      const tokens = Number(h.value) / 10 ** t.decimals;
      const eth = tokens * t.twap30;
      return {
        symbol: t.symbol,
        address: h.address.hash,
        tokens,
        eth,
        usd: ethUsd ? eth * ethUsd : null,
        supplyPct: t.totalSupply ? (tokens / t.totalSupply) * 100 : null,
        /* how many -10% dumps it would take to clear the position */
        dumps: eth / exit10,
        /* what dumping actually pays out, versus a block at a discount */
        dump: dumpProceeds(eth, t.poolEth),
        block: eth * (1 - BLOCK_DISCOUNT),
      };
    })
    .filter((r) => r.eth > 0.05)
    .sort((x, y) => y.eth - x.eth);

  const stuck = rows.filter((r) => r.eth > exit10);
  all.push(...stuck);

  console.log(
    `${b('$' + t.symbol.padEnd(8))} pool ${fmt(t.poolEth).padStart(7)} ETH · ` +
    `absorbs ${fmt(exit10)} ETH at −10%, ${fmt(exit20)} ETH at −20%`,
  );

  if (!rows.length) { console.log(dim('  no non-contract holders returned')); console.log(); continue; }

  rows.slice(0, 6).forEach((r) => {
    const tag = r.dumps >= 10 ? hot('LOCKED IN') : r.dumps >= 1 ? amb('stuck    ') : dim('can exit ');
    const uplift = r.block - r.dump;
    console.log(
      `  ${tag} ${r.address.slice(0, 10)}…${r.address.slice(-4)}  ` +
      `${fmt(r.eth, 1).padStart(8)} ETH held  ` +
      `dump ${fmt(r.dump, 1).padStart(7)}  block ${fmt(r.block, 1).padStart(7)}  ` +
      `${(ethUsd ? '+$' + fmt(uplift * ethUsd, 0) : '+' + fmt(uplift, 1) + ' ETH').padStart(11)} better`,
    );
  });

  console.log(dim(`  ${stuck.length} of ${rows.length} top holders hold more than the pool can absorb`));
  console.log();
}

/* ---- the pitch, in one number ------------------------------------------ */

all.sort((x, y) => y.eth - x.eth);
const totalEth = all.reduce((a, r) => a + r.eth, 0);

console.log(b('Addressable market'));
console.log(`  ${all.length} stuck positions across ${markets.length} markets`);
console.log(`  ${fmt(totalEth)} ETH${ethUsd ? ` · $${fmt(totalEth * ethUsd, 0)}` : ''} of value that cannot exit on-chain`);
if (all.length) {
  const top = all[0];
  console.log(dim(`  largest: $${top.symbol} · ${fmt(top.eth, 1)} ETH · would need ${fmt(top.dumps, 0)} consecutive −10% dumps to clear`));

  const totalDump = all.reduce((a, r) => a + r.dump, 0);
  const totalBlock = all.reduce((a, r) => a + r.block, 0);
  const uplift = totalBlock - totalDump;
  console.log();
  console.log(b(`Value a block desk creates at a ${BLOCK_DISCOUNT * 100}% discount`));
  console.log(`  dumping everything realises  ${fmt(totalDump).padStart(9)} ETH  ${dim(`(${fmt((totalDump / totalEth) * 100, 0)}% of quoted value)`)}`);
  console.log(`  blocks at −${BLOCK_DISCOUNT * 100}% realise      ${fmt(totalBlock).padStart(9)} ETH  ${dim(`(${fmt((1 - BLOCK_DISCOUNT) * 100, 0)}% of quoted value)`)}`);
  console.log(`  value created                ${fmt(uplift).padStart(9)} ETH${ethUsd ? `  ${b('$' + fmt(uplift * ethUsd, 0))}` : ''}`);
  console.log(dim(`  a 1% desk fee on that flow is ${fmt(totalBlock * 0.01)} ETH${ethUsd ? ` · $${fmt(totalBlock * 0.01 * ethUsd, 0)}` : ''}`));
}
console.log();
console.log(dim('  Every one of these is a block-trade lead, priced by the ledger.'));
console.log();
