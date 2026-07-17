/**
 * Public, deploy-time configuration.
 *
 * Keep secrets out of this file: everything in `static/` is visible to every
 * visitor. Remote engine endpoints should authenticate a Replay user and keep
 * provider credentials, billing, and quotas on the server side.
 */
const defaults = {
  accountApiBase: "",
  remoteEngines: [
    {
      id: "lc0",
      name: "Lc0 cloud",
      endpoint: "",
      description: "Neural-network analysis through a configured compute service.",
    },
    {
      id: "reckless",
      name: "Reckless cloud",
      endpoint: "",
      description: "Reckless engine analysis through a configured compute service.",
    },
  ],
};

const overrides = globalThis.REPLAY_CONFIG || {};

export const replayConfig = Object.freeze({
  ...defaults,
  ...overrides,
  remoteEngines: overrides.remoteEngines || defaults.remoteEngines,
});
