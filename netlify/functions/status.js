// GET /.netlify/functions/status?id=<jobId>  ->  { status: pending|running|done|error, ... }
// A finished result is returned once and then deleted, so no CV data lingers.
const { stores } = require('./lib/store.js');

const ID = /^[A-Za-z0-9-]{16,64}$/;
const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });

async function read(jobs, id) {
  const job = await jobs.get(id, { type: 'json' }).catch(() => null);
  if (!job) return { status: 'pending' };
  if (job.status === 'done' || job.status === 'error') await jobs.delete(id).catch(() => {});
  return job;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Use GET' });
  const id = (event.queryStringParameters || {}).id;
  if (!id || !ID.test(id)) return json(400, { error: 'Bad id' });
  const { jobs } = stores(event);
  return json(200, await read(jobs, id));
};

exports._test = { read };
