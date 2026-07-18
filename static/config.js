/**
 * Public, deploy-time configuration.
 *
 * Keep secrets out of this file: everything in `static/` is visible to every
 * visitor. Remote engine endpoints should authenticate a Replay user and keep
 * provider credentials, billing, and quotas on the server side.
 */
const defaults = {
  accountApiBase: "",
  firebase: null,
  firebaseSdkVersion: "12.16.0",
  browserEngines: {
    reckless: {
      enabled: false,
      assetBaseUrl: "./vendor/reckless/",
    },
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
  browserEngines: {
    ...defaults.browserEngines,
    ...(overrides.browserEngines || {}),
  },
  remoteEngines: overrides.remoteEngines || defaults.remoteEngines,
});
