// Smoke test for Dip Runner: drives `node main.ts` through a synthetic
// agent-fun/replay/v2 tape (run-up, dip, second wind, take-profit, plus
// scout flickers on 20 extra coins), then checks:
//   1. every reply is valid JSON, type "reply", echoing the batch seq,
//   2. no reply breaks the caps (<= 16 orders, buys <= 1% of real reserves),
//   3. the bot actually buys the dip and later sells (fills happen),
//   4. two runs produce byte-identical stdout (determinism).
// Run: node test/smoke.mjs   (from the repo root; exits non-zero on failure)

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const LAMPORTS = 1_000_000_000n;
const CURVE_FEE_BPS = 125n; // 95 protocol + 30 creator
const TX_FEE = 105_000n;
const LATENCY = 2;

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function fakeAddr(seed) {
  let s = '';
  let x = seed * 2654435761 + 97;
  for (let i = 0; i < 44; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    s += B58[x % B58.length];
  }
  return s;
}

// --- curve state -----------------------------------------------------------
class Curve {
  constructor(mint) {
    this.mint = mint;
    this.vq = 30_000_000_000n; // virtual SOL reserves (lamports)
    this.vt = 1_000_000_000_000_000n; // virtual token reserves
    this.rq = 5_000_000_000n; // real SOL reserves
    this.rt = 800_000_000_000_000n;
    this.createdSlot = 0;
    this.complete = false;
    this.trades = 0;
  }
  price() {
    return Number(this.vq) / Number(this.vt);
  }
  // Apply a market trade of `solLamports` (positive = buy). Returns tokens.
  applyTrade(solLamports, isBuy) {
    if (isBuy) {
      const q = solLamports;
      const tokens = (this.vt * q) / (this.vq + q);
      this.vq += q;
      this.vt -= tokens;
      this.rq += q;
      this.rt -= tokens;
      this.trades++;
      return tokens;
    }
    // Sell: solLamports is the SOL value of the tokens sold; invert the curve.
    const targetOut = solLamports;
    // tokens t such that vq*t/(vt+t) ~= targetOut  =>  t = targetOut*vt/(vq-targetOut)
    let t = (targetOut * this.vt) / (this.vq - targetOut);
    if (t >= this.vt) t = this.vt - 1n;
    const out = (this.vq * t) / (this.vt + t);
    this.vq -= out;
    this.vt += t;
    this.rq -= out;
    this.rt += t;
    this.trades++;
    return t;
  }
}

// --- scenario ---------------------------------------------------------------
const MINT_A = fakeAddr(11); // dip runner: run-up, dip, second wind, rally
const MINT_B = fakeAddr(22); // bleeder: steady sells, never a buy
const SCOUTS = Array.from({ length: 20 }, (_, i) => fakeAddr(100 + i));
const curves = new Map();
for (const m of [MINT_A, MINT_B, ...SCOUTS]) curves.set(m, new Curve(m));

function tradeEvent(curve, slot, isBuy, solLamports, user, seq) {
  const tokens = curve.applyTrade(solLamports, isBuy);
  return {
    type: undefined, // filled below
    event: 'TradeEvent',
    mint: curve.mint,
    sol_amount: solLamports.toString(),
    token_amount: tokens.toString(),
    is_buy: isBuy,
    user,
    timestamp: String(1_700_000_000 + slot),
    virtual_sol_reserves: curve.vq.toString(),
    virtual_token_reserves: curve.vt.toString(),
    real_sol_reserves: curve.rq.toString(),
    real_token_reserves: curve.rt.toString(),
    fee_recipient: fakeAddr(900),
    fee_basis_points: '95',
    fee: '0',
    creator: fakeAddr(901),
    creator_fee_basis_points: '30',
    creator_fee: '0',
    track_volume: true,
    total_unclaimed_tokens: '0',
    total_claimed_tokens: '0',
    current_sol_volume: '0',
    last_update_timestamp: String(1_700_000_000 + slot),
    ix_name: isBuy ? 'buy' : 'sell',
    mayhem_mode: false,
    cashback_fee_basis_points: '0',
    cashback: '0',
    buyback_fee_basis_points: '0',
    buyback_fee: '0',
    shareholders: [],
    quote_mint: 'So11111111111111111111111111111111111111112',
    quote_amount: solLamports.toString(),
    virtual_quote_reserves: curve.vq.toString(),
    real_quote_reserves: curve.rq.toString(),
    holder_rewards_bps: '0',
    holder_rewards: '0',
    creator_fee_unclaimed: '0',
    slot,
    signature: fakeAddr(500 + slot),
    block_time: 1_700_000_000 + slot,
    chain_seq: seq,
  };
}

