import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.mjs';
import { RequestBudget, proxyLookup, lookupRoute } from '../lib/upstream.mjs';
import { documentReference, previewPath, previewTarget } from '../public/lib/document-reference.mjs';
import { Api, ClientBudget, AssetCache, sniffFile } from '../public/lib/api.mjs';
import { documentDate, filterDocuments, downloadReference, downloadFilename } from '../public/lib/documents.mjs';

test('preview references are case-scoped, restricted and rebuilt on a fixed host', () => {
  const reference = documentReference('https://tsdrsec.uspto.gov/ts/cd/casedoc/sn99638920/SPE123/2/webcontent?scale=1', '99638920');
  assert.deepEqual(reference, { format: 'page', id: 'SPE123', page: '2' });
  assert.equal(previewPath(new URLSearchParams(reference), '99638920'), '/ts/cd/casedoc/sn99638920/SPE123/2/media');
  for (const url of ['https://evil.invalid/ts/cd/rawImage/99638920', 'https://tsdrapi.uspto.gov.evil.invalid/ts/cd/rawImage/99638920',
    'https://user:password@tsdrapi.uspto.gov/ts/cd/rawImage/99638920', 'http://tsdrapi.uspto.gov/ts/cd/rawImage/99638920',
    'https://tsdrapi.uspto.gov:444/ts/cd/rawImage/99638920', 'https://tsdrapi.uspto.gov/ts/cd/casedoc/sn12345678/SPE123/1/media',
    'javascript:alert(1)', 'https://tsdrapi.uspto.gov/ts/cd/casedoc/sn99638920/ID/0/media']) assert.equal(documentReference(url, '99638920'), null);
  assert.equal(previewPath(new URLSearchParams({ format: 'pdf', id: '../secret' }), '99638920'), null);
  assert.equal(lookupRoute(new URLSearchParams('sn=99638920&action=preview&format=page&id=ID&page=10001')), null);
  assert.equal(lookupRoute(new URLSearchParams('sn=99638920&action=constructor')), null);
});

test('rolling budgets reserve attempts, space binary requests and honor cross-tab timestamps', () => {
  let now = 100000; const backend = new RequestBudget(() => now);
  assert.equal(backend.reserve(true), 0); assert.equal(backend.reserve(true), 30);
  assert.equal(backend.reserve(false), 0); now += 30000;
  assert.equal(backend.reserve(true), 0); assert.equal(backend.reserve(true), 30); now += 30000;
  assert.equal(backend.reserve(true), 0);
  const store = new Map(), storage = { getItem: key => store.get(key), setItem: (key, value) => store.set(key, value) };
  const first = new ClientBudget(storage, () => now), second = new ClientBudget(storage, () => now);
  first.reserve(true); assert.equal(second.wait(true), 30); assert.throws(() => second.reserve(true));
  second.block('120'); assert.equal(first.wait(false), 120);
});

test('current CMS and TICRS asset URLs are case-scoped and do not receive the API key', async () => {
  const path = '/resting2/api/casedoc/cms/cases/99638920/DRW/00000000-0000-4000-8000-000000000001.jpg';
  const reference = documentReference('https://tmng-al.uspto.gov' + path, '99638920');
  assert.deepEqual(reference, { format: 'asset', path });
  assert.deepEqual(previewTarget(new URLSearchParams(reference), '99638920'), { url: 'https://tmng-al.uspto.gov' + path, authenticated: false, file: false });
  assert.equal(documentReference('https://tmng-al.uspto.gov' + path, '12345678'), null);
  assert.equal(documentReference('https://tmng-al.uspto.gov.evil.invalid' + path, '99638920'), null);
  assert.equal(previewTarget(new URLSearchParams({ format: 'asset', path: 'https://evil.invalid' }), '99638920'), null);
  assert.equal(previewTarget(new URLSearchParams({ format: 'asset', path: path + '?redirect=evil' }), '99638920'), null);
  const ticrs = documentReference('https://tmng-al.uspto.gov/resting2/api/casedoc/ts/cd/99638920/SPE123/2/webcontent', '99638920');
  assert.equal(ticrs.id, 'SPE123'); assert.equal(ticrs.page, '2');
  assert.equal(downloadReference({ pageCount: 1, choices: [reference] }), reference);
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://tmng-al.uspto.gov' + path);
      assert.equal(new Headers(options.headers).has('USPTO-API-KEY'), false);
      return new Response(new Uint8Array([255,216,255,224]), { headers: { 'Content-Type': 'image/jpg' } });
    };
    const limiter = new RequestBudget(); assert.equal(limiter.reserve(true), 0);
    const response = await proxyLookup(new URL('https://offline.test/api/lookup?' + new URLSearchParams({ sn: '99638920', action: 'preview', ...reference })), { TSDR_API_KEY: 'offline-fake-key' }, Date.now(), limiter);
    assert.equal(response.status, 200); assert.equal(sniffFile(new Uint8Array(await response.arrayBuffer())).extension, 'jpg');
    let browserCalls = 0;
    const client = new Api({ fetcher: async () => { browserCalls++; return new Response(new Uint8Array([255,216,255,224])); } });
    client.budget.reserve(true);
    await client.lookup('99638920', 'preview', reference);
    assert.equal(browserCalls, 1, 'public JPGs remain available during the PDF cooldown');
    assert.ok(client.budget.wait(true) > 0, 'PDF cooldown remains enforced');
  } finally { globalThis.fetch = original; }
});

