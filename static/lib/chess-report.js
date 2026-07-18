import { Chess } from "../vendor/chess/chess.js";
import { createEngine } from "./engine-providers.js";
import { importGames, getGameDetail } from "./game-import.js";

const MIN_REPORT_LOSS = 180;
const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 99 };
const THEMES = {
  fork: { label: "Missed forks", slug: "fork", advice: "Practice spotting one move that attacks two targets." },
  forkVulnerability: { label: "Getting forked", slug: "fork", advice: "Before committing a move, scan every enemy knight, pawn, and queen fork." },
  discoveredAttack: { label: "Missed discovered attacks", slug: "discoveredAttack", advice: "Scan for line pieces hidden behind a movable blocker." },
  discoveredVulnerability: { label: "Discovered attacks against you", slug: "discoveredAttack", advice: "Notice when one enemy move can uncover a rook, bishop, or queen." },
  check: { label: "Checks and forcing moves", slug: "advancedPawn", advice: "Start each calculation with checks, captures, and threats." },
  hangingPiece: { label: "Loose and hanging pieces", slug: "hangingPiece", advice: "Before moving, count every undefended or newly attacked piece." },
  defensiveMove: { label: "Defensive resources", slug: "defensiveMove", advice: "Ask what your opponent threatens before choosing your plan." },
  crushing: { label: "Converting advantages", slug: "crushing", advice: "Simplify the position only when it preserves the concrete win." },
};

function score(result) {
  if (result.mate !== null) return result.mate > 0 ? 100000 - result.mate : -100000 - result.mate;
  return result.cp ?? 0;
}

function findMove(chess, uci) {
  return chess.moves({ verbose: true }).find(move => move.from === uci?.slice(0, 2) && move.to === uci?.slice(2, 4) && (!uci?.[4] || move.promotion === uci[4]));
}

function rayTargets(chess, square, color, directions) {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  const targets = [];
  for (const [df, dr] of directions) {
    let f = file + df;
    let r = rank + dr;
    while (f >= 0 && f < 8 && r >= 0 && r < 8) {
      const target = chess.get(`${String.fromCharCode(97 + f)}${r + 1}`);
      if (target) {
        if (target.color !== color) targets.push(target);
        break;
      }
      f += df;
      r += dr;
    }
  }
  return targets;
}

function attackedTargets(chess, square) {
  const piece = chess.get(square);
  if (!piece) return [];
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  const targets = [];
  const add = (f, r) => {
    if (f < 0 || f > 7 || r < 0 || r > 7) return;
    const target = chess.get(`${String.fromCharCode(97 + f)}${r + 1}`);
    if (target && target.color !== piece.color) targets.push(target);
  };
  if (piece.type === "n") for (const [df, dr] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]) add(file + df, rank + dr);
  if (piece.type === "p") for (const df of [-1, 1]) add(file + df, rank + (piece.color === "w" ? 1 : -1));
  if (["b", "q"].includes(piece.type)) targets.push(...rayTargets(chess, square, piece.color, [[1,1],[1,-1],[-1,1],[-1,-1]]));
  if (["r", "q"].includes(piece.type)) targets.push(...rayTargets(chess, square, piece.color, [[1,0],[-1,0],[0,1],[0,-1]]));
  if (piece.type === "k") for (const [df, dr] of [[1,1],[1,0],[1,-1],[0,1],[0,-1],[-1,1],[-1,0],[-1,-1]]) add(file + df, rank + dr);
  return targets;
}

