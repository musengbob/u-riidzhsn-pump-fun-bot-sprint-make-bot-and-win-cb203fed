// Dip Runner — a pump.fun bonding-curve replay bot (agent-fun/replay/v2).
//
// Idea: on pump.fun, most curves print one fast run-up, dump as early buyers
// take profit, and then either bleed out or catch a second wind. The second
// wind is the tradeable part: a curve that ran up, pulled back a healthy
// amount, and then shows fresh buying from several wallets while the price
// ticks back up off its dip low. This bot buys that moment — small, with
// scale-ins only while the tape keeps confirming — and exits on fixed
// take-profit / stop-loss, a trailing stop, a flow-dry exit, or a time stop.
//
// A second, smaller mechanism keeps the entry above the competition's
// breadth bar (a >= 0.01 SOL round trip on at least 20 coins): "scout"
// positions of 0.012 SOL on coins showing a fresh 10-slot momentum flicker.
// Scouts are real positions under the same exit rules as main trades — they
// are never instant round trips — they just size smaller and cap lower.
//
// Risk: at most 5 open positions, at most 1.5 SOL of cost exposed at once,
// buys capped at 1% of a curve's real SOL reserve per batch, every leg pays
// the 95 bps protocol + 30 bps creator curve fee plus a 105,000 lamport tx
// fee. Deterministic by construction: no clock, no environment, no
// Math.random; every decision comes from the batch stream, iterated in
// insertion order.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry lookback, in slots. */
  window: number;
  /** Price must have risen at least this much from the window start to its window high. */
  runUp: number;
  /** Dip from the window high: buy only when the pullback is between these bounds. */
  dipMin: number;
  dipMax: number;
  /** Last price must be at least this multiple of the dip low (the bounce is real). */
  bounce: number;
  /** Confirmation window, in slots: fresh buying must show up inside it. */
  confirmWindow: number;
  /** Net SOL (buys minus sells) over the confirmation window needed to enter. */
  confirmNetSol: number;
  /** Buy trades in the confirmation window. */
  confirmBuys: number;
  /** Distinct buying wallets in the confirmation window. */
  confirmBuyers: number;
  /** Largest single buyer's share of the confirmation window's buy SOL (anti-bundle filter). */
  maxBuyerShare: number;
  /** Real SOL reserve bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since CreateEvent before an entry is allowed, and after which it is too late. */
  minAge: number;
  maxAge: number;
  /** Total SOL committed to one main position. */
  stakeSol: number;
  /** First buy of a main position (SOL). */
  initialSol: number;
  /** Each add-on buy (SOL). */
  addSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys in bps; sells always go out at 10000 so exits actually fill. */
  buySlipBps: number;
  /** Exits, as fractions of cost / peak value. */
  stopLoss: number;
  takeProfit: number;
  trail: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** Exit when net SOL over the dry window falls below -dryNetSol. */
  dryWindow: number;
  dryNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit after this many slots held (unless the position is up). */
  maxHold: number;
  /** Fraction up at which the hold limit stops applying. */
  holdIfUp: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most main positions open at once (the rest of the 5 slots is for scouts). */
  maxMain: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  /** Scout trigger: price up over this many slots, and net inflow over it. */
  scoutWindow: number;
  scoutMinUp: number;
  scoutMinNetSol: number;
  scoutMinBuys: number;
  scoutMinBuyers: number;
  /** SOL per scout buy (just over the 0.01 SOL round-trip bar). */
  scoutSol: number;
  /** Most scout positions open at once. */
  maxScouts: number;
  /** Most scout entries over the run (breadth cap, keeps fee bleed bounded). */
  maxScoutEntries: number;
}

