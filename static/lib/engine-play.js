import { Chess } from "../vendor/chess/chess.js";
import { replayConfig } from "../config.js";
import { createEngine } from "./engine-providers.js";

const FILES = "abcdefgh";

export function initEnginePlay({ getPieceSet, getTheme, onSound, onSnapshot }) {
  const board = document.querySelector("#playBoard");
  const status = document.querySelector("#playStatus");
  const engineSelect = document.querySelector("#playEngine");
  const colorSelect = document.querySelector("#playColor");
  const recklessOption = engineSelect.querySelector('option[value="reckless"]');
  if (!replayConfig.browserEngines?.reckless?.enabled) {
    recklessOption.disabled = true;
    recklessOption.textContent = "Reckless browser · unavailable";
  }
  const state = {
    chess: new Chess(),
    engine: null,
    engineId: engineSelect.value,
    humanColor: colorSelect.value,
    selected: null,
    legal: [],
    busy: false,
    startedAt: Date.now(),
  };

  function orientedSquares() {
    const ranks = state.humanColor === "b" ? [1,2,3,4,5,6,7,8] : [8,7,6,5,4,3,2,1];
    const files = state.humanColor === "b" ? [...FILES].reverse() : [...FILES];
    return ranks.flatMap(rank => files.map(file => `${file}${rank}`));
  }

  function pieceImage(piece) {
    if (!piece) return "";
    return `./pieces/${getPieceSet()}/${piece.color}${piece.type.toUpperCase()}.svg`;
  }

  function render() {
    const last = state.chess.history({ verbose: true }).at(-1);
    board.innerHTML = orientedSquares().map(square => {
      const piece = state.chess.get(square);
      const file = FILES.indexOf(square[0]);
      const rank = Number(square[1]);
      const dark = (file + rank) % 2 === 1;
      const legal = state.legal.find(move => move.to === square);
      return `<button class="square ${dark ? "dark" : ""} ${state.selected === square ? "selected" : ""} ${legal ? `legal ${legal.captured ? "capture" : ""}` : ""} ${last && (last.from === square || last.to === square) ? "last" : ""}" data-play-square="${square}" aria-label="${square}${piece ? ` ${piece.color === "w" ? "white" : "black"} ${piece.type}` : ""}">${piece ? `<img class="piece-image" draggable="true" data-play-piece="${square}" src="${pieceImage(piece)}" alt="">` : ""}</button>`;
    }).join("");
    board.querySelectorAll("[data-play-square]").forEach(square => {
      square.addEventListener("click", () => chooseSquare(square.dataset.playSquare));
      square.addEventListener("dragover", event => event.preventDefault());
      square.addEventListener("drop", event => {
        event.preventDefault();
        const from = event.dataTransfer.getData("text/plain");
        if (from) attemptMove(from, square.dataset.playSquare);
      });
    });
    board.querySelectorAll("[data-play-piece]").forEach(piece => piece.addEventListener("dragstart", event => {
      event.dataTransfer.setData("text/plain", piece.dataset.playPiece);
    }));
  }

  function chooseSquare(square) {
    if (state.busy || state.chess.isGameOver() || state.chess.turn() !== state.humanColor) return;
    if (state.selected && state.legal.some(move => move.to === square)) return attemptMove(state.selected, square);
    const piece = state.chess.get(square);
    if (!piece || piece.color !== state.humanColor) {
      state.selected = null;
      state.legal = [];
    } else {
      state.selected = square;
      state.legal = state.chess.moves({ square, verbose: true });
    }
    render();
  }

  function attemptMove(from, to) {
    if (state.busy || state.chess.turn() !== state.humanColor) return;
    const candidate = state.chess.moves({ square: from, verbose: true }).find(move => move.to === to);
    if (!candidate) return chooseSquare(to);
    const move = state.chess.move({ from, to, promotion: candidate.promotion || "q" });
    state.selected = null;
    state.legal = [];
    onSound?.(move.captured ? "reveal" : "move");
    afterMove();
  }

  function describeResult() {
    if (state.chess.isCheckmate()) return state.chess.turn() === state.humanColor ? "Checkmate — the engine wins." : "Checkmate — you win!";
    if (state.chess.isDraw()) return "Draw.";
    return state.chess.inCheck() ? "Check." : state.chess.turn() === state.humanColor ? "Your move." : "Engine thinking…";
  }

  function snapshot() {
    const history = state.chess.history();
    return {
      id: `${state.startedAt}:${state.engineId}`,
      engine: state.engineId,
      humanColor: state.humanColor,
      startedAt: state.startedAt,
      updatedAt: Date.now(),
      fen: state.chess.fen(),
      pgn: state.chess.pgn(),
      moves: history.length,
      complete: state.chess.isGameOver(),
      result: state.chess.isCheckmate() ? (state.chess.turn() === state.humanColor ? "loss" : "win") : state.chess.isDraw() ? "draw" : "active",
    };
  }

  function afterMove() {
    render();
    status.textContent = describeResult();
    onSnapshot?.(snapshot());
    if (!state.chess.isGameOver() && state.chess.turn() !== state.humanColor) engineMove();
  }

  async function makeAdapter() {
    if (state.engineId === "reckless" && !replayConfig.browserEngines?.reckless?.enabled) {
      throw new Error("Reckless browser is unavailable on this deployment.");
    }
    const providerId = state.engineId === "reckless" ? "reckless-browser" : state.engineId === "stockfish" ? "stockfish-browser" : null;
    if (!providerId) throw new Error("That engine is not available in this deployment.");
    const engine = createEngine(providerId);
    const removeProgress = engine.onProgress?.(({ loaded = 0, total = null }) => {
      const loadedMiB = (loaded / (1024 * 1024)).toFixed(1);
      status.textContent = total
        ? `Downloading Reckless alpha · ${Math.round((loaded / total) * 100)}% (${loadedMiB} of ${(total / (1024 * 1024)).toFixed(1)} MiB)`
        : `Downloading Reckless alpha · ${loadedMiB} MiB received`;
    });
    try { await engine.init(); }
    finally { removeProgress?.(); }
    return {
      bestMove: async fen => (await engine.evaluate(fen)).bestmove,
      close: () => engine.close(),
    };
  }

  async function engineMove() {
    state.busy = true;
    status.textContent = `${state.engineId === "reckless" ? "Reckless" : "Stockfish"} is thinking…`;
    render();
    try {
      if (!state.engine) state.engine = await makeAdapter();
      const best = await state.engine.bestMove(state.chess.fen());
      const candidate = state.chess.moves({ verbose: true }).find(move => `${move.from}${move.to}${move.promotion || ""}` === best || `${move.from}${move.to}` === best?.slice(0, 4));
      if (!candidate) throw new Error("The engine did not return a legal move.");
      state.chess.move(candidate);
      onSound?.(candidate.captured ? "reveal" : "move");
    } catch (error) {
      status.textContent = error.message;
      state.engine?.close();
      state.engine = null;
      state.busy = false;
      render();
      return;
    }
    state.busy = false;
    afterMove();
  }

  function reset() {
    state.engine?.close();
    state.engine = null;
    state.engineId = engineSelect.value;
    state.humanColor = colorSelect.value;
    state.chess = new Chess();
    state.selected = null;
    state.legal = [];
    state.busy = false;
    state.startedAt = Date.now();
    render();
    afterMove();
  }

  engineSelect.addEventListener("change", reset);
  colorSelect.addEventListener("change", reset);
  document.querySelector("#playNewGame").addEventListener("click", reset);
  document.querySelector("#playResign").addEventListener("click", () => {
    if (state.chess.isGameOver()) return;
    status.textContent = "Game resigned. Start a new game when you are ready.";
    state.busy = true;
    const value = snapshot();
    value.complete = true;
    value.result = "resigned";
    onSnapshot?.(value);
    render();
  });

  render();
  afterMove();
  return {
    refresh() { board.closest(".board-shell").className = `board-shell play-board-shell theme-${getTheme()}`; render(); },
    close() { state.engine?.close(); },
  };
}
