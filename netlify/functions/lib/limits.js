// Daily usage caps that protect the API credit. Counters live in Netlify Blobs.
// Best effort: two requests at the same instant can slip past by one, which is fine here.
const crypto = require('crypto');

const GLOBAL_CAP = () => Number(process.env.DAILY_CAP || 100); // analyses per day, whole site
const IP_CAP = () => Number(process.env.IP_DAILY_CAP || 5);    // analyses per day, per visitor

const day = (d = new Date()) => d.toISOString().slice(0, 10);
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

function clientIp(headers = {}) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return h['x-nf-client-connection-ip'] || String(h['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}

// Returns { ok: true } and counts the use, or { ok: false, reason }.
async function checkAndCount(store, headers, now = new Date()) {
  const d = day(now);
  const gKey = `global-${d}`;
  const iKey = `ip-${hash(clientIp(headers))}-${d}`;
  const [g, i] = await Promise.all([
    store.get(gKey, { type: 'json' }).catch(() => null),
    store.get(iKey, { type: 'json' }).catch(() => null),
  ]);
  const gCount = (g && g.n) || 0;
  const iCount = (i && i.n) || 0;
  if (gCount >= GLOBAL_CAP()) return { ok: false, reason: 'global' };
  if (iCount >= IP_CAP()) return { ok: false, reason: 'ip' };
  await Promise.all([store.setJSON(gKey, { n: gCount + 1 }), store.setJSON(iKey, { n: iCount + 1 })]);
  return { ok: true };
}

module.exports = { checkAndCount, clientIp, GLOBAL_CAP, IP_CAP };
