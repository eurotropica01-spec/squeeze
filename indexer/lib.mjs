/* Shared helpers for the Squeeze indexer.
   No dependencies. Node 18+ (uses global fetch). */

export const RPC = process.env.SQUEEZE_RPC || 'https://rpc.mainnet.chain.robinhood.com';
export const BS  = 'https://robinhoodchain.blockscout.com/api/v2';

/* Pons / Uniswap V3 deployment on Robinhood Chain (chainId 4663).
   Source: docs.ponsfamily.com */
export const ADDR = {
  factory:         '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB', // PonsLaunchFactory
  locker:          '0x736D76699C26D0d966744cAe304C000d471f7F35',
  v3Factory:       '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA',
  positionManager: '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3',
  swapRouter:      '0xCaf681a66D020601342297493863E78C959E5cb2',
  quoterV2:        '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7',
  weth:            '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
};

export const FEE_TIER = 10000; // Pons launches on the 1% tier

const UA = 'squeeze-indexer/0.1 (+https://github.com/eurotropica01-spec/squeeze)';

/* Blockscout's edge rejects non-browser user agents with a 403, so its API
   needs a browser-shaped one. Read-only public endpoints only. */
const BS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* ---------- low level ---------------------------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let rpcId = 0;
export async function rpc(method, params, { retries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': UA },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      });
      const j = await res.json();
      if (j.error) throw new Error(`${method}: ${j.error.message}`);
      return j.result;
    } catch (e) {
      if (attempt >= retries) throw e;
      await sleep(400 * 2 ** attempt); // public RPC is rate limited
    }
  }
}

export const ethCall = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);

export async function blockscout(path, { retries = 3, quiet = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${BS}${path}`, {
        headers: { 'user-agent': BS_UA, accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt >= retries) {
        /* Never fail silently. A null here removes a component from the score,
           and that has to be visible or the output starts looking like data
           when it is actually absence of data. */
        if (!quiet) console.warn(`    blockscout unavailable: ${path} (${e.message})`);
        return null;
      }
      await sleep(500 * 2 ** attempt);
    }
  }
}

/* ---------- abi coding (only what we need) ------------------------------- */

export const words = (hex) => (hex || '0x').slice(2).match(/.{64}/g) || [];
export const toUint = (w) => BigInt('0x' + w);
export const toAddr = (w) => '0x' + w.slice(24);

export function toInt(w, bits = 256) {
  const v = BigInt('0x' + w);
  const lim = 1n << BigInt(bits - 1);
  return v >= lim ? v - (1n << BigInt(bits)) : v;
}
export const toInt24 = (w) => {
  const v = BigInt('0x' + w.slice(-6));
  return v >= 1n << 23n ? v - (1n << 24n) : v;
};

const pad = (n, w = 64) => BigInt(n).toString(16).padStart(w, '0');
const padAddr = (a) => a.toLowerCase().replace('0x', '').padStart(64, '0');

/* ---------- selectors ----------------------------------------------------- */

export const SEL = {
  slot0:        '0x3850c7bd',
  liquidity:    '0x1a686502',
  token0:       '0x0dfe1681',
  token1:       '0xd21220a7',
  fee:          '0xddca3f43',
  observe:      '0x883bdbfd',
  getPool:      '0x1698ee82',
  balanceOf:    '0x70a08231',
  totalSupply:  '0x18160ddd',
  decimals:     '0x313ce567',
  symbol:       '0x95d89b41',
  name:         '0x06fdde03',
};

/* ---------- typed reads ---------------------------------------------------- */

export async function getPool(tokenA, tokenB, fee = FEE_TIER) {
  const data = SEL.getPool + padAddr(tokenA) + padAddr(tokenB) + pad(fee);
  const r = await ethCall(ADDR.v3Factory, data);
  const addr = toAddr(words(r)[0]);
  return /^0x0{40}$/.test(addr) ? null : addr;
}

export async function readSlot0(pool) {
  const w = words(await ethCall(pool, SEL.slot0));
  if (w.length < 7) return null;
  return {
    sqrtPriceX96: toUint(w[0]),
    tick: Number(toInt24(w[1])),
    observationIndex: Number(toUint(w[2])),
    observationCardinality: Number(toUint(w[3])),
    observationCardinalityNext: Number(toUint(w[4])),
    unlocked: toUint(w[6]) === 1n,
  };
}

export const readLiquidity = async (pool) => toUint(words(await ethCall(pool, SEL.liquidity))[0]);
export const readBalance = async (token, holder) =>
  toUint(words(await ethCall(token, SEL.balanceOf + padAddr(holder)))[0]);
export const readTotalSupply = async (token) => toUint(words(await ethCall(token, SEL.totalSupply))[0]);
export const readDecimals = async (token) => Number(toUint(words(await ethCall(token, SEL.decimals))[0]));

export async function readString(token, selector) {
  const r = await ethCall(token, selector);
  const w = words(r);
  if (w.length < 2) return null;
  const len = Number(toUint(w[1]));
  const hex = w.slice(2).join('').slice(0, len * 2);
  return Buffer.from(hex, 'hex').toString('utf8');
}

/**
 * Read tickCumulatives for a set of look-back windows.
 * Returns null when the pool cannot serve the window (OLD revert) — that is a
 * real answer, not a failure: it means the oracle has insufficient history.
 */
export async function observe(pool, secondsAgos) {
  const data = SEL.observe + pad(32) + pad(secondsAgos.length) + secondsAgos.map((s) => pad(s)).join('');
  let r;
  try {
    r = await ethCall(pool, data);
  } catch {
    return null;
  }
  const w = words(r);
  if (!w.length) return null;
  const off = Number(toUint(w[0])) / 32;
  const len = Number(toUint(w[off]));
  const out = [];
  for (let i = 0; i < len; i++) out.push(toInt(w[off + 1 + i]));
  return out;
}

/* ---------- price math ----------------------------------------------------- */

export const tickToPrice = (tick) => Math.pow(1.0001, tick);

/**
 * Average tick between two observation points.
 * secondsAgos must be ordered oldest -> newest, matching the observe() call.
 */
export const avgTick = (cumulatives, older, newer, elapsed) =>
  Number(cumulatives[newer] - cumulatives[older]) / elapsed;

/** Price of token1 denominated in token0, from a tick. */
export function priceFromTick(tick, decimals0, decimals1) {
  return tickToPrice(tick) * Math.pow(10, decimals0 - decimals1);
}

export const fmtEth = (wei, dp = 4) => (Number(wei) / 1e18).toFixed(dp);
