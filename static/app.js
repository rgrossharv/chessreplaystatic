import { Chess } from "./vendor/chess/chess.js";
import { importGames, getGameDetail as buildGameDetail } from "./lib/game-import.js";
import { createEngine, engineDescriptor, engineDescriptors, SEARCH_DEPTH } from "./lib/engine-providers.js";
import { activateDeviceProfile, clearProfileSession, continueAsGuest, createDeviceProfile, listDeviceProfiles, restoreProfileSession } from "./lib/profile-store.js";

const ANALYSIS_VERSION = 7;
const MIN_LOSS = 300;
const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_PREFS = {
  siteTheme: "light",
  theme: "brown",
  pieces: "cburnett",
  effectsEnabled: true,
  masterVolume: .65,
  engineProvider: "stockfish-browser",
};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const assetUrl = path => new URL(path, import.meta.url).href;

const state = {
  appUser: null,
  guest: false,
  username: "",
  displayName: "",
  source: "chesscom",
  scope: "recent",
  games: [],
  window: "Last 7 days",
  selectedIds: new Set(),
  details: new Map(),
  puzzles: [],
  current: null,
  puzzleChess: null,
  selectedSquare: null,
  legalMoves: [],
  phase: "idle",
  prefs: { ...DEFAULT_PREFS },
  sessionSeen: new Set(),
  analyzing: false,
  pointerDrag: null,
  suppressClick: false,
  practiceEngine: null,
  practiceEnginePromise: null,
  practiceQueue: Promise.resolve(),
  wrongEvalToken: 0,
  audioContext: null,
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function identityKey() { return state.appUser?.id || "guest"; }
function analysisKey() { return `replay:analysis:${state.source}:${state.username.toLowerCase()}`; }
function scheduleKey() { return `replay:schedule:${identityKey()}:${state.source}:${state.username.toLowerCase()}`; }
function prefsKey() { return `replay:prefs:${identityKey()}`; }

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { showToast("Browser storage is full; this session will still work."); }
}

$("#importForm").addEventListener("submit", async event => {
  event.preventDefault();
  const username = $("#username").value.trim();
  const button = event.currentTarget.querySelector("button");
  await startStudy(username, $("#gameSource").value, "recent", username, button);
});

async function startStudy(username, source, scope = "recent", displayName = username, button = null) {
  $("#heroError").textContent = "";
  if (button) button.disabled = true;
  const buttonLabel = button?.querySelector("span:first-child");
  if (buttonLabel) buttonLabel.textContent = "Loading games…";
  try {
    const data = await importGames({ username, source, scope });
    if (!data.games.length) throw new Error("No public games were found for that account.");
    state.username = username;
    state.displayName = displayName;
    state.source = source;
    state.scope = scope;
    state.games = data.games;
    state.window = data.window;
    state.details.clear();
    state.selectedIds = new Set(data.games.map(game => game.id));
    localStorage.setItem("replay:last-user", username);
    enterTrainer();
    await buildDeck();
  } catch (error) {
    $("#heroError").textContent = error.message;
    goHome();
  } finally {
    if (button) button.disabled = false;
    if (buttonLabel) buttonLabel.textContent = "Build deck";
  }
}

function enterTrainer() {
  document.body.classList.add("puzzle-room");
  $("#hero").classList.add("hidden");
  $("#trainer").classList.remove("hidden");
  $("#navTraining").classList.remove("hidden");
  setActiveNav("training");
  $("#deckTitle").textContent = `${state.displayName || state.username}'s mistake`;
  $("#gameWindow").textContent = state.window;
  $("#gamesCount").textContent = state.games.length;
  applyPreferences();
  renderGamePicker();
  updateStats();
}

function setActiveNav(name) {
  $$(".nav-item").forEach(item => item.classList.toggle("active", item.id === `nav${name[0].toUpperCase()}${name.slice(1)}`));
}

function goHome() {
  document.body.classList.remove("puzzle-room");
  $("#trainer").classList.add("hidden");
  $("#hero").classList.remove("hidden");
  setActiveNav("home");
}

