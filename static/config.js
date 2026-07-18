/**
 * Public, deploy-time configuration.
 *
 * Keep secrets out of this file: everything in `static/` is visible to every
 * visitor. Remote engine endpoints should authenticate a Replay user and keep
 * provider credentials, billing, and quotas on the server side.
 */
const defaults = {
  accountApiBase: "",
  browserReckless: {
    // A fixed node budget is more comparable and cache-safe than assuming
    // Reckless depth 12 has the same cost or strength as Stockfish depth 12.
    nodes: 50000,
  },
  remoteEngines: [
    {
      id: "lc0",
      name: "Lc0 cloud",
      tier: "plus",
      endpoint: "",
      description: "Neural-network analysis through a configured compute service.",
      sourceUrl: "https://github.com/LeelaChessZero/lc0",
      license: "GPL-3.0-or-later",
    },
    {
      id: "reckless",
      name: "Reckless cloud",
      tier: "plus",
      endpoint: "",
      description: "Reckless engine analysis through a configured compute service.",
      sourceUrl: "https://github.com/codedeliveryservice/Reckless",
      license: "AGPL-3.0",
    },
  ],
};

const overrides = globalThis.REPLAY_CONFIG || {};

export const replayConfig = Object.freeze({
  ...defaults,
  ...overrides,
  browserReckless: { ...defaults.browserReckless, ...(overrides.browserReckless || {}) },
  remoteEngines: overrides.remoteEngines || defaults.remoteEngines,
});