export const DEFAULT_PARAMS: Params = {
  window: 30,
  runUp: 0.25,
  dipMin: 0.08,
  dipMax: 0.3,
  bounce: 1.02,
  confirmWindow: 8,
  confirmNetSol: 0.15,
  confirmBuys: 3,
  confirmBuyers: 3,
  maxBuyerShare: 0.5,
  minRqSol: 1,
  maxRqSol: 80,
  minAge: 30,
  maxAge: 1500,
  stakeSol: 0.15,
  initialSol: 0.03,
  addSol: 0.03,
  minBuySol: 0.01,
  buySlipBps: 1500,
  stopLoss: 0.12,
  takeProfit: 0.25,
  trail: 0.12,
  trailArm: 0.08,
  dryWindow: 15,
  dryNetSol: 0.3,
  bigSellSol: 3,
  maxHold: 600,
  holdIfUp: 0.15,
  cooldown: 150,
  maxEntries: 2,
  maxMain: 4,
  maxExposureSol: 1.5,
  scoutWindow: 10,
  scoutMinUp: 0.08,
  scoutMinNetSol: 0.1,
  scoutMinBuys: 3,
  scoutMinBuyers: 2,
  scoutSol: 0.012,
  maxScouts: 2,
  maxScoutEntries: 40,
};

const LAMPORTS = 1e9;
/** Protocol + creator curve fee on each leg (95 + 30 bps). */
const CURVE_FEE = 0.0125;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface CoinBook {
  created: number | null;
  trades: TapeTrade[];
  entries: number;
  scoutEntries: number;
  lastExit: number;
}

interface OpenTrade {
  opened: number;
  peakValue: number;
  /** SOL spent on buys for this position, fees included. */
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastValue: number;
  scout: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const books = new Map<Pubkey, CoinBook>();
  const open = new Map<Pubkey, OpenTrade>();
  let scoutCount = 0;
  const keep = p.window + 5;