async function buildDeck(force = false) {
  if (state.analyzing) return;
  const selectedGames = state.games.filter(game => state.selectedIds.has(game.id));
  if (!selectedGames.length) return showToast("Select at least one game.");
  state.analyzing = true;
  state.puzzles = [];
  state.sessionSeen.clear();
  const provider = engineDescriptor(state.prefs.engineProvider);
  showAnswer("thinking");
  $("#thinkingEngine").textContent = provider.name;
  $("#thinkingDetail").textContent = provider.id === "stockfish-browser" ? "Your browser is evaluating the selected games." : "Your configured compute service is evaluating the selected games.";
  $("#analysisBanner").classList.remove("hidden");
  $("#analysisProgress").style.width = "0%";
  $("#analysisTitle").textContent = `Preparing ${provider.name}…`;
  $("#analysisDetail").textContent = provider.detail;

  const cache = loadJson(analysisKey(), { version: ANALYSIS_VERSION, games: {} });
  if (cache.version !== ANALYSIS_VERSION) Object.assign(cache, { version: ANALYSIS_VERSION, games: {} });
  let engine = null;
  let finished = 0;
  try {
    for (const game of selectedGames) {
      const detail = await getGameDetail(game.id);
      const cached = cache.games[game.id];
      let gamePuzzles = !force && cached?.engine === provider.fingerprint ? cached.puzzles : null;
      if (!gamePuzzles) {
        if (!engine) {
          engine = createEngine(provider.id);
          await engine.init();
        }
        $("#analysisTitle").textContent = `${provider.name} · finding mistakes vs ${game.opponent}`;
        gamePuzzles = await analyzeGameInBrowser(engine, detail, game, (current, total) => {
          $("#analysisDetail").textContent = `Move ${current} of ${total} · depth ${SEARCH_DEPTH}`;
        });
        cache.games[game.id] = { engine: provider.fingerprint, analyzedAt: Date.now(), puzzles: gamePuzzles };
        saveJson(analysisKey(), cache);
      }
      state.puzzles.push(...gamePuzzles);
      finished += 1;
      $("#analysisProgress").style.width = `${Math.round((finished / selectedGames.length) * 100)}%`;
    }
    state.puzzles.sort((a, b) => b.loss - a.loss);
    $("#engineName").textContent = `${provider.name} · analysis ready`;
    updateStats();
    if (state.puzzles.length) await showNextPuzzle();
    else showAnswer("empty");
  } catch (error) {
    console.error(error);
    showAnswer("welcome");
    showToast(error.message || "Browser analysis failed.");
  } finally {
    engine?.close();
    state.analyzing = false;
    $("#analysisBanner").classList.add("hidden");
  }
}

async function getGameDetail(id) {
  if (!state.details.has(id)) state.details.set(id, buildGameDetail(id));
  return state.details.get(id);
}

async function analyzeGameInBrowser(engine, detail, game, onProgress) {
  const playerPlyParity = game.playerColor === "white" ? 1 : 0;
  const playerMoves = detail.moves.filter(move => move.ply % 2 === playerPlyParity);
  const puzzles = [];
  for (let index = 0; index < playerMoves.length; index += 1) {
    const move = playerMoves[index];
    const fen = detail.frames[move.ply - 1].fen;
    onProgress(index + 1, playerMoves.length);
    const best = await engine.evaluate(fen);
    if (!best.bestmove || best.bestmove === "(none)") continue;
    const playedMatchesBest = move.uci === best.bestmove || move.uci.slice(0, 4) === best.bestmove.slice(0, 4) && !best.bestmove[4];
    const bestValue = scoreValue(best);
    const position = new Chess(fen);
    const bestMoveInfo = findVerboseMove(position, best.bestmove);
    const bestSan = bestMoveInfo?.san || best.bestmove;

    if (!playedMatchesBest) {
      const played = await engine.evaluate(fen, move.uci);
      const loss = Math.max(0, bestValue - scoreValue(played));
      const missedMate = best.mate !== null && best.mate > 0 && !(played.mate !== null && played.mate > 0);
      if (missedMate || loss >= MIN_LOSS) {
        let category = "Blunder";
        if (missedMate) category = "Missed mate";
        else if (bestValue >= 300) category = "Missed win";
        puzzles.push(makePuzzle(game, move, fen, category, loss, best, bestSan, played, engine.descriptor));
      }
    }

  }
  return puzzles;
}

function makePuzzle(game, move, fen, category, loss, best, bestSan, played, provider) {
  return {
    id: `${game.id}:${move.ply}:${category.toLowerCase().replaceAll(" ", "-")}`,
    gameId: game.id,
    ply: move.ply,
    moveNumber: Math.ceil(move.ply / 2),
    fen,
    category,
    loss: Math.min(loss, 100000),
    best: best.bestmove,
    bestSan,
    bestEval: formatEval(best),
    bestPv: pvToSan(fen, best.pv),
    played: move.uci,
    playedSan: move.san,
    playedEval: formatEval(played),
    engineName: provider?.name || "Engine",
    game: { ...game },
  };
}

function scoreValue(result) {
  if (result.mate !== null) return result.mate > 0 ? 100000 - result.mate * 100 : -100000 - result.mate * 100;
  return result.cp ?? 0;
}

function formatEval(result) {
  if (result.mate !== null) return result.mate > 0 ? `Mate in ${result.mate}` : `Mated in ${Math.abs(result.mate)}`;
  const pawns = (result.cp ?? 0) / 100;
  return `${pawns >= 0 ? "+" : "−"}${Math.abs(pawns).toFixed(1)}`;
}