function createEvent(curve, slot) {
  curve.createdSlot = slot;
  return {
    event: 'CreateEvent',
    name: 'Test',
    symbol: 'TEST',
    uri: 'https://example.invalid/t.json',
    mint: curve.mint,
    bonding_curve: fakeAddr(700),
    user: fakeAddr(701),
    creator: fakeAddr(702),
    timestamp: String(1_700_000_000 + slot),
    virtual_token_reserves: curve.vt.toString(),
    virtual_sol_reserves: curve.vq.toString(),
    real_token_reserves: curve.rt.toString(),
    token_total_supply: '1000000000000000',
    token_program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    is_mayhem_mode: false,
    is_cashback_enabled: false,
    quote_mint: 'So11111111111111111111111111111111111111112',
    virtual_quote_reserves: curve.vq.toString(),
    creator_fee_bps: '30',
    is_holder_reward: false,
    depth: 0,
    slot,
    signature: fakeAddr(800 + slot),
    block_time: 1_700_000_000 + slot,
    chain_seq: 0,
  };
}

// Scripted tape, one entry per slot: [mint, isBuy, solLamports, userSeed]
function tapeForSlot(slot) {
  const out = [];
  const push = (mint, isBuy, sol, userSeed) => out.push([mint, isBuy, BigInt(sol), userSeed]);
  if (slot === 100) {
    for (const m of [MINT_A, MINT_B, ...SCOUTS]) out.push(['__create__', m]);
    return out;
  }
  // Mint A: run-up slots 101-130 (buys ~0.55 SOL each, 3 wallets).
  if (slot >= 101 && slot <= 130) push(MINT_A, true, 550_000_000, 10 + (slot % 3));
  // Mint A: dip slots 131-145 (sells ~0.45 SOL each).
  if (slot >= 131 && slot <= 145) push(MINT_A, false, 450_000_000, 20 + (slot % 2));
  // Mint A: second wind slots 146-165 (buys ~0.5 SOL each, 3 wallets).
  if (slot >= 146 && slot <= 165) push(MINT_A, true, 500_000_000, 30 + (slot % 3));
  // Mint A: rally slots 166-200 (buys ~0.6 SOL each) to push through take-profit.
  if (slot >= 166 && slot <= 200) push(MINT_A, true, 600_000_000, 40 + (slot % 3));
  // Mint B: bleeds the whole time.
  if (slot >= 101 && slot <= 200) push(MINT_B, false, 200_000_000, 50 + (slot % 2));
  // Scouts: each coin flickers once — 10 slots of buys pushing price up ~10%.
  SCOUTS.forEach((m, i) => {
    const start = 110 + i * 4;
    if (slot >= start && slot < start + 10) push(m, true, 400_000_000, 60 + (slot % 3));
  });
  return out;
}

