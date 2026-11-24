// Dip Runner — a pump.fun bonding-curve replay bot (agent-fun/replay/v2).
// The grader runs `node main.ts` (Node 22+, no dependencies, no install).
// The strategy lives in strategy.ts; the replay shim is vendor/makefun-bot.ts.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