  const bookOf = (mint: Pubkey): CoinBook => {
    let b = books.get(mint);
    if (b === undefined) {
      b = { created: null, trades: [], entries: 0, scoutEntries: 0, lastExit: -1e12 };
      books.set(mint, b);
    }
    return b;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots of a book. */
  const netFlow = (b: CoinBook, now: number, w: number): number => {
    let net = 0;
    for (let i = b.trades.length - 1; i >= 0; i--) {
      const tr = b.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** The dip entry signal: run-up, healthy pullback, bounce with fresh buying. */
  const dipSignal = (b: CoinBook, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (b.created === null) return false;
    const age = now - b.created;
    if (age < p.minAge || age > p.maxAge) return false;
    const from = now - p.window;
    let startPrice = -1;
    let high = 0;
    let low = Infinity;
    let last = 0;
    for (const tr of b.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      if (tr.price > high) high = tr.price;
      if (tr.price < low) low = tr.price;
      last = tr.price;
    }
    if (startPrice <= 0 || high <= 0 || low === Infinity || last <= 0) return false;
    // The run-up: window high well above the window start.
    if (high / startPrice - 1 < p.runUp) return false;
    // The dip: last price pulled back off the high, but not collapsed.
    const dip = 1 - last / high;
    if (dip < p.dipMin || dip > p.dipMax) return false;
    // The bounce: price is ticking back up off the dip low.
    if (last < low * p.bounce) return false;
    // Fresh buying in the confirmation window, spread across wallets.
    const cFrom = now - p.confirmWindow;
    let buySol = 0;
    let net = 0;
    let buys = 0;
    const byUser = new Map<string, number>();
    for (const tr of b.trades) {
      if (tr.slot <= cFrom) continue;
      const signed = tr.buy ? tr.sol : -tr.sol;
      net += signed;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      }
    }
    if (buys < p.confirmBuys || byUser.size < p.confirmBuyers) return false;
    if (net < p.confirmNetSol) return false;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (buySol > 0 && top > p.maxBuyerShare * buySol) return false;
    return true;
  };

  /** The scout signal: a fresh short-window momentum flicker, no dip needed. */
  const scoutSignal = (b: CoinBook, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (b.created === null) return false;
    const age = now - b.created;
    if (age < 10 || age > p.maxAge) return false;
    const from = now - p.scoutWindow;
    let startPrice = -1;
    let last = 0;
    let net = 0;
    let buys = 0;
    const byUser = new Set<string>();
    for (const tr of b.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      net += signed;
      if (tr.buy) {
        buys++;
        byUser.add(tr.user);
      }
      last = tr.price;
    }
    if (startPrice <= 0 || last <= 0) return false;
    if (last / startPrice - 1 < p.scoutMinUp) return false;
    if (net < p.scoutMinNetSol) return false;
    if (buys < p.scoutMinBuys || byUser.size < p.scoutMinBuyers) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();

      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          bookOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const b = bookOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          b.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
      // Drop tape older than the lookback so books stay small.
      for (const mint of traded) {
        const b = books.get(mint)!;
        let cut = 0;
        while (cut < b.trades.length && b.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) b.trades.splice(0, cut);
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      let sellPending = new Set<Pubkey>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
        if (po.order.side === 'sell') sellPending.add(po.order.mint);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const txSol = Number(state.txFeeLamports()) / LAMPORTS;

      /** Mark-to-market value of a position in SOL, curve fee and one tx fee deducted. */
      const markValue = (mint: Pubkey): number | null => {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined || curve === undefined) return null;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        if (vt + tokens <= 0) return null;
        return ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - txSol;
      };

      // --- Exits first: a position leaves on the first trigger that fires. ---
      for (const [mint, t] of open) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            open.delete(mint);
            if (t.scout) scoutCount--;
            const b = bookOf(mint);
            if (t.filled) b.lastExit = now;
            else b.entries--;
          }
          continue;
        }
        t.filled = true;
        if (curve === undefined || curve.complete) continue;
        const value = markValue(mint);
        if (value === null) continue;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > t.peakValue) t.peakValue = value;
        t.lastValue = value;
        const b = bookOf(mint);
        let exit = t.exiting;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && t.peakValue >= cost * (1 + p.trailArm) && value < t.peakValue * (1 - p.trail)) exit = true;
        if (!exit && netFlow(b, now, p.dryWindow) < -p.dryNetSol) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && now - t.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit) continue;
        t.exiting = true;
        if (sellPending.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
        sellPending = new Set(sellPending).add(mint);
      }

      // --- Entries and scale-ins. ---
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - [...open.values()].filter((t) => !t.scout).length;
      let exposure = 0;
      for (const [mint, t] of open) {
        exposure += Math.max(t.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint)) continue;
        const b = books.get(mint)!;
        const t = open.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        let isScout = false;
        if (t === undefined) {
          if (slotsLeft <= 0) continue;
          if (b.entries >= p.maxEntries || now - b.lastExit < p.cooldown) continue;
          if (mainLeft > 0 && dipSignal(b, now, rqSol)) {
            want = Math.min(p.initialSol, p.stakeSol);
          } else if (scoutCount < p.maxScouts && b.scoutEntries < p.maxScoutEntries && scoutSignal(b, now, rqSol)) {
            want = p.scoutSol;
            isScout = true;
          } else {
            continue;
          }
        } else {
          // Scale-in only into strength: price above the last add, position not
          // underwater, and the tape still shows net inflow. Scouts never scale.
          if (t.scout || t.exiting || !t.filled || t.invested >= p.stakeSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price <= t.lastAddPrice) continue;
          if (t.lastValue < Number(pos.cost_lamports) / LAMPORTS) continue;
          if (netFlow(b, now, p.window) < 0.2) continue;
          if (rqSol > p.maxRqSol) continue;
          want = Math.min(p.addSol, p.stakeSol - t.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - txSol) amount = free - txSol;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + txSol;
        exposure += amount;
        if (t === undefined) {
          open.set(mint, {
            opened: now,
            peakValue: 0,
            invested: amount,
            exiting: false,
            filled: false,
            lastAddPrice: price,
            lastValue: 0,
            scout: isScout,
          });
          b.entries++;
          if (isScout) {
            scoutCount++;
            b.scoutEntries++;
          }
          slotsLeft--;
          if (!isScout) mainLeft--;
        } else {
          t.invested += amount;
          t.lastAddPrice = price;
        }
      }
      return orders;
    },
  };
}
