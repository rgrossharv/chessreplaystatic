import { replayConfig } from "../config.js";

export const SEARCH_DEPTH = 12;

const browserDescriptor = {
  id: "stockfish-browser",
  name: "Stockfish 18",
  detail: "Runs privately in this browser",
  tier: "free",
  configured: true,
  fingerprint: "stockfish-18-lite-single:depth-12",
};

export function engineDescriptors() {
  return [
    browserDescriptor,
    ...replayConfig.remoteEngines.map(engine => ({
      ...engine,
      detail: engine.description,
      tier: engine.tier || "plus",
      configured: Boolean(engine.endpoint),
      fingerprint: `${engine.id}:${engine.version || "remote-v1"}:depth-12`,
    })),
  ];
}

export function engineDescriptor(id) {
  return engineDescriptors().find(engine => engine.id === id) || browserDescriptor;
}

class BrowserStockfish {
  constructor() {
    this.descriptor = browserDescriptor;
    this.worker = new Worker(new URL("../vendor/stockfish/stockfish-18-lite-single.js", import.meta.url));
    this.waiters = [];
    this.pending = null;
    this.worker.onmessage = event => this.onMessage(String(event.data ?? ""));
    this.worker.onerror = error => {
      if (this.pending) this.pending.reject(new Error("Stockfish could not start in this browser."));
      console.error(error);
    };
  }

  send(command) { this.worker.postMessage(command); }

  waitFor(token, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Stockfish timed out waiting for ${token}.`)), timeout);
      this.waiters.push({ token, resolve: value => { clearTimeout(timer); resolve(value); } });
    });
  }

  async init() {
    this.send("uci");
    await this.waitFor("uciok");
    this.send("setoption name Hash value 32");
    this.send("isready");
    await this.waitFor("readyok");
  }

  onMessage(payload) {
    for (const line of payload.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
      const waiter = this.waiters.find(item => line.includes(item.token));
      if (waiter) {
        this.waiters = this.waiters.filter(item => item !== waiter);
        waiter.resolve(line);
      }
      if (!this.pending) continue;
      if (line.startsWith("info ") && line.includes(" score ")) {
        const parsed = parseInfo(line);
        if (parsed && parsed.depth >= this.pending.result.depth) this.pending.result = parsed;
      }
      if (line.startsWith("bestmove ")) {
        const bestmove = line.split(/\s+/)[1];
        const pending = this.pending;
        this.pending = null;
        pending.resolve({ ...pending.result, bestmove });
      }
    }
  }

  evaluate(fen, searchMoves = null) {
    return new Promise((resolve, reject) => {
      if (this.pending) return reject(new Error("Stockfish received overlapping searches."));
      this.pending = { resolve, reject, result: { depth: 0, cp: 0, mate: null, pv: [] } };
      this.send(`position fen ${fen}`);
      const moves = Array.isArray(searchMoves) ? searchMoves.join(" ") : searchMoves;
      this.send(`go depth ${SEARCH_DEPTH}${moves ? ` searchmoves ${moves}` : ""}`);
    });
  }

  close() {
    this.send("quit");
    this.worker.terminate();
  }
}

class RemoteEngine {
  constructor(descriptor) {
    this.descriptor = descriptor;
  }

  async init() {
    if (!this.descriptor.endpoint) throw new Error(`${this.descriptor.name} is not configured yet.`);
  }

  async evaluate(fen, searchMoves = null) {
    const token = sessionStorage.getItem("replay:engine-access-token");
    const response = await fetch(this.descriptor.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ fen, searchMoves: searchMoves ? (Array.isArray(searchMoves) ? searchMoves : String(searchMoves).split(/\s+/)) : null, limit: { depth: SEARCH_DEPTH } }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `${this.descriptor.name} analysis failed.`);
    return normalizeResult(data);
  }

  close() {}
}

function normalizeResult(data) {
  const result = data.result || data;
  if (typeof result.bestmove !== "string") throw new Error("The remote engine returned an invalid result.");
  return {
    depth: Number(result.depth) || 0,
    cp: result.cp == null ? null : Number(result.cp),
    mate: result.mate == null ? null : Number(result.mate),
    pv: Array.isArray(result.pv) ? result.pv.map(String) : [],
    bestmove: result.bestmove,
  };
}

function parseInfo(line) {
  const depth = Number(line.match(/\bdepth (\d+)/)?.[1] || 0);
  const score = line.match(/\bscore (cp|mate) (-?\d+)/);
  if (!score) return null;
  const pvText = line.match(/\bpv (.+)$/)?.[1] || "";
  return {
    depth,
    cp: score[1] === "cp" ? Number(score[2]) : null,
    mate: score[1] === "mate" ? Number(score[2]) : null,
    pv: pvText.split(/\s+/).filter(Boolean),
  };
}

export function createEngine(id = browserDescriptor.id) {
  const descriptor = engineDescriptor(id);
  return descriptor.id === browserDescriptor.id ? new BrowserStockfish() : new RemoteEngine(descriptor);
}
