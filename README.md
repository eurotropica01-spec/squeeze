# Squeeze

**The borrow desk and short interest tape for Robinhood Chain.**

Pons has launched 50,000+ tokens on Robinhood Chain. Every one of those markets is long-only. Squeeze is a collateralised borrow market for those tokens — and the public short interest tape that only exists once real borrowing does.

| | |
|---|---|
| Chain | Robinhood Chain — Arbitrum Orbit L2, chainId `4663`, ETH gas, ~100ms blocks |
| Venue | Uniswap **V3**, 1% fee tier, TOKEN/WETH — the pool each Pons token launched in |
| Collateral | ETH only (v1) |
| Status | **Pre-deployment.** Spec complete, contracts unwritten, nothing audited. |

---

## What it is

Two products, one set of contracts:

- **The Desk** — post ETH at 150% margin, borrow a token, and the protocol sells it into that token's locked Uniswap V3 pool in the same transaction. Loss is capped at your collateral.
- **The Tape** — short interest, days to cover, utilization and borrow APR, live and public per token. Free, no wallet required.

The Desk earns the revenue. The Tape is the moat.

## How it is possible

The short version — the long one is in [the docs](docs/index.html) and [`SPEC.md`](SPEC.md).

**Uniswap V4 removed built-in price oracles** and moved observation tracking into optional hooks. Pons runs on **V3**, which carries the TWAP oracle inside the pool itself. For this use case the older version is strictly better — there is a manipulation-resistant price available from `pool.observe()` with no custom infrastructure at all.

Three things then fall into place:

1. **Liquidity can't be pulled.** Pons locks LP at launch creation and graduation moves nothing — the pool a short sells into is permanent.
2. **Manipulation is expensive.** Liquidation requires the 30-minute *and* the 5-minute TWAP to breach. A one-block pump costs the attacker slippage and closes nothing.
3. **Liquidation is fast.** Bad debt lives in the gap between "health factor breaks" and "keeper closes". On L1 that gap is 12 seconds plus a gas auction. On a 100ms chain with FCFS sequencing and no priority fees, it is a few hundred milliseconds.

The catch is [observation cardinality](docs/index.html#cardinality): a fresh V3 pool stores one observation and `observe(1800)` reverts. Raising it is permissionless, costs ~20k gas per slot, and becomes a mandatory step in listing.

**Nothing here is new.** The lending side is Aave logic, the pricing side is a standard V3 TWAP read, the execution side is `exactInputSingle`. No new cryptography, no AMM primitive, no hook, no custom pool. Squeeze touches the Pons pools in exactly two ways — `observe()` to read and a swap to execute — which means no integration is required and nobody can revoke access. For a product some token teams would rather did not exist, that is the whole reason it can ship.

## Repository layout

```
SPEC.md          full mechanism spec (Dutch) — the source of truth
docs/            protocol documentation site
site/            marketing site
```

Both sites are static HTML with no build step. Open `site/index.html` directly, or serve the repo root:

```bash
python -m http.server 3040
```

## Status and honesty

No contracts are deployed. No code has been audited. The numbers shown on the marketing site are illustrative.

Known risks are documented rather than buried — including the one most likely to kill the protocol (a vertical pump on a thin pool outrunning liquidation) and the fact that exhausting the Backstop Fund socialises remaining bad debt across lenders in the affected vault. See [Risk disclosures](docs/index.html#risk).

## Not affiliated

Squeeze is an independent protocol. Not affiliated with, endorsed by, or connected to Robinhood Markets, Inc., Pons, or Uniswap Labs.

## License

MIT — see [LICENSE](LICENSE).
