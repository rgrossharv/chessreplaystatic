import { Chess } from "../vendor/chess/chess.js";

const PIECE_VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
const PIECE_NAMES = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };

function uciFor(move) {
  return `${move.from}${move.to}${move.promotion || ""}`;
}

function material(chess, color) {
  return chess.board().flat().filter(Boolean).reduce((total, piece) => total + (piece.color === color ? PIECE_VALUES[piece.type] : -PIECE_VALUES[piece.type]), 0);
}

function countPieces(chess) {
  return chess.board().flat().filter(Boolean).length;
}

export function findSacrificeCandidate(fen, playedUci) {
  const before = new Chess(fen);
  const played = before.moves({ verbose: true }).find(move => uciFor(move) === playedUci || uciFor(move).slice(0, 4) === playedUci.slice(0, 4) && !playedUci[4]);
  if (!played) return null;
  const mover = before.get(played.from);
  const capturedValue = PIECE_VALUES[played.captured] || 0;
  const after = new Chess(fen);
  after.move({ from: played.from, to: played.to, promotion: played.promotion });
  const opponent = mover.color === "w" ? "b" : "w";

  const captures = after.moves({ verbose: true }).map(reply => {
    if (!reply.captured) return null;
    const victim = after.get(reply.to);
    if (!victim || victim.color !== mover.color || PIECE_VALUES[victim.type] < PIECE_VALUES.n) return null;
    const movedPiece = reply.to === played.to;
    if (!movedPiece && before.isAttacked(reply.to, opponent)) return null;
    const investment = Math.max(0, PIECE_VALUES[victim.type] - capturedValue);
    return {
      reply: uciFor(reply),
      square: reply.to,
      piece: victim.type,
      pieceName: PIECE_NAMES[victim.type],
      investment,
      movedPiece,
    };
  }).filter(Boolean).sort((a, b) => b.investment - a.investment);

  const strongest = captures[0];
  if (!strongest || strongest.investment < 140) return null;
  return {
    ...strongest,
    played,
    playedSan: played.san,
    moverColor: mover.color,
    pieceCount: countPieces(before),
    beforeMaterial: material(before, mover.color),
  };
}

export function pvMaterialInvestment(fen, pv, color) {
  const chess = new Chess(fen);
  const starting = material(chess, color);
  let largest = 0;
  for (const uci of pv.slice(0, 6)) {
    const move = chess.moves({ verbose: true }).find(candidate => uciFor(candidate) === uci || uciFor(candidate).slice(0, 4) === uci.slice(0, 4) && !uci[4]);
    if (!move) break;
    chess.move({ from: move.from, to: move.to, promotion: move.promotion });
    largest = Math.max(largest, starting - material(chess, color));
  }
  return largest;
}

export function alternativeMoves(fen, excludedUci) {
  const chess = new Chess(fen);
  return chess.moves({ verbose: true }).map(uciFor).filter(uci => uci !== excludedUci && !(uci.slice(0, 4) === excludedUci.slice(0, 4) && !excludedUci[4]));
}

export function explainBrilliancy(candidate, pvInvestment) {
  const kind = candidate.movedPiece ? `offers the ${candidate.pieceName} on ${candidate.square}` : `leaves the ${candidate.pieceName} on ${candidate.square} en prise`;
  const recovered = pvInvestment >= candidate.investment ? "and the principal variation accepts it, revealing the tactical compensation" : "while the best defense has to decline the offer";
  return `${candidate.playedSan} ${kind} ${recovered}.`;
}
