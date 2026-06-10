// server/src/hub.js — composition root: owns the shared ingester pool.
// Per-session state (streams/aggregator/stats) lives in Room (see room.js).
import { createIngesterPool } from './ingesterPool.js';

export function createHub(poolOptions = {}) {
  const pool = createIngesterPool(poolOptions);
  return {
    pool,
    routeKickChat: (broadcasterUserId, fields) => pool.routeKickChat(broadcasterUserId, fields),
    // X broadcast chat fed by the external worker (POST /ingest/x):
    routeXChat: (broadcastId, fields) => pool.routeXChat(broadcastId, fields),
    setXViewers: (broadcastId, n) => pool.setXViewers(broadcastId, n),
    setXStatus: (broadcastId, s) => pool.setXStatus(broadcastId, s),
    setXLabel: (broadcastId, label) => pool.setXLabel(broadcastId, label),
    stopAll: () => pool.stopAll(),
  };
}
