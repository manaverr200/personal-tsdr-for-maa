import { previewTarget } from '../public/lib/document-reference.mjs';

export function apiReply(text, status = 200, extra = {}) {
  return new Response(text, { status, headers: {
    'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...extra
  }});
}

export function retrySeconds(value, now = Date.now()) {
  if (/^\d+$/.test(value || '')) return Math.max(1, Number(value));
  const date = Date.parse(value || '');
  return Number.isFinite(date) ? Math.max(1, Math.ceil((date - now) / 1000)) : 60;
}

// Conservative rolling limits shared by requests in this isolate. These are
// deliberately NOT described as an account-wide or cross-isolate guarantee.
export class RequestBudget {
  constructor(clock = Date.now) { this.clock = clock; this.all = []; this.files = []; this.blockedUntil = 0; }
  reserve(file) {
    const now = this.clock();
    this.all = this.all.filter(t => now - t < 60000);
    this.files = this.files.filter(t => now - t < 60000);
    let until = this.blockedUntil;
    if (this.all.length >= 12) until = Math.max(until, this.all[0] + 60000);
    if (file && this.files.length) until = Math.max(until, this.files.at(-1) + 30000);
    if (file && this.files.length >= 2) until = Math.max(until, this.files[0] + 60000);
    if (until > now) return Math.max(1, Math.ceil((until - now) / 1000));
    this.all.push(now);
    if (file) this.files.push(now);
    return 0;
  }
}
const budget = new RequestBudget();

export function lookupRoute(params) {
  const sn = params.get('sn') || '';
  if (!/^\d{8}$/.test(sn)) return null;
  const action = params.get('action');
  const routes = {
    status: '/ts/cd/casestatus/sn' + sn + '/info.xml',
    documents: '/ts/cd/casedocs/bundle.xml?sn=' + sn,
    'status-pdf': '/ts/cd/casestatus/sn' + sn + '/download.pdf',
    'documents-pdf': '/ts/cd/casedocs/bundle.pdf?sn=' + sn,
    'documents-zip': '/ts/cd/casedocs/bundle.zip?sn=' + sn
  };
  if (action === 'preview') {
    const target = previewTarget(params, sn);
    return target ? { ...target, file: target.file ?? true, preview: true } : null;
  }
  return Object.hasOwn(routes, action)
    ? { url: 'https://tsdrapi.uspto.gov' + routes[action], authenticated: true, file: action.endsWith('pdf') || action.endsWith('zip'), preview: action === 'status-pdf' }
    : null;
}

export async function proxyLookup(url, env, workerStarted, limiter = budget) {
  const route = lookupRoute(url.searchParams);
  if (!route) return apiReply('Invalid serial number or document operation.', 400);
  const wait = limiter.reserve(route.file);
  if (wait) return apiReply('Please wait before requesting another file or record.', 429, { 'Retry-After': String(wait) });
  try {
    const started = Date.now();
    const upstream = await fetch(route.url, {
      headers: route.authenticated ? { 'USPTO-API-KEY': env.TSDR_API_KEY } : {}, redirect: 'manual',
      signal: AbortSignal.timeout(90000)
    });
    const elapsed = Date.now() - started;
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel();
      return apiReply('USPTO returned a redirect. The backend did not forward your API key.', 502);
    }
    if (upstream.status === 204) {
      await upstream.body?.cancel();
      return apiReply('USPTO returned no content for this record or document.', 404);
    }
    if (!upstream.ok) {
      await upstream.body?.cancel();
      const hints = { 401: 'USPTO rejected the backend API key.', 403: 'USPTO denied access.',
        404: 'USPTO did not find this record or document.', 429: 'USPTO rate limit reached. Please wait.',
        500: 'USPTO reported a server error.', 503: 'USPTO is temporarily unavailable.' };
      const seconds = retrySeconds(upstream.headers.get('Retry-After'));
      if (upstream.status === 429) limiter.blockedUntil = Date.now() + seconds * 1000;
      return apiReply(hints[upstream.status] || 'USPTO could not complete this request.',
        upstream.status === 401 ? 502 : upstream.status,
        upstream.status === 429 || upstream.headers.has('Retry-After') ? { 'Retry-After': String(seconds) } : {});
    }
    const type = (upstream.headers.get('Content-Type') || 'application/octet-stream').split(';')[0].toLowerCase().trim();
    if (route.preview && !/^(application\/(pdf|x-pdf|octet-stream|zip|x-zip-compressed)|image\/(jpeg|jpg|pjpeg|png|x-png|gif|webp|bmp|x-ms-bmp|tiff|x-tiff))$/.test(type)) {
      await upstream.body?.cancel();
      return apiReply('This document format cannot be previewed safely. Open official TSDR for the original.', 415);
    }
    return new Response(upstream.body, { status: upstream.status, headers: {
      'Content-Type': upstream.headers.get('Content-Type') || 'application/octet-stream',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      ...(route.preview ? { 'Content-Disposition': 'inline' } : {}),
      'Server-Timing': 'app;dur=' + (started - workerStarted) + ', uspto;dur=' + elapsed
    }});
  } catch (error) {
    return apiReply(error?.name === 'TimeoutError' || error?.name === 'AbortError'
      ? 'USPTO request timed out. Try again later.' : 'The backend could not connect to USPTO. Try again later.',
      error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 504 : 502);
  }
}
