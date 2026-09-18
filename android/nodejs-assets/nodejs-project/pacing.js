// Plain-JS copy of shared-ui/src/pacing/pacing.ts's randomInterval, kept in
// sync manually because this payload must not depend on shared-ui or
// anything beyond Baileys (crmex.md §10.4). The canonical, unit-tested
// version lives in shared-ui; this file exists only so the two
// implementations are the same few lines instead of diverging.
'use strict';

function randomInterval(minIntervalMs, maxIntervalMs) {
  if (maxIntervalMs < minIntervalMs) {
    throw new Error('pacing: maxIntervalMs must be >= minIntervalMs');
  }
  const span = maxIntervalMs - minIntervalMs;
  return Math.floor(minIntervalMs + Math.random() * (span + 1));
}

module.exports = { randomInterval };