function findVerboseMove(chess, uci) {
  return chess.moves({ verbose: true }).find(move => move.from === uci.slice(0, 2) && move.to === uci.slice(2, 4) && (!uci[4] || move.promotion === uci[4]));
}

function pvToSan(fen, pv) {
  const chess = new Chess(fen);
  const san = [];
  for (const uci of pv.slice(0, 8)) {
    const move = findVerboseMove(chess, uci);
    if (!move) break;
    san.push(move.san);
    chess.move(move);
  }
  return san.join(" ");
}

function schedule() { return loadJson(scheduleKey(), {}); }

function updateStats() {
  const cards = schedule();
  const now = Date.now();
  $("#puzzleCount").textContent = state.puzzles.length;
  $("#dueCount").textContent = state.puzzles.filter(puzzle => !cards[puzzle.id] || cards[puzzle.id].due <= now).length;
  $("#profileReviews").textContent = Object.values(cards).reduce((sum, card) => sum + (card.reviews || 0), 0);
  $("#profileMastered").textContent = Object.values(cards).filter(card => card.interval >= 21).length;
  $("#profileStreak").textContent = state.puzzles.filter(puzzle => !cards[puzzle.id] || cards[puzzle.id].due <= now).length;
}

async function showNextPuzzle() {
  if (!state.puzzles.length) return showAnswer("empty");
  const cards = schedule();
  const now = Date.now();
  let candidates = state.puzzles
    .filter(puzzle => !state.sessionSeen.has(puzzle.id))
    .sort((a, b) => (cards[a.id]?.due || 0) - (cards[b.id]?.due || 0));
  if (!candidates.length) {
    state.sessionSeen.clear();
    candidates = [...state.puzzles].sort((a, b) => (cards[a.id]?.due || 0) - (cards[b.id]?.due || 0));
  }
  const due = candidates.filter(puzzle => !cards[puzzle.id] || cards[puzzle.id].due <= now);
  state.current = due[0] || candidates[0];
  state.sessionSeen.add(state.current.id);
  await loadPuzzle(state.current);
}

async function loadPuzzle(puzzle) {
  state.phase = "puzzle";
  state.selectedSquare = null;
  state.legalMoves = [];
  state.puzzleChess = new Chess(puzzle.fen);
  clearArrows();
  renderBoard();
  showAnswer("puzzle");
  setBoardMessage("Select a piece, then choose its destination.");
  const category = $("#puzzleCategory");
  category.textContent = "Your move";
  category.className = "category";
  $("#puzzlePrompt").textContent = "Find the best move in this position";
  $("#puzzleOpponent").textContent = `vs ${puzzle.game.opponent}`;
  $("#puzzleMeta").textContent = `${puzzle.game.date} · ${puzzle.game.timeClass} · move ${puzzle.moveNumber}`;
  $("#puzzleHint").textContent = "Look for checks, captures, and forcing threats.";
  const detail = await getGameDetail(puzzle.gameId);
  renderNotation(detail, puzzle, false);
}

function parseFen(fen) {
  const map = new Map();
  fen.split(" ")[0].split("/").forEach((row, rowIndex) => {
    let file = 0;
    for (const char of row) {
      if (/\d/.test(char)) file += Number(char);
      else {
        map.set(`${String.fromCharCode(97 + file)}${8 - rowIndex}`, char);
        file += 1;
      }
    }
  });
  return map;
}

function renderBoard(lastMove = null) {
  const fen = state.puzzleChess?.fen() || "8/8/8/8/8/8/8/8 w - - 0 1";
  const pieces = parseFen(fen);
  const flipped = state.current?.game.playerColor === "black";
  const files = flipped ? ["h","g","f","e","d","c","b","a"] : ["a","b","c","d","e","f","g","h"];
  const ranks = flipped ? [1,2,3,4,5,6,7,8] : [8,7,6,5,4,3,2,1];
  const legalTargets = new Map(state.legalMoves.map(move => [move.to, move]));
  const lastSquares = lastMove ? [lastMove.slice(0,2), lastMove.slice(2,4)] : [];
  const html = [];
  ranks.forEach((rank, row) => files.forEach((file, column) => {
    const square = `${file}${rank}`;
    const piece = pieces.get(square);
    const fileIndex = file.charCodeAt(0) - 97;
    const dark = (fileIndex + rank) % 2 === 1;
    const legal = legalTargets.get(square);
    const pieceName = piece ? `${piece === piece.toUpperCase() ? "w" : "b"}${piece.toUpperCase()}` : null;
    html.push(`<button class="square ${dark ? "dark" : ""} ${state.selectedSquare === square ? "selected" : ""} ${legal ? `legal ${legal.captured ? "capture" : ""}` : ""} ${lastSquares.includes(square) ? "last" : ""}" data-square="${square}" aria-label="${square}">
      ${column === 0 ? `<span class="coord rank">${rank}</span>` : ""}${row === 7 ? `<span class="coord file">${file}</span>` : ""}
      ${pieceName ? `<img class="piece-image" draggable="false" src="${assetUrl(`./pieces/${state.prefs.pieces}/${pieceName}.svg`)}" alt="">` : ""}
    </button>`);
  }));
  $("#board").innerHTML = html.join("");
  $$("#board .square").forEach(square => square.addEventListener("click", () => handleSquare(square.dataset.square)));
  $$("#board .piece-image").forEach(piece => piece.addEventListener("pointerdown", startPointerDrag));
}

