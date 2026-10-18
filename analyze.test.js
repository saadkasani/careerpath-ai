const assert = require('assert');
const { _test, handler } = require('../netlify/functions/analyze.js');

(async () => {
  // JSON extraction from chatty text with braces inside strings
  assert.deepStrictEqual(_test.extractJson('Sure! {"a":"x } y","b":[1,2]} done'), { a: 'x } y', b: [1, 2] });
  assert.strictEqual(_test.extractJson('no json'), null);

  // Fake API: search returned only the 2 real URLs; model also invented one
  const real1 = 'https://www.rwaq.org/courses/real-one';
  const real2 = 'https://doroob.sa/gone';
  const foreign = 'https://www.coursera.org/learn/foreign';
  const fake = 'https://invented.example.com/course';
  const answer = { matchPercent: 62, summary: 's', strengths: ['a'],
    gaps: [{ skill: 'SQL', importance: 'high', why: 'w', resources: [
      { title: 'Real', provider: 'Coursera', url: real1, type: 'course', free: true },
      { title: 'Dead', provider: 'X', url: real2, type: 'course', free: false },
      { title: 'Invented', provider: 'Y', url: fake, type: 'course', free: false },
      { title: 'Plain http', provider: 'Z', url: 'http://www.rwaq.org/courses/real-one', type: 'course', free: true },
      { title: 'Foreign', provider: 'C', url: foreign, type: 'course', free: true } ] }],
    path: [{ step: 1, skill: 'SQL', action: 'learn', weeks: 4 }] };
  const fetchImpl = async (url, opts) => {
    if (url.startsWith('https://api.anthropic.com')) {
      return { ok: true, status: 200, json: async () => ({ content: [
        { type: 'web_search_tool_result', content: [{ url: real1 }, { url: real2 }, { url: foreign }] },
        { type: 'text', text: 'Here you go:\n' + JSON.stringify(answer) } ] }) };
    }
    if (url === real1) return { status: 200 };
    if (url === real2) return { status: 404 };
    if (url === foreign) return { status: 200 };
    throw new Error('network');
  };
  const out = await _test.run({ cvText: 'cv', lang: 'en' }, { apiKey: 'k', fetchImpl });
  const urls = out.gaps[0].resources.map((r) => r.url);
  assert.deepStrictEqual(urls, [real1], 'only searched + alive https Saudi-platform links survive');
  assert.ok(_test.isSaudiDomain('https://sub.tuwaiq.edu.sa/x'));
  assert.ok(!_test.isSaudiDomain('https://evil-rwaq.org.example.com/x'));
  assert.ok(!_test.isSaudiDomain('https://notrwaq.org/x'));

  // Catalog ids resolve to catalog URLs; invented ids and ended courses are dropped
  const r2 = await _test.keepRealLinks({ gaps: [{ skill: 'x', catalogIds: ['doroob-cyber', 'rwaq-python-ds', 'nope'], resources: [] }] }, new Set(), async () => ({ status: 200 }));
  assert.deepStrictEqual(r2.gaps[0].resources.map((r) => r.source), ['catalog']);
  assert.ok(r2.gaps[0].resources[0].url.includes('doroob.sa'));
  assert.ok(_test.CATALOG.every((c) => _test.isSaudiDomain(c.url)), 'catalog only has Saudi platforms');

  // Non-technical CV: model says unsupported, nothing else is returned
  const fetchNo = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '{"supported": false, "field": "Medicine"}' }] }) });
  assert.deepStrictEqual(await _test.run({ cvText: 'cv', lang: 'en' }, { apiKey: 'k', fetchImpl: fetchNo }), { supported: false, field: 'Medicine' });

  // PDF goes to the model as a document block
  const pdfB64 = Buffer.from('%PDF-1.4 fake').toString('base64');
  const c = _test.buildContent({ cvFile: { data: pdfB64 }, lang: 'ar' });
  assert.strictEqual(c.length, 2);
  assert.strictEqual(c[1].type, 'document');
  assert.strictEqual(c[1].source.media_type, 'application/pdf');
  assert.ok(c[0].text.includes('Arabic'));
  assert.strictEqual(typeof _test.buildContent({ cvText: 'x', lang: 'en' }), 'string');

  // Handler guards
  process.env.ANTHROPIC_API_KEY = 'k';
  assert.strictEqual((await handler({ httpMethod: 'GET' })).statusCode, 405);
  assert.strictEqual((await handler({ httpMethod: 'POST', body: '{}' })).statusCode, 400); // no CV at all
  const notPdf = Buffer.from('hello world').toString('base64');
  assert.strictEqual((await handler({ httpMethod: 'POST', body: JSON.stringify({ cvFile: { mime: 'application/pdf', data: notPdf } }) })).statusCode, 400);
  assert.strictEqual((await handler({ httpMethod: 'POST', body: JSON.stringify({ cvFile: { mime: 'text/html', data: pdfB64 } }) })).statusCode, 400);
  const big = Buffer.concat([Buffer.from('%PDF'), Buffer.alloc(4 * 1024 * 1024)]).toString('base64');
  assert.strictEqual((await handler({ httpMethod: 'POST', body: JSON.stringify({ cvFile: { mime: 'application/pdf', data: big } }) })).statusCode, 400);
  delete process.env.ANTHROPIC_API_KEY;
  assert.strictEqual((await handler({ httpMethod: 'POST', body: '{}' })).statusCode, 500);
  console.log('all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
