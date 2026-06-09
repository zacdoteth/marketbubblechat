// server/src/hub.js — composition root: owns the shared ingester pool.
// Per-session state (streams/aggregator/stats) lives in Room (see room.js).
import { createIngesterPool } from './ingesterPool.js';

export function createHub(poolOptions = {}) {
  const pool = createIngesterPool(poolOptions);
  return {
    pool,
    routeKickChat: (broadcasterUserId, fields) => pool.routeKickChat(broadcasterUserId, fields),
    stopAll: () => pool.stopAll(),
  };
}