function handleSquare(square) {
  if (state.suppressClick || state.phase !== "puzzle" || !state.puzzleChess) return;
  const clickedPiece = state.puzzleChess.get(square);
  if (!state.selectedSquare) {
    if (!clickedPiece || clickedPiece.color !== state.puzzleChess.turn()) return;
    selectSquare(square);
    return;
  }
  if (square === state.selectedSquare) {
    state.selectedSquare = null;
    state.legalMoves = [];
    return renderBoard();
  }
  const candidate = state.legalMoves.find(move => move.to === square);
  if (candidate) {
    attemptMove(state.selectedSquare, square);
    return;
  }
  if (clickedPiece?.color === state.puzzleChess.turn()) selectSquare(square);
}

function attemptMove(from, to) {
  if (state.phase !== "puzzle" || !state.puzzleChess) return false;
  const moves = state.puzzleChess.moves({ square: from, verbose: true });
  const candidate = moves.find(move => move.to === to);
  if (!candidate) return false;
  const move = state.puzzleChess.move({ from, to, promotion: candidate.promotion || "q" });
  state.selectedSquare = null;
  state.legalMoves = [];
  renderBoard(`${move.from}${move.to}`);
  checkAttempt(move);
  return true;
}

function selectSquare(square) {
  state.selectedSquare = square;
  state.legalMoves = state.puzzleChess.moves({ square, verbose: true });
  renderBoard();
}

function startPointerDrag(event) {
  if (state.phase !== "puzzle" || !state.puzzleChess || event.button > 0) return;
  const squareElement = event.currentTarget.closest(".square");
  const square = squareElement?.dataset.square;
  const piece = square && state.puzzleChess.get(square);
  if (!piece || piece.color !== state.puzzleChess.turn()) return;
  state.pointerDrag = {
    from: square,
    startX: event.clientX,
    startY: event.clientY,
    x: event.clientX,
    y: event.clientY,
    source: event.currentTarget,
    dragging: false,
    ghost: null,
  };
}

function movePointerDrag(event) {
  const drag = state.pointerDrag;
  if (!drag) return;
  drag.x = event.clientX;
  drag.y = event.clientY;
  if (!drag.dragging && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) > 6) {
    drag.dragging = true;
    state.selectedSquare = drag.from;
    state.legalMoves = state.puzzleChess.moves({ square: drag.from, verbose: true });
    drag.source.classList.add("dragging");
    drag.ghost = drag.source.cloneNode(true);
    drag.ghost.className = "drag-ghost";
    const size = drag.source.getBoundingClientRect().width;
    drag.ghost.style.width = `${size}px`;
    drag.ghost.style.height = `${size}px`;
    document.body.appendChild(drag.ghost);
    for (const move of state.legalMoves) {
      const target = document.querySelector(`[data-square="${move.to}"]`);
      target?.classList.add("legal");
      if (move.captured) target?.classList.add("capture");
    }
    document.querySelector(`[data-square="${drag.from}"]`)?.classList.add("selected");
  }
  if (drag.dragging) {
    event.preventDefault();
    drag.ghost.style.left = `${drag.x}px`;
    drag.ghost.style.top = `${drag.y}px`;
    $$("#board .drag-over").forEach(square => square.classList.remove("drag-over"));
    const target = document.elementFromPoint(drag.x, drag.y)?.closest(".square");
    if (target && state.legalMoves.some(move => move.to === target.dataset.square)) target.classList.add("drag-over");
  }
}

function endPointerDrag(event) {
  const drag = state.pointerDrag;
  if (!drag) return;
  state.pointerDrag = null;
  if (!drag.dragging) return;
  event.preventDefault();
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".square");
  drag.ghost?.remove();
  drag.source?.classList.remove("dragging");
  state.suppressClick = true;
  const moved = target && attemptMove(drag.from, target.dataset.square);
  if (!moved) {
    state.selectedSquare = null;
    state.legalMoves = [];
    renderBoard();
  }
  setTimeout(() => { state.suppressClick = false; }, 80);
}

document.addEventListener("pointermove", movePointerDrag, { passive: false });
document.addEventListener("pointerup", endPointerDrag, { passive: false });
document.addEventListener("pointercancel", endPointerDrag, { passive: false });

