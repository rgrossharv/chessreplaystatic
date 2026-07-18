import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import init, { Engine } from "../static/vendor/reckless/reckless.js";
import { parseInfoLine } from "../static/vendor/reckless/reckless-worker.js";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const SUPPLIED_FEN = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";

async function loadEngine() {
  const parts = await Promise.all(
    [0, 1, 2, 3].map((part) => readFile(new URL(`../static/vendor/reckless/reckless_bg.wasm.part${part}`, import.meta.url))),
  );
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  await init({ module_or_path: bytes });
  const engine = new Engine();
  engine.set_threads(1);
  return engine;
}

test("the pinned Reckless WASM handles positions, moves, searches, and MultiPV", async () => {
  const engine = await loadEngine();
  assert.equal(engine.fen(), START_FEN);

  engine.set_position(SUPPLIED_FEN);
  assert.equal(engine.fen(), SUPPLIED_FEN);
  engine.set_position(START_FEN);

  const beforeIllegal = engine.fen();
  engine.make_move("e2e5");
  assert.equal(engine.fen(), beforeIllegal, "illegal moves must not change the position");
  engine.make_move("e2e4");
  assert.notEqual(engine.fen(), START_FEN, "legal moves must change the position");

  const firstLines = [];
  engine.go_movetime(30, 2, (line) => {
    const parsed = parseInfoLine(line);
    if (parsed) firstLines.push(parsed);
  });
  const firstBestMove = engine.last_bestmove();
  assert.match(firstBestMove, /^[a-h][1-8][a-h][1-8][qrbn]?$/);
  assert.ok(firstLines.length > 0, "search should emit info output");
  assert.ok(firstLines.some((line) => line.multiPv === 2), "search should emit a second PV");

  const secondLines = [];
  engine.go_uci(6, 0, 1, (line) => secondLines.push(line));
  assert.ok(secondLines.some((line) => line.startsWith("info depth")));
  assert.match(engine.last_bestmove(), /^[a-h][1-8][a-h][1-8][qrbn]?$/);

  const constrainedLines = [];
  engine.set_position(START_FEN);
  engine.go_uci_searchmoves(6, 0, 1, "a2a3", (line) => constrainedLines.push(line));
  assert.ok(constrainedLines.some((line) => line.startsWith("info depth")));
  assert.equal(engine.last_bestmove(), "a2a3");
  engine.free();
});
