require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { login, fetchReplay } = require('../lib/api');
const { getBattleInfo } = require('../lib/battle');
const { renderReplayImage } = require('../lib/render');
const { buildWinPercentReportHeadless } = require('../lib/calculator');

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0) {
    throw new Error(
      'Usage: node scripts/render-replay-local.js \'{"Pid":"<id>","T":1}\' [--odds] [--out <file.png>]'
    );
  }

  let payload = null;
  let includeOdds = false;
  let outPath = null;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--odds') {
      includeOdds = true;
      continue;
    }
    if (arg === '--out') {
      outPath = args[i + 1] || null;
      i += 1;
      continue;
    }
    if (arg.startsWith('{') && arg.endsWith('}')) {
      payload = JSON.parse(arg);
      continue;
    }
    if (!payload) {
      payload = JSON.parse(arg);
    }
  }

  if (!payload || typeof payload !== 'object') {
    throw new Error('Missing JSON payload. Example: {"Pid":"...","T":1}');
  }

  const pid = typeof payload.Pid === 'string' ? payload.Pid.trim() : '';
  const turnValue = Number(payload.T);
  const turn = Number.isFinite(turnValue) && turnValue > 0 ? Math.floor(turnValue) : 1;

  if (!pid) {
    throw new Error('Payload is missing Pid.');
  }

  return { pid, turn, includeOdds, outPath };
}

async function main() {
  const { pid, turn, includeOdds, outPath } = parseArgs(process.argv);

  // Uses credentials from .env when available; falls back to existing token behavior in lib/api.
  await login();

  const rawReplay = await fetchReplay(pid);
  if (!rawReplay.ok) {
    throw new Error(`Replay fetch failed: HTTP ${rawReplay.status}`);
  }

  const replay = await rawReplay.json();
  let buildModel = null;
  if (replay.GenesisModeModel) {
    try {
      buildModel = JSON.parse(replay.GenesisModeModel);
    } catch {
      buildModel = null;
    }
  }

  const actions = Array.isArray(replay.Actions) ? replay.Actions : [];
  const allBattles = [];
  const allCalcBattles = [];
  const allOpponentInfo = [];
  let playerName = null;

  for (const action of actions) {
    if (action?.Type === 0 && typeof action.Battle === 'string') {
      const battle = JSON.parse(action.Battle);
      allBattles.push(getBattleInfo(battle));
      allCalcBattles.push(battle);
      if (!playerName) {
        playerName = battle?.User?.DisplayName || null;
      }
    } else if (action?.Type === 1 && typeof action.Mode === 'string') {
      const mode = JSON.parse(action.Mode);
      allOpponentInfo.push(mode?.Opponents || null);
    }
  }

  if (allBattles.length === 0) {
    throw new Error('No battles found in replay.');
  }

  const endTurn = Math.min(turn, allBattles.length);
  const battles = allBattles.slice(0, endTurn);
  const calcBattles = allCalcBattles.slice(0, endTurn);
  const battleOpponentInfo = allOpponentInfo.slice(0, endTurn);

  let winPercentResults = [];
  if (includeOdds) {
    winPercentResults = await buildWinPercentReportHeadless(calcBattles, buildModel);
  }

  const maxLives = Number(buildModel?.MaxLives) || 5;
  const headerOpponentName = battles.length ? battles[0]?.opponentName || null : null;

  const imageBuffer = await renderReplayImage({
    battles,
    battleOpponentInfo,
    maxLives,
    includeOdds,
    winPercentResults,
    playerName,
    headerOpponentName
  });

  const defaultName = `replay-${pid}-turn-${endTurn}.png`;
  const filePath = path.resolve(process.cwd(), outPath || defaultName);
  fs.writeFileSync(filePath, imageBuffer);

  console.log(`Saved replay image: ${filePath}`);
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});