function checkAttempt(move) {
  const attempted = `${move.from}${move.to}${move.promotion || ""}`;
  const target = state.current.best;
  const correct = attempted === target || attempted.slice(0,4) === target.slice(0,4) && !target[4];
  if (correct) {
    playSound("correct");
    revealSolution(true);
  }
  else {
    playSound("wrong");
    state.phase = "wrong";
    setBoardMessage("Wrong move. Try the position again or reveal the solution.", "wrong");
    $("#wrongText").textContent = `${move.san} is legal, but it misses ${engineDescriptor(state.prefs.engineProvider).name}'s stronger move.`;
    $("#attemptMove").textContent = move.san;
    $("#attemptEval").textContent = `${engineDescriptor(state.prefs.engineProvider).name} is evaluating…`;
    showAnswer("wrong");
    evaluateWrongMove(attempted, move.san);
  }
}

async function getPracticeEngine() {
  if (state.practiceEngine) return state.practiceEngine;
  if (!state.practiceEnginePromise) {
    state.practiceEnginePromise = (async () => {
      const engine = createEngine(state.prefs.engineProvider);
      await engine.init();
      state.practiceEngine = engine;
      return engine;
    })().catch(error => {
      state.practiceEnginePromise = null;
      throw error;
    });
  }
  return state.practiceEnginePromise;
}

function evaluateWrongMove(uci, san) {
  const puzzleId = state.current.id;
  const fen = state.current.fen;
  const token = ++state.wrongEvalToken;
  state.practiceQueue = state.practiceQueue.then(async () => {
    const engine = await getPracticeEngine();
    const result = await engine.evaluate(fen, uci);
    if (token === state.wrongEvalToken && state.current?.id === puzzleId && state.phase === "wrong") {
      $("#attemptMove").textContent = san;
      $("#attemptEval").textContent = `${engineDescriptor(state.prefs.engineProvider).name} ${formatEval(result)}`;
    }
  }).catch(error => {
    console.error(error);
    if (token === state.wrongEvalToken && state.phase === "wrong") $("#attemptEval").textContent = "Evaluation unavailable";
  });
}

$("#tryAgainButton").addEventListener("click", () => loadPuzzle(state.current));
$("#showSolutionButton").addEventListener("click", () => { playSound("reveal"); revealSolution(false); });

function revealSolution(correct) {
  state.phase = "solution";
  state.puzzleChess = new Chess(state.current.fen);
  const bestInfo = findVerboseMove(state.puzzleChess, state.current.best);
  if (bestInfo) state.puzzleChess.move(bestInfo);
  renderBoard(state.current.best);
  clearArrows();
  drawArrow(state.current.best, "#2d7a55");
  setBoardMessage(correct ? "Correct. Review the engine line, then grade the position." : "Solution shown. Review it, then grade the position.", "correct");
  $("#solutionIcon").textContent = correct ? "✓" : "→";
  const categoryClass = state.current.category.toLowerCase().replaceAll(" ", "-");
  $("#puzzleCategory").textContent = state.current.category;
  $("#puzzleCategory").className = `category ${categoryClass}`;
  $("#solutionKicker").textContent = `${correct ? "Correct" : "Solution"} · ${state.current.category}`;
  $("#solutionTitle").textContent = correct ? "That is the move." : "This was the stronger move.";
  $("#playedLabel").textContent = "Played in the game";
  $("#bestLabel").textContent = "Best move";
  $("#playedMove").textContent = state.current.playedSan;
  const providerName = state.current.engineName || engineDescriptor(state.prefs.engineProvider).name;
  $("#playedEval").textContent = `${providerName} ${state.current.playedEval}`;
  $("#bestMove").textContent = state.current.bestSan;
  $("#bestEval").textContent = `${providerName} ${state.current.bestEval}`;
  $("#solutionEngineLabel").textContent = `${providerName} continuation`;
  $("#solutionLine").textContent = state.current.bestPv || state.current.bestSan;
  showAnswer("solution");
  renderNotation(state.details.get(state.current.gameId), state.current, true);
}

function clearArrows() { $("#arrows").innerHTML = ""; }

function drawArrow(uci, color) {
  const flipped = state.current.game.playerColor === "black";
  const point = square => {
    const file = square.charCodeAt(0) - 97;
    const rank = Number(square[1]) - 1;
    return { x: (flipped ? 7 - file : file) * 100 + 50, y: (flipped ? rank : 7 - rank) * 100 + 50 };
  };
  const start = point(uci.slice(0,2)), end = point(uci.slice(2,4));
  $("#arrows").innerHTML = `<defs><marker id="best-arrow" markerWidth="5" markerHeight="5" refX="3.5" refY="2.5" orient="auto"><path d="M0,0 L0,5 L5,2.5 z" fill="${color}"/></marker></defs><line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" stroke="${color}" stroke-width="17" stroke-linecap="round" opacity=".84" marker-end="url(#best-arrow)"/>`;
}

function setBoardMessage(text, type = "") {
  $("#boardMessageText").textContent = text;
  $("#boardMessage").className = `board-message ${type}`;
}