test('signature detection never mistakes HTML or SVG for a displayable image', () => {
  assert.equal(sniffFile(new TextEncoder().encode('%PDF-1.4')).kind, 'pdf');
  assert.equal(sniffFile(new Uint8Array([137,80,78,71,13,10,26,10])).type, 'image/png');
  assert.equal(sniffFile(new Uint8Array([73,73,42,0])).extension, 'tiff');
  assert.equal(sniffFile(new TextEncoder().encode('<svg onload="alert(1)">')).kind, 'unsupported');
  assert.equal(sniffFile(new TextEncoder().encode('<html>Failure</html>')).kind, 'unsupported');
});

test('asset cache deduplicates concurrent loads, reuses files and rejects late results after locking', async () => {
  const cache = new AssetCache(); let calls = 0, release;
  const loader = async () => { calls++; return new Promise(resolve => { release = () => resolve({ blob: new Blob(['%PDF-test']), retrievedAt: new Date() }); }); };
  const a = cache.get('status', loader), b = cache.get('status', loader); release();
  const [asset, duplicate] = await Promise.all([a, b]); assert.equal(asset, duplicate); assert.equal(calls, 1);
  assert.equal(await cache.get('status', loader), asset); assert.equal(calls, 1);
  const pending = cache.get('other', loader); cache.clear(); release(); await assert.rejects(pending, /closed/);
  assert.equal(cache.entries.size, 0);
});

test('API honors 429 without retries and refuses oversized preview bodies', async () => {
  let calls = 0;
  const api = new Api({ fetcher: async () => { calls++; return new Response('Please wait.', { status: 429, headers: { 'Retry-After': '120' } }); } });
  await assert.rejects(api.lookup('99638920', 'status-pdf'), /wait/); assert.equal(calls, 1);
  await assert.rejects(api.lookup('99638920', 'documents'), /wait/); assert.equal(calls, 1);
  let cancelled = false;
  const large = new Api({ fetcher: async () => ({ ok: true, status: 200, headers: new Headers(), body: { getReader: () => ({
    read: async () => ({ done: false, value: { byteLength: 33 * 1024 * 1024 } }), cancel: async () => { cancelled = true; }
  }) } }) });
  await assert.rejects(large.lookup('99638920', 'status-pdf'), /too large/); assert.equal(cancelled, true);
});

