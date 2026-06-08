// server/src/aggregator.js
export function createAggregator({ max = 100 } = {}) {
  let seq = 0;
  const buf = [];
  return {
    push(msg) {
      msg.seq = ++seq;
      buf.push(msg);
      while (buf.length > max) buf.shift();
      return msg;
    },
    recent() { return buf.slice(); },
    get size() { return buf.length; },
  };
}