function showAnswer(name) {
  for (const panel of ["welcome", "thinking", "puzzle", "wrong", "solution", "empty"]) {
    $(`#${panel}Panel`).classList.toggle("hidden", panel !== name);
  }
}

function renderNotation(detail, puzzle, revealed) {
  if (!detail) return;
  const moves = detail.moves;
  const rows = [];
  for (let index = 0; index < moves.length; index += 2) {
    const white = notationCell(moves[index], puzzle, revealed);
    const black = notationCell(moves[index + 1], puzzle, revealed);
    rows.push(`<div class="notation-row"><span>${Math.floor(index / 2) + 1}.</span>${white}${black}</div>`);
  }
  $("#notationList").innerHTML = rows.join("");
  const studiedName = state.displayName || state.username;
  $("#notationGame").textContent = `${puzzle.game.playerColor === "white" ? studiedName : puzzle.game.opponent} – ${puzzle.game.playerColor === "black" ? studiedName : puzzle.game.opponent}`;
  $("#notationResult").textContent = puzzle.game.result;
  $("#notationOpening").textContent = puzzle.game.opening;
  $("#chessComLink").href = detail.url || "#";
  requestAnimationFrame(() => $("#notationList .current")?.scrollIntoView({ block: "center" }));
}

function notationCell(move, puzzle, revealed) {
  if (!move) return `<span class="notation-move"></span>`;
  if (move.ply === puzzle.ply) return `<span class="notation-move current">${revealed ? escapeHtml(move.san) : "?"}</span>`;
  if (move.ply > puzzle.ply && !revealed) return `<span class="notation-move">·</span>`;
  return `<span class="notation-move ${move.ply < puzzle.ply ? "past" : ""}">${escapeHtml(move.san)}</span>`;
}

$$('[data-rating]').forEach(button => button.addEventListener("click", () => ratePuzzle(button.dataset.rating)));

function ratePuzzle(rating) {
  const cards = schedule();
  const old = cards[state.current.id] || { interval: 0, ease: 2.5, reviews: 0, lapses: 0 };
  const next = { ...old, reviews: old.reviews + 1 };
  if (rating === "again") {
    next.interval = 0;
    next.due = Date.now() + 10 * 60 * 1000;
    next.lapses += 1;
    state.sessionSeen.delete(state.current.id);
  } else if (rating === "hard") {
    next.interval = Math.max(1, Math.round((old.interval || 1) * 1.2));
    next.ease = Math.max(1.3, old.ease - .15);
    next.due = Date.now() + next.interval * DAY;
  } else if (rating === "easy") {
    next.interval = old.interval ? Math.max(7, Math.round(old.interval * old.ease * 1.3)) : 7;
    next.ease = old.ease + .1;
    next.due = Date.now() + next.interval * DAY;
  } else {
    next.interval = old.interval ? Math.max(3, Math.round(old.interval * old.ease)) : 3;
    next.due = Date.now() + next.interval * DAY;
  }
  cards[state.current.id] = next;
  saveJson(scheduleKey(), cards);
  updateStats();
  showNextPuzzle();
}

function renderGamePicker() {
  $("#gamePicker").innerHTML = state.games.map(game => `<label class="pick-game">
    <input type="checkbox" value="${game.id}" ${state.selectedIds.has(game.id) ? "checked" : ""}>
    <span><strong>${escapeHtml(game.opponent)}</strong><span>${escapeHtml(game.date)} · ${escapeHtml(game.timeClass)} · ${escapeHtml(game.opening)}</span></span>
    <span class="pick-result ${game.result.toLowerCase()}">${game.result}</span>
  </label>`).join("");
  $("#gamePicker").querySelectorAll("input").forEach(input => input.addEventListener("change", updateSelectedGameLabel));
  updateSelectedGameLabel();
}

function updateSelectedGameLabel() {
  $("#selectedGameCount").textContent = `${$("#gamePicker").querySelectorAll("input:checked").length} selected`;
}

$("#gamesButton").addEventListener("click", () => {
  renderGamePicker();
  $("#gamesDialog").showModal();
});

$("#selectAllGames").addEventListener("click", () => {
  const inputs = [...$("#gamePicker").querySelectorAll("input")];
  const shouldSelect = inputs.some(input => !input.checked);
  inputs.forEach(input => input.checked = shouldSelect);
  updateSelectedGameLabel();
});

$("#applyGamesButton").addEventListener("click", () => {
  state.selectedIds = new Set([...$("#gamePicker").querySelectorAll("input:checked")].map(input => input.value));
  if (!state.selectedIds.size) return showToast("Select at least one game.");
  $("#gamesDialog").close();
  buildDeck();
});

$("#startAnalysisButton").addEventListener("click", () => buildDeck(true));

