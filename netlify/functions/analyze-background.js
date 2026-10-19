// POST /.netlify/functions/analyze-background  { jobId, cvFile|cvText, lang }
// Netlify answers 202 straight away and lets this function run for minutes.
// The result is saved in the "jobs" store and read by /.netlify/functions/status.
const { run, parseRequest } = require('./analyze.js');
const { checkAndCount } = require('./lib/limits.js');
const { stores } = require('./lib/store.js');

const ID = /^[A-Za-z0-9-]{16,64}$/;

async function process_(req, headers, { jobs, limits, apiKey, runFn = run }) {
  const id = req.jobId;
  await jobs.setJSON(id, { status: 'running' });
  try {
    const gate = await checkAndCount(limits, headers);
    if (!gate.ok) return jobs.setJSON(id, { status: 'error', code: 'limit', reason: gate.reason });
    const result = await runFn(req, { apiKey });
    await jobs.setJSON(id, { status: 'done', result });
  } catch (e) {
    console.error('[analyze-background] failed:', e && e.message);
    await jobs.setJSON(id, { status: 'error', code: 'failed' });
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '' };
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const { jobs, limits } = stores(event);
  let req = parseRequest(event.body);
  const id = (() => { try { return JSON.parse(event.body).jobId; } catch { return null; } })();
  if (!id || !ID.test(String(id))) return { statusCode: 400, body: '' };
  if (req.error) { await jobs.setJSON(id, { status: 'error', code: 'bad', message: req.error }); return { statusCode: 400, body: '' }; }
  req = { ...req, jobId: id };
  if (!apiKey) { await jobs.setJSON(id, { status: 'error', code: 'failed' }); return { statusCode: 500, body: '' }; }
  await process_(req, event.headers, { jobs, limits, apiKey });
  return { statusCode: 200, body: '' };
};

exports._test = { process_ };