// --- replay driver ----------------------------------------------------------
async function runOnce() {
  // Reset the shared curve state: the tape mutates curves as it
  // generates events (tradeEvent applies every market trade, and
  // applyOrder applies every bot fill), so a second run would
  // otherwise start from the first run's final reserves and see a
  // different tape. Fresh curves per run keep both runs identical.
  for (const m of [MINT_A, MINT_B, ...SCOUTS]) curves.set(m, new Curve(m));
  const root = path.dirname(fileURLToPath(import.meta.url));
  const bot = spawn('node', ['main.ts'], { cwd: path.resolve(root, '..'), stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let buf = '';
  const waiters = [];
  bot.stdout.on('data', (d) => {
    stdout += d;
    buf += d;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const w = waiters.shift();
      if (w) w(line);
    }
  });
  bot.stderr.on('data', (d) => {
    stderr += d;
  });
  const nextLine = () => new Promise((resolve) => waiters.push(resolve));
  const send = (obj) => bot.stdin.write(`${JSON.stringify(obj)}\n`);

  const hello = {
    type: 'hello',
    protocol: 'agent-fun/replay/v2',
    seed: '12345',
    universe: {
      program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      quote: 'SOL',
      mayhem: 'excluded',
      exclude_cashback: true,
      sample: { hash: 'sha256', modulus: 100, residue: 0 },
    },
    capital: { lamports: '10000000000' },
    caps: { max_open_positions: 5, max_order_bps_of_real_reserve: 100, max_orders_per_batch: 16, shorts: false, leverage: false },
    latency_slots: LATENCY,
    fees: { protocol_bps_fallback: 95, creator_bps_fallback: 30, base_fee_lamports: '5000', priority_fee_lamports: '100000', failed_tx_bps: 0 },
  };
  send(hello);

  let cash = 10_000_000_000n;
  const positions = new Map(); // mint -> { tokens, cost }
  const pendingFills = new Map(); // resolveSlot -> [fill]
  const fills = [];
  let seq = 0;
  const replies = [];

  const account = () => ({
    cash_lamports: cash.toString(),
    positions: [...positions.entries()].map(([mint, p]) => ({ mint, token_amount: p.tokens.toString(), cost_lamports: p.cost.toString() })),
  });

  // Resolve one bot order at its fill slot, updating cash/positions/reserves.
  function applyOrder(order, decidedSlot, resolveSlot) {
    const curve = curves.get(order.mint);
    const fill = {
      client_id: order.client_id,
      mint: order.mint,
      side: order.side,
      status: 'filled',
      reason: null,
      decided_slot: decidedSlot,
      slot: resolveSlot,
      quote_lamports: '0',
      token_amount: '0',
      fee_lamports: '0',
      tx_fee_lamports: TX_FEE.toString(),
      fee_fallback: false,
    };
    if (curve.complete) {
      fill.status = 'rejected';
      fill.reason = 'token_complete';
      return fill;
    }
    if (order.side === 'buy') {
      const q = BigInt(order.quote_lamports);
      const cap = (curve.rq * 100n) / 10_000n;
      if (q > cap) {
        fill.status = 'rejected';
        fill.reason = 'max_order_size';
        return fill;
      }
      if (cash < q + TX_FEE) {
        fill.status = 'rejected';
        fill.reason = 'insufficient_cash';
        return fill;
      }
      const gross = (curve.vt * q) / (curve.vq + q);
      const tokens = (gross * (10_000n - CURVE_FEE_BPS)) / 10_000n;
      curve.vq += q;
      curve.vt -= tokens;
      curve.rq += q;
      curve.rt -= tokens;
      cash -= q + TX_FEE;
      const p = positions.get(order.mint) ?? { tokens: 0n, cost: 0n };
      p.tokens += tokens;
      p.cost += q + TX_FEE;
      positions.set(order.mint, p);
      fill.quote_lamports = q.toString();
      fill.token_amount = tokens.toString();
    } else {
      const p = positions.get(order.mint);
      const t = BigInt(order.token_amount);
      if (!p || p.tokens < t) {
        fill.status = 'rejected';
        fill.reason = 'insufficient_tokens';
        return fill;
      }
      const gross = (curve.vq * t) / (curve.vt + t);
      const out = (gross * (10_000n - CURVE_FEE_BPS)) / 10_000n;
      curve.vq -= out;
      curve.vt += t;
      curve.rq -= out;
      curve.rt += t;
      cash += out - TX_FEE;
      p.tokens -= t;
      if (p.tokens === 0n) positions.delete(order.mint);
      fill.quote_lamports = out.toString();
      fill.token_amount = t.toString();
    }
    return fill;
  }

  const LAST_SLOT = 260;
  for (let slot = 100; slot <= LAST_SLOT; slot++) {
    seq++;
    const events = [];
    let chainSeq = 0;
    for (const [mint, isBuy, sol, userSeed] of tapeForSlot(slot)) {
      if (mint === '__create__') {
        // mint field holds the actual mint here
        events.push(createEvent(curves.get(isBuy), slot));
      } else {
        events.push(tradeEvent(curves.get(mint), slot, isBuy, sol, fakeAddr(userSeed), chainSeq++));
      }
    }
    const due = pendingFills.get(slot) ?? [];
    pendingFills.delete(slot);
    const resolved = due.map((o) => applyOrder(o.order, o.decidedSlot, slot));
    fills.push(...resolved.filter((f) => f.status === 'filled'));
    const marks = [...positions.keys()].map((mint) => {
      const c = curves.get(mint);
      return {
        mint,
        slot,
        virtual_token_reserves: c.vt.toString(),
        virtual_quote_reserves: c.vq.toString(),
        real_token_reserves: c.rt.toString(),
        real_quote_reserves: c.rq.toString(),
      };
    });
    send({ type: 'batch', seq, slot, events, marks, fills: resolved, account: account() });
    const line = await nextLine();
    const reply = JSON.parse(line);
    replies.push(reply);
    if (reply.type !== 'reply' || reply.seq !== seq) throw new Error(`bad reply at seq ${seq}: ${line.slice(0, 200)}`);
    if (!Array.isArray(reply.orders) || reply.orders.length > 16) throw new Error(`reply over order cap at seq ${seq}`);
    for (const o of reply.orders) {
      const resolveSlot = slot + LATENCY;
      if (!pendingFills.has(resolveSlot)) pendingFills.set(resolveSlot, []);
      pendingFills.get(resolveSlot).push({ order: o, decidedSlot: slot });
    }
  }
  // Drain remaining pending fills with two empty batches, then done.
  for (let extra = 1; extra <= LATENCY; extra++) {
    seq++;
    const slot = LAST_SLOT + extra;
    const due = pendingFills.get(slot) ?? [];
    pendingFills.delete(slot);
    const resolved = due.map((o) => applyOrder(o.order, o.decidedSlot, slot));
    fills.push(...resolved.filter((f) => f.status === 'filled'));
    send({ type: 'batch', seq, slot, events: [], marks: [], fills: resolved, account: account() });
    const line = await nextLine();
    const reply = JSON.parse(line);
    replies.push(reply);
    if (reply.type !== 'reply' || reply.seq !== seq) throw new Error(`bad drain reply at seq ${seq}`);
  }
  send({ type: 'done', seq: seq + 1, reason: 'end_of_data', account: account() });
  const code = await new Promise((resolve) => bot.on('close', resolve));
  if (code !== 0) throw new Error(`bot exited ${code}; stderr: ${stderr.slice(0, 2000)}`);
  if (stderr.trim()) console.error(`[bot stderr]\n${stderr.slice(0, 1000)}`);
  return { stdout, replies, fills, cash, positions };
}

const a = await runOnce();
const b = await runOnce();
if (a.stdout !== b.stdout) throw new Error('NON-DETERMINISTIC: two runs differ');

const buys = a.fills.filter((f) => f.side === 'buy');
const sells = a.fills.filter((f) => f.side === 'sell');
const coins = new Set(a.fills.map((f) => f.mint));
const spent = buys.reduce((s, f) => s + BigInt(f.quote_lamports), 0n);
const received = sells.reduce((s, f) => s + BigInt(f.quote_lamports), 0n);
// Mark remaining positions to market at final reserves (rough, fee-free).
let openValue = 0n;
for (const [mint, p] of a.positions) {
  const c = curves.get(mint);
  openValue += (c.vq * p.tokens) / (c.vt + p.tokens);
}
const netPnl = (a.cash + openValue - 10_000_000_000n) / 1_000_000n; // in 0.001 SOL
console.log(`batches answered: ${a.replies.length}`);
console.log(`fills: ${a.fills.length} (buys ${buys.length}, sells ${sells.length}) on ${coins.size} coins`);
console.log(`bought ${MINT_A === [...coins][0] ? '' : ''}mint A traded: ${coins.has(MINT_A)}; bleeder B traded: ${coins.has(MINT_B)}`);
console.log(`SOL spent on buys: ${Number(spent) / 1e9}, received on sells: ${Number(received) / 1e9}`);
console.log(`final cash: ${Number(a.cash) / 1e9} SOL, open positions: ${a.positions.size}, net PnL: ${Number(netPnl) / 1000} SOL`);
if (buys.length === 0) throw new Error('FAIL: bot never bought');
if (sells.length === 0) throw new Error('FAIL: bot never sold');
if (!coins.has(MINT_A)) throw new Error('FAIL: bot never traded the dip coin');
if (coins.has(MINT_B)) throw new Error('FAIL: bot bought the bleeder');
console.log('SMOKE OK: valid replies, deterministic, dip bought, bleeder skipped, exits fired');