function applyPreferences() {
  document.body.dataset.siteTheme = state.prefs.siteTheme || "light";
  $("#boardShell").className = `board-shell theme-${state.prefs.theme}`;
  document.body.classList.toggle("reduce-effects", !state.prefs.effectsEnabled);
  $("#effectsToggle").checked = state.prefs.effectsEnabled !== false;
  $("#masterVolume").value = Math.round((state.prefs.masterVolume ?? .65) * 100);
  $("#volumeOutput").textContent = `${$("#masterVolume").value}%`;
  $$('[data-site-theme]').forEach(button => button.classList.toggle("active", button.dataset.siteTheme === state.prefs.siteTheme));
  $$('[data-theme]').forEach(button => button.classList.toggle("active", button.dataset.theme === state.prefs.theme));
  $$('[data-pieces]').forEach(button => button.classList.toggle("active", button.dataset.pieces === state.prefs.pieces));
  $$('[data-engine-provider]').forEach(button => button.classList.toggle("active", button.dataset.engineProvider === state.prefs.engineProvider));
  const provider = engineDescriptor(state.prefs.engineProvider);
  if (!state.analyzing) $("#engineName").textContent = provider.id === "stockfish-browser" ? `${provider.name} loads in your browser` : provider.name;
  if (state.puzzleChess) renderBoard();
}

function renderEngineChoices() {
  $("#engineChoices").innerHTML = engineDescriptors().map(provider => `<button type="button" data-engine-provider="${provider.id}" ${provider.configured ? "" : "disabled"}>
    <span><strong>${escapeHtml(provider.name)}</strong><small>${escapeHtml(provider.detail || "Remote analysis")}</small></span>
    <em>${provider.configured ? (provider.id === "stockfish-browser" ? "Included" : "Configured") : "Endpoint needed"}</em>
  </button>`).join("");
  $$('[data-engine-provider]').forEach(button => button.addEventListener("click", () => {
    if (button.disabled || button.dataset.engineProvider === state.prefs.engineProvider) return;
    state.practiceEngine?.close();
    state.practiceEngine = null;
    state.practiceEnginePromise = null;
    state.prefs.engineProvider = button.dataset.engineProvider;
    savePreferences();
    showToast(`${engineDescriptor(state.prefs.engineProvider).name} selected for new analysis.`);
  }));
  applyPreferences();
}

$("#settingsButton").addEventListener("click", () => {
  applyPreferences();
  updateIdentityUI();
  $("#settingsDialog").showModal();
});

$$('[data-theme]').forEach(button => button.addEventListener("click", () => {
  state.prefs.theme = button.dataset.theme;
  saveJson(prefsKey(), state.prefs);
  applyPreferences();
}));

$$('[data-site-theme]').forEach(button => button.addEventListener("click", () => {
  state.prefs.siteTheme = button.dataset.siteTheme;
  saveJson(prefsKey(), state.prefs);
  applyPreferences();
}));

$$('[data-pieces]').forEach(button => button.addEventListener("click", () => {
  state.prefs.pieces = button.dataset.pieces;
  saveJson(prefsKey(), state.prefs);
  applyPreferences();
}));

$("#profileButton").addEventListener("click", () => {
  $("#profileDialogName").textContent = state.appUser?.username || "Guest";
  updateStats();
  $("#profileDialog").showModal();
});

$("#changeAccountButton").addEventListener("click", () => {
  $("#profileDialog").close();
  goHome();
  $("#username").focus();
});

function savePreferences() {
  saveJson(prefsKey(), state.prefs);
  applyPreferences();
}

$("#effectsToggle").addEventListener("change", event => {
  state.prefs.effectsEnabled = event.currentTarget.checked;
  savePreferences();
  if (state.prefs.effectsEnabled) playSound("move");
});

$("#masterVolume").addEventListener("input", event => {
  state.prefs.masterVolume = Number(event.currentTarget.value) / 100;
  $("#volumeOutput").textContent = `${event.currentTarget.value}%`;
  saveJson(prefsKey(), state.prefs);
});

$("#masterVolume").addEventListener("change", () => playSound("move"));
$("#testSoundButton").addEventListener("click", () => playSound("correct"));

function playSound(kind) {
  if (!state.prefs.effectsEnabled || (state.prefs.masterVolume ?? .65) <= 0) return;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  const context = state.audioContext || (state.audioContext = new AudioContextClass());
  if (context.state === "suspended") context.resume();
  const volume = Math.min(.18, (state.prefs.masterVolume ?? .65) * .18);
  const notes = kind === "correct" ? [[523, 0, .06], [659, .07, .09]]
    : kind === "wrong" ? [[190, 0, .13]]
    : kind === "reveal" ? [[330, 0, .08]] : [[440, 0, .045]];
  for (const [frequency, delay, duration] of notes) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = kind === "wrong" ? "triangle" : "sine";
    oscillator.frequency.setValueAtTime(frequency, context.currentTime + delay);
    gain.gain.setValueAtTime(0.0001, context.currentTime + delay);
    gain.gain.exponentialRampToValueAtTime(volume, context.currentTime + delay + .008);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + delay + duration);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(context.currentTime + delay);
    oscillator.stop(context.currentTime + delay + duration + .01);
  }
}

