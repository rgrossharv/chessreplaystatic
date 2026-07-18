import { Chess } from "../vendor/chess/chess.js";
import { createEngine, engineDescriptor, isEngineCancellation } from "./engine-providers.js";

const PIECES = ["wK", "wQ", "wR", "wB", "wN", "wP", "bK", "bQ", "bR", "bB", "bN", "bP"];

function uci(move) {
  return `${move.from}${move.to}${move.promotion || ""}`;
}

function findMove(chess, moveUci) {
  return chess.moves({ verbose: true }).find(move => uci(move) === moveUci || uci(move).slice(0, 4) === moveUci.slice(0, 4) && !moveUci[4]);
}

function resultText(result) {
  if (result.mate !== null) return result.mate > 0 ? `Mate in ${result.mate}` : `Mated in ${Math.abs(result.mate)}`;
  const pawns = (result.cp || 0) / 100;
  return `${pawns >= 0 ? "+" : "−"}${Math.abs(pawns).toFixed(2)}`;
}

function pvToSan(fen, pv) {
  const chess = new Chess(fen);
  const line = [];
  for (const moveUci of pv.slice(0, 12)) {
    const move = findMove(chess, moveUci);
    if (!move) break;
    line.push(move.san);
    chess.move({ from: move.from, to: move.to, promotion: move.promotion });
  }
  return line.join(" ");
}

