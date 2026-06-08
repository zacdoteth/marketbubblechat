// server/src/ingesters/x.js  (parser; ingester class added in Task 14)
export function parseSearchResponse(json) {
  const users = {};
  for (const u of (json?.includes?.users || [])) users[u.id] = u;
  return (json?.data || []).map(t => ({
    id: t.id,
    username: users[t.author_id]?.username || t.author_id,
    displayName: users[t.author_id]?.name || users[t.author_id]?.username || t.author_id,
    text: t.text,
    ts: Date.parse(t.created_at) || 0,
  }));
}