$$('[data-settings-tab]').forEach(button => button.addEventListener("click", () => {
  $$('[data-settings-tab]').forEach(tab => tab.classList.toggle("active", tab === button));
  $$('[data-settings-pane]').forEach(pane => pane.classList.toggle("hidden", pane.dataset.settingsPane !== button.dataset.settingsTab));
}));

function submitProfile(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector("button");
  const values = Object.fromEntries(new FormData(form));
  submit.disabled = true;
  $("#authError").textContent = "";
  try {
    state.appUser = createDeviceProfile(values.username);
    state.guest = false;
    loadAccountPreferences();
    updateIdentityUI();
    $("#authDialog").close();
  } catch (error) {
    $("#authError").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
}

function renderProfileChoices() {
  const profiles = listDeviceProfiles();
  $("#savedProfiles").classList.toggle("hidden", !profiles.length);
  $("#profileChoices").innerHTML = profiles.map(profile => `<button type="button" data-profile-id="${escapeHtml(profile.id)}"><span>${escapeHtml(profile.username)}</span><small>Device profile</small></button>`).join("");
  $$('[data-profile-id]').forEach(button => button.addEventListener("click", () => {
    try {
      state.appUser = activateDeviceProfile(button.dataset.profileId);
      state.guest = false;
      loadAccountPreferences();
      updateIdentityUI();
      $("#authDialog").close();
    } catch (error) {
      $("#authError").textContent = error.message;
    }
  }));
}

$("#profileForm").addEventListener("submit", submitProfile);
$("#guestButton").addEventListener("click", () => {
  state.appUser = null;
  state.guest = true;
  continueAsGuest();
  loadAccountPreferences();
  updateIdentityUI();
  $("#authDialog").close();
});

$("#authDialog").addEventListener("cancel", event => {
  if (!state.appUser && !state.guest) event.preventDefault();
});

$("#logoutButton").addEventListener("click", () => {
  state.appUser = null;
  state.guest = false;
  clearProfileSession();
  $("#settingsDialog").close();
  goHome();
  updateIdentityUI();
  renderProfileChoices();
  $("#authDialog").showModal();
});

function loadAccountPreferences() {
  state.prefs = { ...DEFAULT_PREFS, ...loadJson(prefsKey(), {}) };
  if (!engineDescriptor(state.prefs.engineProvider).configured) state.prefs.engineProvider = DEFAULT_PREFS.engineProvider;
  applyPreferences();
}

function updateIdentityUI() {
  const name = state.appUser?.username || "Guest";
  $("#profileInitial").textContent = name[0]?.toUpperCase() || "G";
  $("#profileName").textContent = name;
  $("#profileDialogName").textContent = name;
  $("#settingsAccountName").textContent = name;
  $("#settingsAccountDetail").textContent = state.appUser ? "This device profile keeps progress and preferences separate in this browser." : "Guest progress is saved only in this browser.";
  $("#logoutButton").textContent = state.appUser ? "Switch profile" : "Leave guest session";
}

const masterNames = { MagnusCarlsen: "Magnus Carlsen", Hikaru: "Hikaru Nakamura", GothamChess: "Levy Rozman", fabianocaruana: "Fabiano Caruana" };
$$('.master-card').forEach(card => card.querySelector('button').addEventListener("click", () => {
  startStudy(card.dataset.master, "chesscom", "latest", masterNames[card.dataset.master]);
}));

$("#gameSource").addEventListener("change", event => {
  $("#sourcePrefix").textContent = event.currentTarget.value === "lichess" ? "lichess.org/@/" : "chess.com/";
});

$("#brandHome").addEventListener("click", event => { event.preventDefault(); goHome(); });
$("#navHome").addEventListener("click", goHome);
$("#navMasters").addEventListener("click", () => {
  goHome();
  setActiveNav("masters");
  $("#mastersSection").scrollIntoView({ behavior: state.prefs.effectsEnabled ? "smooth" : "auto", block: "start" });
});
$("#navTraining").addEventListener("click", () => { if (state.games.length) enterTrainer(); });

$$('[data-close]').forEach(button => button.addEventListener("click", () => $(`#${button.dataset.close}`).close()));

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add("hidden"), 3200);
}

const lastUser = localStorage.getItem("replay:last-user");
if (lastUser) $("#username").value = lastUser;
const restored = restoreProfileSession();
state.appUser = restored.profile;
state.guest = restored.guest;
loadAccountPreferences();
renderEngineChoices();
renderProfileChoices();
updateIdentityUI();
if (!state.appUser && !state.guest) $("#authDialog").showModal();
renderBoard();
