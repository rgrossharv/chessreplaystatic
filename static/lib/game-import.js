import { Chess } from "../vendor/chess/chess.js";

const WEEK_SECONDS = 7 * 24 * 60 * 60;
const records = new Map();
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function cleanUsername(value) {
  const username = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{2,30}$/.test(username)) {
    throw new Error("Enter a valid Chess.com or Lichess username.");
  }
  return username;
}

async function fetchResponse(url, accept) {
  let response;
  try {
    response = await fetch(url, { headers: accept ? { Accept: accept } : undefined });
  } catch {
    throw new Error("Could not reach the game service. Check your internet connection.");
  }
  if (response.ok) return response;
  if (response.status === 404) throw new Error("That username was not found.");
  if (response.status === 429) throw new Error("The game service is rate-limiting requests. Wait a minute and try again.");
  throw new Error(`The game service returned an error (${response.status}).`);
}

async function fetchJson(url) {
  return (await fetchResponse(url, "application/json")).json();
}

async function fetchText(url) {
  return (await fetchResponse(url, "application/x-chess-pgn")).text();
}

function resultForUser(result, isWhite) {
  if (result === "1/2-1/2") return "Draw";
  if ((result === "1-0" && isWhite) || (result === "0-1" && !isWhite)) return "Win";
  if (result === "1-0" || result === "0-1") return "Loss";
  return "—";
}

function parsePgn(pgn) {
  const chess = new Chess();
  try {
    chess.loadPgn(pgn);
  } catch {
    return null;
  }
  return chess;
}