function linePressure(chess, color) {
  const board = chess.board();
  let pressure = 0;
  for (let row = 0; row < board.length; row += 1) for (let column = 0; column < board[row].length; column += 1) {
    const piece = board[row][column];
    if (!piece || piece.color !== color || !["r", "b", "q"].includes(piece.type)) continue;
    const square = piece.square || `${String.fromCharCode(97 + column)}${8 - row}`;
    const directions = piece.type === "r" ? [[1,0],[-1,0],[0,1],[0,-1]]
      : piece.type === "b" ? [[1,1],[1,-1],[-1,1],[-1,-1]]
      : [[1,1],[1,-1],[-1,1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
    pressure += rayTargets(chess, square, color, directions).filter(target => PIECE_VALUE[target.type] >= 3).length;
  }
  return pressure;
}

function motifFor(fen, bestUci, best, loss) {
  const chess = new Chess(fen);
  const move = findMove(chess, bestUci);
  if (!move) return "defensiveMove";
  chess.move(move);
  const valuableTargets = attackedTargets(chess, move.to).filter(piece => PIECE_VALUE[piece.type] >= 3);
  if (valuableTargets.length >= 2 || valuableTargets.some(piece => piece.type === "k") && valuableTargets.length >= 1) return "fork";
  if (move.san.includes("+") || move.san.includes("#") || best.mate > 0) return "check";
  if (!move.captured) {
    const before = new Chess(fen);
    if (linePressure(chess, move.color) > linePressure(before, move.color)) return "discoveredAttack";
  }
  if (move.captured || loss >= 350) return "hangingPiece";
  return score(best) > 250 ? "crushing" : "defensiveMove";
}

function punishmentMotif(fen, playedUci, playedResult, loss) {
  const chess = new Chess(fen);
  const playedMove = findMove(chess, playedUci);
  if (!playedMove) return null;
  chess.move(playedMove);
  const reply = playedResult.pv?.[0] === playedUci ? playedResult.pv[1] : playedResult.pv?.[0];
  if (!reply) return null;
  const motif = motifFor(chess.fen(), reply, playedResult, loss);
  if (motif === "fork") return "forkVulnerability";
  if (motif === "discoveredAttack") return "discoveredVulnerability";
  return null;
}

export async function buildChessReport({ username, source, onProgress }) {
  const imported = await importGames({ username, source, scope: "latest100" });
  if (!imported.games.length) throw new Error("No public standard games were found for that account.");
  const engine = createEngine("stockfish-browser");
  await engine.init();
  const counts = Object.fromEntries(Object.keys(THEMES).map(key => [key, 0]));
  const examples = [];
  let positions = 0;
  let mistakes = 0;
  try {
    for (let gameIndex = 0; gameIndex < imported.games.length; gameIndex += 1) {
      const game = imported.games[gameIndex];
      const detail = getGameDetail(game.id);
      const parity = game.playerColor === "white" ? 1 : 0;
      const moves = detail.moves.filter(move => move.ply % 2 === parity);
      for (let index = 0; index < moves.length; index += 1) {
        const move = moves[index];
        const fen = detail.frames[move.ply - 1].fen;
        positions += 1;
        const best = await engine.evaluate(fen);
        const matches = move.uci === best.bestmove || move.uci.slice(0, 4) === best.bestmove?.slice(0, 4);
        if (!matches && best.bestmove && best.bestmove !== "(none)") {
          const played = await engine.evaluate(fen, move.uci);
          const loss = Math.max(0, score(best) - score(played));
          if (loss >= MIN_REPORT_LOSS) {
            mistakes += 1;
            const motif = punishmentMotif(fen, move.uci, played, loss) || motifFor(fen, best.bestmove, best, loss);
            counts[motif] += 1;
            if (examples.length < 24) examples.push({
              id: `${game.id}:${move.ply}`,
              motif,
              label: THEMES[motif].label,
              fen,
              bestMove: best.bestmove,
              playedMove: move.uci,
              loss,
              opponent: game.opponent,
              date: game.date,
            });
          }
        }
        onProgress?.({ game: gameIndex + 1, games: imported.games.length, move: index + 1, moves: moves.length });
      }
    }
  } finally {
    engine.close();
  }
  const recommendations = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => ({ id, count, ...THEMES[id], url: `https://lichess.org/training/${THEMES[id].slug}` }));
  return {
    username,
    source,
    generatedAt: Date.now(),
    games: imported.games.length,
    positions,
    mistakes,
    counts,
    recommendations,
    examples,
  };
}