export function initAnalysisBoard({ getPieceSet, getEngineProvider, onSound = () => {} }) {
  const $ = selector => document.querySelector(selector);
  const state = {
    chess: new Chess(),
    rootFen: new Chess().fen(),
    selectedSquare: null,
    legalMoves: [],
    editorPiece: "wQ",
    editing: false,
    flipped: false,
    moves: [],
    engine: null,
    analyzing: false,
    analysisToken: 0,
  };

  function progressText({ loaded = 0, total = null }) {
    const loadedMiB = (loaded / (1024 * 1024)).toFixed(1);
    if (!total) return `${loadedMiB} MiB of the Reckless engine downloaded…`;
    return `Downloading Reckless · ${Math.round((loaded / total) * 100)}% (${loadedMiB} of ${(total / (1024 * 1024)).toFixed(1)} MiB)`;
  }

  function cancelAnalysis(message = "Analysis cancelled.") {
    ++state.analysisToken;
    state.engine?.close();
    state.engine = null;
    if (state.analyzing) $("#analysisEngineResult").textContent = message;
    state.analyzing = false;
    $("#analyzePositionButton").disabled = false;
  }

  function pieceUrl(piece) {
    return new URL(`../pieces/${getPieceSet()}/${piece}.svg`, import.meta.url).href;
  }

  function renderPalette() {
    $("#analysisPalette").innerHTML = `${PIECES.map(piece => `<button type="button" data-editor-piece="${piece}" class="${state.editorPiece === piece ? "active" : ""}" aria-label="Place ${piece}"><img src="${pieceUrl(piece)}" alt=""></button>`).join("")}<button type="button" data-editor-piece="erase" class="erase ${state.editorPiece === "erase" ? "active" : ""}">Erase</button>`;
    $("#analysisPalette").querySelectorAll("[data-editor-piece]").forEach(button => button.addEventListener("click", () => {
      state.editorPiece = button.dataset.editorPiece;
      renderPalette();
    }));
  }

  function renderNotation() {
    const fenParts = state.rootFen.split(" ");
    let color = fenParts[1] === "b" ? "b" : "w";
    let moveNumber = Number(fenParts[5]) || 1;
    const rows = new Map();
    for (const move of state.moves) {
      const row = rows.get(moveNumber) || { white: "", black: "" };
      if (color === "w") row.white = move.san;
      else row.black = move.san;
      rows.set(moveNumber, row);
      if (color === "b") moveNumber += 1;
      color = color === "w" ? "b" : "w";
    }
    const html = [...rows].map(([number, row]) => `<div><span>${number}.</span><strong>${row.white}</strong><strong>${row.black}</strong></div>`).join("");
    $("#analysisNotation").innerHTML = html || `<p>Play moves on the board to build notation.</p>`;
  }

  function renderBoard(lastMove = null) {
    const files = state.flipped ? ["h","g","f","e","d","c","b","a"] : ["a","b","c","d","e","f","g","h"];
    const ranks = state.flipped ? [1,2,3,4,5,6,7,8] : [8,7,6,5,4,3,2,1];
    const targets = new Map(state.legalMoves.map(move => [move.to, move]));
    const last = lastMove ? [lastMove.slice(0, 2), lastMove.slice(2, 4)] : [];
    const html = [];
    ranks.forEach((rank, row) => files.forEach((file, column) => {
      const square = `${file}${rank}`;
      const piece = state.chess.get(square);
      const pieceName = piece ? `${piece.color}${piece.type.toUpperCase()}` : null;
      const dark = ((file.charCodeAt(0) - 97) + rank) % 2 === 1;
      const legal = targets.get(square);
      html.push(`<button type="button" class="square analysis-square ${dark ? "dark" : ""} ${state.selectedSquare === square ? "selected" : ""} ${legal ? `legal ${legal.captured ? "capture" : ""}` : ""} ${last.includes(square) ? "last" : ""}" data-analysis-square="${square}" aria-label="${square}">
        ${column === 0 ? `<span class="coord rank">${rank}</span>` : ""}${row === 7 ? `<span class="coord file">${file}</span>` : ""}
        ${pieceName ? `<img class="piece-image" src="${pieceUrl(pieceName)}" alt="" draggable="false">` : ""}
      </button>`);
    }));
    $("#analysisBoard").innerHTML = html.join("");
    $("#analysisBoard").querySelectorAll("[data-analysis-square]").forEach(button => button.addEventListener("click", () => handleSquare(button.dataset.analysisSquare)));
    $("#analysisFen").value = state.chess.fen();
    $("#analysisTurn").value = state.chess.turn();
    renderNotation();
  }

  function resetMoveSelection() {
    state.selectedSquare = null;
    state.legalMoves = [];
  }

  function editSquare(square) {
    cancelAnalysis("Position changed — analysis cancelled.");
    if (state.editorPiece === "erase") state.chess.remove(square);
    else if (!state.chess.put({ color: state.editorPiece[0], type: state.editorPiece[1].toLowerCase() }, square)) {
      $("#analysisBoardError").textContent = "A position can contain only one king of each color.";
      return;
    }
    $("#analysisBoardError").textContent = "";
    state.rootFen = state.chess.fen();
    state.moves = [];
    resetMoveSelection();
    renderBoard();
  }

  function handleSquare(square) {
    if (state.editing) return editSquare(square);
    const piece = state.chess.get(square);
    if (!state.selectedSquare) {
      if (!piece || piece.color !== state.chess.turn()) return;
      state.selectedSquare = square;
      state.legalMoves = state.chess.moves({ square, verbose: true });
      return renderBoard();
    }
    const move = state.legalMoves.find(candidate => candidate.to === square);
    if (move) {
      cancelAnalysis("Position changed — analysis cancelled.");
      const played = state.chess.move({ from: move.from, to: move.to, promotion: move.promotion || "q" });
      state.moves.push({ san: played.san, uci: uci(played) });
      resetMoveSelection();
      $("#analysisEngineResult").textContent = "Position changed — analyze when ready.";
      onSound("move");
      return renderBoard(uci(played));
    }
    if (piece?.color === state.chess.turn()) {
      state.selectedSquare = square;
      state.legalMoves = state.chess.moves({ square, verbose: true });
    } else resetMoveSelection();
    renderBoard();
  }

  function loadFen(value) {
    try {
      const nextPosition = new Chess(value.trim());
      cancelAnalysis("Position changed — analysis cancelled.");
      state.chess = nextPosition;
      state.rootFen = state.chess.fen();
      state.moves = [];
      resetMoveSelection();
      renderBoard();
      $("#analysisBoardError").textContent = "";
    } catch (error) {
      $("#analysisBoardError").textContent = error.message || "Enter a valid FEN position.";
    }
  }

  async function analyze() {
    if (state.analyzing) return;
    state.analyzing = true;
    const token = ++state.analysisToken;
    const button = $("#analyzePositionButton");
    button.disabled = true;
    const descriptor = engineDescriptor(getEngineProvider());
    $("#analysisEngineResult").textContent = `${descriptor.name} is thinking…`;
    try {
      const kings = state.chess.board().flat().filter(piece => piece?.type === "k");
      if (kings.filter(piece => piece.color === "w").length !== 1 || kings.filter(piece => piece.color === "b").length !== 1) throw new Error("Add exactly one white king and one black king before analysis.");
      state.engine?.close();
      state.engine = createEngine(descriptor.id);
      const fen = state.chess.fen();
      const removeProgress = state.engine.onProgress?.(progress => {
        if (token === state.analysisToken) $("#analysisEngineResult").textContent = progressText(progress);
      });
      try { await state.engine.init(); }
      finally { removeProgress?.(); }
      const result = await state.engine.evaluate(fen);
      if (token !== state.analysisToken || state.chess.fen() !== fen) return;
      $("#analysisEngineEval").textContent = resultText(result);
      $("#analysisEngineLine").textContent = pvToSan(fen, result.pv) || result.bestmove;
      $("#analysisEngineResult").textContent = `${descriptor.name} · depth ${result.depth || "—"}`;
    } catch (error) {
      if (token === state.analysisToken && !isEngineCancellation(error)) {
        $("#analysisEngineResult").textContent = error.message || "Analysis failed.";
      }
    } finally {
      state.analyzing = false;
      button.disabled = false;
    }
  }

  $("#analysisEditButton").addEventListener("click", () => {
    state.editing = !state.editing;
    $("#analysisEditButton").classList.toggle("active", state.editing);
    $("#analysisEditButton").textContent = state.editing ? "Finish editing" : "Edit position";
    $("#analysisEditor").classList.toggle("hidden", !state.editing);
    $(".engine-analysis-card").classList.toggle("hidden", state.editing);
    $(".notation-analysis-card").classList.toggle("hidden", state.editing);
    if (!state.editing) {
      state.rootFen = state.chess.fen();
      state.moves = [];
    }
    resetMoveSelection();
    renderBoard();
  });
  $("#analysisResetButton").addEventListener("click", () => {
    cancelAnalysis("Position reset — analysis cancelled.");
    state.chess = new Chess();
    state.rootFen = state.chess.fen();
    state.moves = [];
    onSound("move");
    renderBoard();
  });
  $("#analysisUndoButton").addEventListener("click", () => {
    if (!state.moves.length) return;
    cancelAnalysis("Position changed — analysis cancelled.");
    state.chess.undo();
    state.moves.pop();
    resetMoveSelection();
    onSound("move");
    renderBoard();
  });
  $("#analysisFlipButton").addEventListener("click", () => { state.flipped = !state.flipped; renderBoard(); });
  $("#analysisClearButton").addEventListener("click", () => {
    cancelAnalysis("Position changed — analysis cancelled.");
    state.chess.clear();
    state.moves = [];
    resetMoveSelection();
    renderBoard();
  });
  $("#analysisLoadFenButton").addEventListener("click", () => loadFen($("#analysisFen").value));
  $("#analysisTurn").addEventListener("change", event => {
    const parts = state.chess.fen().split(" ");
    parts[1] = event.currentTarget.value;
    loadFen(parts.join(" "));
  });
  $("#analyzePositionButton").addEventListener("click", analyze);

  renderPalette();
  renderBoard();
  return {
    refresh: () => { renderPalette(); renderBoard(); },
    cancel: () => cancelAnalysis("Engine changed — analysis cancelled."),
    close: () => cancelAnalysis(),
  };
}
