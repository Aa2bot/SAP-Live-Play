require('dotenv').config();
const { login, fetchReplay } = require('../lib/api');

function parseArgs() {
  const [, , pid, turnArg, sideArg] = process.argv;
  if (!pid) {
    throw new Error('Usage: node scripts/dump-replay-pet.js <Pid> [turn] [side]');
  }
  const turn = Number(turnArg || 1);
  if (!Number.isFinite(turn) || turn <= 0) {
    throw new Error('Turn must be a positive number.');
  }
  const side = (sideArg || 'user').toLowerCase();
  if (!['user', 'opponent'].includes(side)) {
    throw new Error("Side must be 'user' or 'opponent'.");
  }
  return { pid, turn, side };
}

function findTriggerKeys(obj) {
  if (!obj || typeof obj !== 'object') {
    return [];
  }
  const matches = [];
  for (const [key, value] of Object.entries(obj)) {
    if (!Number.isFinite(value)) {
      continue;
    }
    const normalized = String(key).toLowerCase();
    const hasTrigger = normalized.includes('trigger') || normalized.includes('trig');
    const hasConsumed = normalized.includes('consum');
    const isAbbrev = ['trgc', 'trgcn', 'trc', 'trcn'].includes(normalized);
    if ((hasTrigger && hasConsumed) || isAbbrev) {
      matches.push({ key, value });
    }
  }
  return matches;
}

async function main() {
  const { pid, turn, side } = parseArgs();
  await login();
  const rawReplay = await fetchReplay(pid);
  if (!rawReplay.ok) {
    throw new Error(`Replay fetch failed: ${rawReplay.status}`);
  }
  const replay = await rawReplay.json();
  const battles = replay.Actions.filter((action) => action.Type === 0)
    .map((action) => JSON.parse(action.Battle));
  const battle = battles[turn - 1];
  if (!battle) {
    throw new Error(`Turn ${turn} not found. Total turns: ${battles.length}`);
  }

  const board = side === 'user' ? battle.UserBoard : battle.OpponentBoard;
  const pets = (board?.Mins?.Items || []).filter(Boolean);
  const output = pets.map((pet, index) => {
    return {
      index,
      pet: pet,
      triggerKeys: {
        root: findTriggerKeys(pet),
        pow: findTriggerKeys(pet?.Pow)
      }
    };
  });

  console.log(JSON.stringify({ turn, side, pets: output }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
