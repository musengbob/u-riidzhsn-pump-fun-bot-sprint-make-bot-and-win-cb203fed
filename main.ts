// Dip Runner — a pump.fun bonding-curve replay bot (agent-fun/replay/v2).
// The grader runs `node main.ts` (Node 22+, no dependencies, no install).
// The strategy lives in strategy.ts; the replay shim is vendor/makefun-bot.ts.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';
import type { Params } from './strategy.ts';

// Validate the strategy params before the bot starts: the stake sizes
// must be positive, the first buy must fit inside the per-position
// stake, and the exposure cap must be positive. A bad param set would
// otherwise fail silently inside the replay (orders rejected, no
// positions) instead of failing loudly here.
function resolveParams(): Params {
  const p = DEFAULT_PARAMS;
  if (p.stakeSol <= 0 || p.initialSol <= 0 || p.addSol <= 0) {
    throw new Error('Dip Runner: stakeSol, initialSol and addSol must all be positive.');
  }
  if (p.initialSol > p.stakeSol) {
    throw new Error('Dip Runner: initialSol must fit inside stakeSol.');
  }
  if (p.maxExposureSol <= 0) {
    throw new Error('Dip Runner: maxExposureSol must be positive.');
  }
  return p;
}

// Start the bot: build the Dip Runner strategy from the validated
// default params and hand it to the replay shim, which speaks
// agent-fun/replay/v2 on stdin/stdout until the harness sends done.
async function main(): Promise<void> {
  await runBot(createStrategy(resolveParams()));
}

await main();