async function stableId(seed) {
  if (globalThis.crypto?.subtle) {
    const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
    return [...new Uint8Array(bytes)].slice(0, 8).map(value => value.toString(16).padStart(2, "0")).join("");
  }
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function openingName(headers) {
  const ecoUrl = headers.ECOUrl || "";
  if (ecoUrl) {
    const slug = ecoUrl.replace(/\/$/, "").split("/").pop() || "";
    return decodeURIComponent(slug).replaceAll("-", " ");
  }
  return headers.Opening || headers.ECO || "Unknown opening";
}

function rating(value) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function lichessTimeClass(headers) {
  const event = (headers.Event || "").toLowerCase();
  return ["ultrabullet", "bullet", "blitz", "rapid", "classical", "correspondence"]
    .find(name => event.includes(name))?.replace(/^./, char => char.toUpperCase()) || "Game";
}

function splitPgnGames(blob) {
  const starts = [...blob.matchAll(/^\[Event\s+"/gm)].map(match => match.index);
  return starts.map((start, index) => blob.slice(start, starts[index + 1] ?? blob.length).trim()).filter(Boolean);
}

function pgnTimestamp(headers) {
  const date = headers.UTCDate || headers.Date || "";
  const time = headers.UTCTime || "00:00:00";
  const parsed = Date.parse(`${date.replaceAll(".", "-")}T${time}Z`);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function remember(record) {
  records.set(record.id, record);
  return record.summary;
}

async function chessComRecord(raw, username) {
  if (!raw.pgn || (raw.rules && raw.rules !== "chess")) return null;
  const parsed = parsePgn(raw.pgn);
  if (!parsed) return null;
  const headers = parsed.getHeaders();
  const white = raw.white || {};
  const black = raw.black || {};
  const isWhite = String(white.username || "").toLowerCase() === username.toLowerCase();
  const player = isWhite ? white : black;
  const opponent = isWhite ? black : white;
  const id = await stableId(`chesscom:${raw.url || ""}:${raw.pgn}`);
  const ended = Number(raw.end_time) || null;
  const summary = {
    id,
    opponent: opponent.username || "Unknown",
    opponentRating: rating(opponent.rating),
    playerRating: rating(player.rating),
    playerColor: isWhite ? "white" : "black",
    result: resultForUser(headers.Result || "*", isWhite),
    date: ended ? dateFormatter.format(new Date(ended * 1000)) : (headers.Date || "").replaceAll(".", "-"),
    timeClass: String(raw.time_class || "game").replace(/^./, char => char.toUpperCase()),
    timeControl: raw.time_control || "",
    opening: openingName(headers),
    endTime: ended,
    source: "chesscom",
  };
  return { id, username, pgn: raw.pgn, url: raw.url || "", summary };
}

async function importChessCom(username, latestLimit = null) {
  const base = `https://api.chess.com/pub/player/${encodeURIComponent(username.toLowerCase())}`;
  const archives = (await fetchJson(`${base}/games/archives`)).archives || [];
  if (!archives.length) return { games: [], window: "Last 7 days" };

  const cutoff = Math.floor(Date.now() / 1000) - WEEK_SECONDS;
  const rawGames = [];
  for (const archiveUrl of [...archives].reverse()) {
    const monthGames = (await fetchJson(archiveUrl)).games || [];
    rawGames.push(...[...monthGames].reverse());
    const oldest = Math.min(...monthGames.map(game => Number(game.end_time) || Number.POSITIVE_INFINITY));
    if (latestLimit ? rawGames.length >= latestLimit : rawGames.length >= 20 && oldest < cutoff) break;
  }

  const recent = rawGames.filter(game => Number(game.end_time) >= cutoff);
  const usingRecent = recent.length > 0 && latestLimit === null;
  const selected = latestLimit !== null ? rawGames.slice(0, latestLimit) : (usingRecent ? recent.slice(0, 100) : rawGames.slice(0, 20));
  const games = [];
  for (const raw of selected) {
    const record = await chessComRecord(raw, username);
    if (record) games.push(remember(record));
  }
  return { games, window: usingRecent ? "Last 7 days" : `Latest ${latestLimit || 20} games` };
}

async function importLichess(username, latestLimit = null) {
  const cutoffMs = Date.now() - WEEK_SECONDS * 1000;
  const params = new URLSearchParams({
    max: String(latestLimit || 100),
    opening: "true",
    moves: "true",
    clocks: "false",
    evals: "false",
  });
  if (latestLimit === null) params.set("since", String(cutoffMs));
  const base = `https://lichess.org/api/games/user/${encodeURIComponent(username)}`;
  let pgns = splitPgnGames(await fetchText(`${base}?${params}`));
  let usingRecent = pgns.length > 0 && latestLimit === null;
  if (!pgns.length && latestLimit === null) {
    params.delete("since");
    params.set("max", "20");
    pgns = splitPgnGames(await fetchText(`${base}?${params}`));
    usingRecent = false;
  }

  const games = [];
  for (const pgn of pgns.slice(0, usingRecent ? 100 : (latestLimit || 20))) {
    const parsed = parsePgn(pgn);
    if (!parsed) continue;
    const headers = parsed.getHeaders();
    if (!["Standard", "From Position", undefined].includes(headers.Variant)) continue;
    const whiteName = headers.White || "Unknown";
    const blackName = headers.Black || "Unknown";
    const isWhite = whiteName.toLowerCase() === username.toLowerCase();
    const ended = pgnTimestamp(headers);
    const id = await stableId(`lichess:${headers.Site || ""}:${pgn}`);
    const summary = {
      id,
      opponent: isWhite ? blackName : whiteName,
      opponentRating: rating(headers[isWhite ? "BlackElo" : "WhiteElo"]),
      playerRating: rating(headers[isWhite ? "WhiteElo" : "BlackElo"]),
      playerColor: isWhite ? "white" : "black",
      result: resultForUser(headers.Result || "*", isWhite),
      date: ended ? dateFormatter.format(new Date(ended * 1000)) : (headers.UTCDate || headers.Date || "").replaceAll(".", "-"),
      timeClass: lichessTimeClass(headers),
      timeControl: headers.TimeControl || "",
      opening: headers.Opening || headers.ECO || "Unknown opening",
      endTime: ended,
      source: "lichess",
    };
    remember({ id, username, pgn, url: headers.Site || "", summary });
    games.push(summary);
  }
  return { games, window: usingRecent ? "Last 7 days" : `Latest ${latestLimit || 20} games` };
}

export async function importGames({ username: rawUsername, source = "chesscom", scope = "recent" }) {
  const username = cleanUsername(rawUsername);
  const latestLimit = scope === "latest100" ? 100 : scope === "latest" ? 20 : null;
  records.clear();
  if (source === "chesscom") return importChessCom(username, latestLimit);
  if (source === "lichess") return importLichess(username, latestLimit);
  throw new Error("Choose Chess.com or Lichess as the game source.");
}

export function getGameDetail(id) {
  const record = records.get(id);
  if (!record) throw new Error("Game not found. Import your games again.");
  const parsed = parsePgn(record.pgn);
  if (!parsed) throw new Error("That game could not be parsed.");
  const headers = parsed.getHeaders();
  const replay = headers.FEN ? new Chess(headers.FEN) : new Chess();
  const frames = [{ fen: replay.fen(), lastMove: null, san: null, ply: 0 }];
  const moves = parsed.history({ verbose: true }).map((move, index) => {
    const played = replay.move({ from: move.from, to: move.to, promotion: move.promotion });
    const uci = `${move.from}${move.to}${move.promotion || ""}`;
    const item = { fen: replay.fen(), lastMove: uci.slice(0, 4), san: played.san, ply: index + 1, uci };
    frames.push(item);
    return item;
  });
  return { summary: record.summary, frames, moves, url: record.url };
}