test('Worker still requires authentication; session requests never contact USPTO', async () => {
  const env = { APP_PASSWORD: 'offline-testing-password-only', TSDR_API_KEY: 'offline-fake-key' };
  const denied = await worker.fetch(new Request('https://offline.test/api/lookup?sn=99638920&action=status-pdf'), env);
  assert.equal(denied.status, 401);
  const login = await worker.fetch(new Request('https://offline.test/api/login', { method: 'POST', headers: { Origin: 'https://offline.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ password: env.APP_PASSWORD }) }), env);
  assert.equal(login.status, 200); const cookie = login.headers.get('Set-Cookie').split(';')[0];
  assert.match(login.headers.get('Set-Cookie'), /Secure; HttpOnly; SameSite=Strict/);
  const session = await worker.fetch(new Request('https://offline.test/api/session', { headers: { Cookie: cookie } }), env);
  assert.equal(session.status, 200);
  const cross = await worker.fetch(new Request('https://offline.test/api/session', { headers: { Cookie: cookie, Origin: 'https://evil.invalid' } }), env);
  assert.equal(cross.status, 403);
});

test('proxy streams one fixed-host request, preserves timings and never follows redirects', async () => {
  const original = globalThis.fetch; let calls = 0, release;
  const env = { TSDR_API_KEY: 'offline-fake-key' }, clock = () => Date.now();
  try {
    globalThis.fetch = async (url, options) => {
      calls++; assert.equal(url, 'https://tsdrapi.uspto.gov/ts/cd/casedoc/sn99638920/SPE123/2/media');
      assert.equal(options.redirect, 'manual'); assert.equal(options.headers['USPTO-API-KEY'], env.TSDR_API_KEY);
      return new Response(new ReadableStream({ start(controller) { release = () => { controller.enqueue(new Uint8Array([137,80,78,71,13,10,26,10])); controller.close(); }; } }), { headers: { 'Content-Type': 'image/png' } });
    };
    const url = new URL('https://offline.test/api/lookup?sn=99638920&action=preview&format=page&id=SPE123&page=2');
    const response = await proxyLookup(url, env, Date.now(), new RequestBudget(clock));
    assert.equal(calls, 1); assert.equal(response.headers.get('Content-Disposition'), 'inline');
    assert.match(response.headers.get('Server-Timing'), /uspto;dur=\d+/); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const body = response.arrayBuffer(); release(); assert.equal((await body).byteLength, 8);
    globalThis.fetch = async () => { calls++; return new Response('', { status: 302, headers: { Location: 'https://evil.invalid' } }); };
    assert.equal((await proxyLookup(url, env, Date.now(), new RequestBudget(clock))).status, 502); assert.equal(calls, 2);
    globalThis.fetch = async () => { calls++; return new Response('<script>bad</script>', { headers: { 'Content-Type': 'text/html' } }); };
    assert.equal((await proxyLookup(url, env, Date.now(), new RequestBudget(clock))).status, 415);
    const limiter = new RequestBudget(clock);
    globalThis.fetch = async () => { calls++; return new Response('private upstream body', { status: 429, headers: { 'Retry-After': '90' } }); };
    const limited = await proxyLookup(url, env, Date.now(), limiter); assert.equal(limited.status, 429); assert.equal(limited.headers.get('Retry-After'), '90');
    assert.equal((await limited.text()).includes('private upstream body'), false); const before = calls;
    assert.equal((await proxyLookup(url, env, Date.now(), limiter)).status, 429); assert.equal(calls, before);
  } finally { globalThis.fetch = original; }
});

test('document filters sort real dates, preserve missing dates and filter locally', () => {
  assert.equal(documentDate('20260230').value, ''); assert.equal(documentDate('20261021').value, '2026-10-21');
  assert.equal(documentDate('2026-09-21-04:00').value, '2026-09-21');
  const rows = [{ key: '0', description: 'Specimen', code: 'SPE', format: 'Image / media', date: documentDate('20261021') },
    { key: '1', description: 'Office action', code: 'OOA', format: 'PDF', date: documentDate('20260901') },
    { key: '2', description: 'Unknown date', date: documentDate('') }];
  assert.equal(filterDocuments(rows)[0].key, '0'); assert.equal(filterDocuments(rows, { order: 'oldest' })[0].key, '1');
  assert.deepEqual(filterDocuments(rows, { query: 'office', from: '2026-09-01', to: '2026-09-30' }).map(row => row.key), ['1']);
});

test('individual downloads prefer the complete PDF and use safe filenames matching the received file', () => {
  const record = { filename: 'specimen.png', choices: [{ format: 'page', id: 'SPE123', page: '1' }, { format: 'pdf', id: 'SPE123' }] };
  assert.equal(downloadReference(record).format, 'pdf');
  assert.equal(downloadFilename(record, 'pdf'), 'specimen.pdf');
  assert.equal(downloadFilename({ filename: '../unsafe:name.pdf' }, 'pdf'), '.._unsafe_name.pdf');
  assert.equal(downloadFilename({ id: 'OOA123' }, 'pdf'), 'OOA123.pdf');
  assert.equal(downloadReference({ choices: [] }), null);
});
