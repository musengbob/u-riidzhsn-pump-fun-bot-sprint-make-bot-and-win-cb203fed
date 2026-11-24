# Dip Runner — Pump.fun Bot Sprint

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/musengbob/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/musengbob/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A paper-trading bot for the [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) bounty on [make.fun](https://make.fun). It trades 10 SOL of paper money on a replay of pump.fun bonding-curve activity. Nothing is traded for real.

## Strategy

Buy the second wind: a young curve that ran up 25%+, pulled back 8–30% off
its high, and then shows fresh buying from several wallets while the price
ticks back up off the dip low. First buy 0.03 SOL, scale-ins to 0.15 SOL only
while the tape keeps confirming.

Exit fast — take-profit +25%, stop-loss −12%, a 12% trailing stop once up 8%,
a flow-dry exit, and a 600-slot hold limit. Small 0.012 SOL scout positions on
fresh momentum flickers keep the entry above the 20-coin / 0.01 SOL round-trip
bar. See [STRATEGY.md](STRATEGY.md) for the full notes.

## Run

The grader runs `node main.ts` (Node 22+, no dependencies, no install). The bot
speaks `agent-fun/replay/v2` on stdin/stdout via the shim in
`vendor/makefun-bot.ts`. It is fully deterministic: no clock, no environment,
no randomness.

A synthetic replay smoke test lives in `test/smoke.mjs` — run it with
`node test/smoke.mjs`. It feeds the bot a fabricated tape (run-up, dip,
second wind, take-profit), checks the replies are valid and deterministic
across two runs, and reports the fills.

## License

MIT — see [LICENSE](LICENSE).
