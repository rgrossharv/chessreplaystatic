import assert from "node:assert/strict";
import test from "node:test";
import { Chess } from "../static/vendor/chess/chess.js";
import { buildChessReport } from "../static/lib/chess-report.js";

function reportFixture() {
  const chess = new Chess();
  const frames = [{ fen: chess.fen() }];
  const moves = [];
  for (const uci of ["f2f3", "e7e5", "g2g4"]) {
    const played = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) });
    moves.push({ ply: moves.length + 1, uci, san: played.san, fen: chess.fen() });
    frames.push({ fen: chess.fen() });
  }
  return {
    imported: { games: [{ id: "report-game", playerColor: "white", opponent: "Fixture", date: "Jul 18, 2026" }] },
    detail: { frames, moves },
  };
}

test("report counts losses at 180 cp, ignores 179 cp, reports progress, and closes its engine", async () => {
  const { imported, detail } = reportFixture();
  const firstFen = detail.frames[0].fen;
  const secondFen = detail.frames[2].fen;
  const calls = [];
  let closed = false;
  const progress = [];
  const engine = {
    async init() {},
    async evaluate(fen, searchMoves = null) {
      const constrained = Array.isArray(searchMoves) ? searchMoves[0] : searchMoves;
      calls.push({ fen, constrained });
      if (constrained === "f2f3") return { bestmove: "f2f3", depth: 12, cp: -150, mate: null, pv: ["f2f3", "e7e5"] };
      if (constrained === "g2g4") return { bestmove: "g2g4", depth: 12, cp: -129, mate: null, pv: ["g2g4", "d8h4"] };
      if (fen === firstFen) return { bestmove: "e2e4", depth: 12, cp: 30, mate: null, pv: ["e2e4"] };
      if (fen === secondFen) return { bestmove: "d2d4", depth: 12, cp: 50, mate: null, pv: ["d2d4"] };
      throw new Error("Unexpected report position");
    },
    close() { closed = true; },
  };
  const report = await buildChessReport({
    username: "Fixture",
    source: "pgn",
    importedGames: imported,
    gameDetail: () => detail,
    engineFactory: id => {
      assert.equal(id, "stockfish-browser");
      return engine;
    },
    onProgress: value => progress.push(value),
  });
  assert.equal(report.games, 1);
  assert.equal(report.positions, 2);
  assert.equal(report.mistakes, 1);
  assert.equal(report.examples.length, 1);
  assert.equal(report.examples[0].loss, 180);
  assert.equal(calls.length, 4);
  assert.equal(progress.length, 2);
  assert.equal(closed, true);
});

test("report gives an explicit error for an empty imported set", async () => {
  await assert.rejects(buildChessReport({
    username: "Nobody",
    source: "pgn",
    importedGames: { games: [] },
  }), /No standard chess games/);
});

test("report labels a single mating attack as a check instead of a fork and describes mate cleanly", async () => {
  const chess = new Chess();
  chess.move("f3");
  chess.move("e5");
  const fen = chess.fen();
  const played = chess.move("g4");
  const detail = {
    frames: [{ fen }],
    moves: [{ ply: 1, uci: `${played.from}${played.to}`, san: played.san, fen: chess.fen() }],
  };
  const engine = {
    async init() {},
    async evaluate(_fen, searchMoves = null) {
      if (searchMoves) return { bestmove: "g2g4", depth: 12, cp: null, mate: -1, pv: ["g2g4", "d8h4"] };
      return { bestmove: "d2d4", depth: 12, cp: 40, mate: null, pv: ["d2d4"] };
    },
    close() {},
  };
  const report = await buildChessReport({
    username: "Fixture",
    source: "pgn",
    importedGames: { games: [{ id: "mate-game", playerColor: "white", opponent: "Mate", date: "Imported game" }] },
    gameDetail: () => detail,
    engineFactory: () => engine,
  });
  assert.equal(report.examples[0].motif, "check");
  assert.equal(report.examples[0].consequence, "allowed mate in 1");
});

test("report evaluates only the studied player's moves when that player has Black", async () => {
  const chess = new Chess();
  const frames = [{ fen: chess.fen() }];
  const moves = [];
  for (const uci of ["e2e4", "e7e5", "g1f3", "b8c6"]) {
    const played = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) });
    moves.push({ ply: moves.length + 1, uci, san: played.san, fen: chess.fen() });
    frames.push({ fen: chess.fen() });
  }
  const expected = new Map([
    [frames[1].fen, "e7e5"],
    [frames[3].fen, "b8c6"],
  ]);
  const calls = [];
  let closed = false;
  const engine = {
    async init() {},
    async evaluate(fen, searchMoves = null) {
      calls.push({ fen, searchMoves });
      const bestmove = expected.get(fen);
      assert.ok(bestmove, `unexpected position ${fen}`);
      return { bestmove, depth: 12, cp: 20, mate: null, pv: [bestmove] };
    },
    close() { closed = true; },
  };
  const report = await buildChessReport({
    username: "Black Fixture",
    source: "pgn",
    importedGames: { games: [{ id: "black-game", playerColor: "black", opponent: "White Fixture", date: "Imported game" }] },
    gameDetail: () => ({ frames, moves }),
    engineFactory: () => engine,
  });
  assert.equal(report.positions, 2);
  assert.equal(report.mistakes, 0);
  assert.deepEqual(calls.map(call => call.fen), [frames[1].fen, frames[3].fen]);
  assert.ok(calls.every(call => call.searchMoves === null));
  assert.equal(closed, true);
});

test("report always closes Stockfish when evaluation fails", async () => {
  const { imported, detail } = reportFixture();
  let closed = false;
  const engine = {
    async init() {},
    async evaluate() { throw new Error("engine stopped"); },
    close() { closed = true; },
  };
  await assert.rejects(buildChessReport({
    username: "Fixture",
    source: "pgn",
    importedGames: imported,
    gameDetail: () => detail,
    engineFactory: () => engine,
  }), /engine stopped/);
  assert.equal(closed, true);
});
