# Dip Runner — strategy notes

Paper-trading bot for the pump.fun bonding-curve replay (`agent-fun/replay/v2`).
Capital 10 SOL, at most 5 open positions, no shorts, no leverage.

## Entry — the second wind

A curve becomes a buy when, inside a 30-slot window:

- it is 30–1500 slots old,
- real SOL reserves are 1–80 SOL,
- the price ran up at least 25% from the window start to its window high,
- it then pulled back 8–30% off that high — a healthy dip, not a collapse —
- the price is ticking back up off the dip low (last price ≥ dip low × 1.02),
- and fresh buying confirms it in the last 8 slots: net inflow ≥ +0.15 SOL,
  ≥ 3 buys from ≥ 3 distinct wallets, with no single wallet supplying more
  than 50% of the buy SOL.

First buy is 0.03 SOL; the position is then added to (0.03 SOL per add, up to
0.15 SOL total) only while the price is above the last add, the position is
not underwater, and net inflow over the window is still positive.

## Scouts — breadth, honestly

The competition requires a ≥ 0.01 SOL round trip on at least 20 coins. Scouts
are real 0.012 SOL positions under the same exit rules as main trades (never
instant round trips): a coin showing a fresh 10-slot momentum flicker (price
up ≥ 8%, net inflow ≥ +0.1 SOL, ≥ 3 buys from ≥ 2 wallets) gets one. At most
2 scouts open at once, at most 40 scout entries per run, so fee bleed stays
bounded.

## Exits (first trigger wins, whole position)

- Take-profit +25% vs cost, stop-loss −12% vs cost.
- Trailing stop: once value reaches +8% over cost, exit if it falls 12% from peak.
- Flow dry: net SOL over the last 15 slots below −0.3 SOL.
- Any single recorded sell of 3+ SOL.
- Hold limit 600 slots, unless the position is up at least 15%.

A curve that completes is closed by the replay itself. After an exit the same
curve cools down for 150 slots and may be entered at most twice per run.

## Costs

Every leg pays the 95 bps protocol + 30 bps creator curve fee plus a 105,000
lamport transaction fee; buys are sized under the 1%-of-real-reserve cap and
the 16-orders-per-batch cap. The bot is fully deterministic: no clock, no
environment, no randomness — the same window always produces the same actions.
