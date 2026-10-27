// Backend only. Configure secrets in Cloudflare:
// TSDR_API_KEY
// APP_PASSWORD (at least 20 characters)

const TTL = 30 * 24 * 60 * 60;
const COOKIE = '__Host-maa_session';
const enc = new TextEncoder();

// Best-effort throttling within each Worker isolate.
const attempts = new Map();

const hex = bytes =>
  [...new Uint8Array(bytes)]
    .map(x => x.toString(16).padStart(2, '0'))
    .join('');

async function digest(value) {
  return new Uint8Array(
    await crypto.subtle.digest('SHA-256', enc.encode(value))
  );
}

function equal(a, b) {
  let difference = a.length ^ b.length;

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    difference |= (a[i] || 0) ^ (b[i] || 0);
  }

  return difference === 0;
}

async function sign(value, password) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  return hex(
    await crypto.subtle.sign(
      'HMAC',
      key,
      enc.encode('maa-session-v1:' + value)
    )
  );
}

async function sessionValid(request, password) {
  const token = (request.headers.get('Cookie') || '')
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(COOKIE + '='))
    ?.slice(COOKIE.length + 1) || '';

  const match =
    /^(\d{10})\.([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(token);

  const now = Math.floor(Date.now() / 1000);

  if (
    !match ||
    Number(match[1]) <= now ||
    Number(match[1]) > now + TTL + 60
  ) {
    return false;
  }

  const expected = await sign(
    match[1] + '.' + match[2],
    password
  );

  return equal(enc.encode(match[3]), enc.encode(expected));
}

function throttle(key, limit, period) {
  const now = Date.now();

  if (attempts.size > 2000) {
    for (const [storedKey, entry] of attempts) {
      if (entry.until < now) attempts.delete(storedKey);
    }
  }

  if (attempts.size > 3000) attempts.clear();

  let entry = attempts.get(key);

  if (!entry || entry.until < now) {
    entry = { count: 0, until: now + period };
    attempts.set(key, entry);
  }

  return ++entry.count <= limit;
}

function reply(text, status = 200, extraHeaders = {}) {
  return new Response(text, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders
    }
  });
}

export default {
  async fetch(request, env) {
    const workerStarted = Date.now();
    const url = new URL(request.url);

    // Serve the frontend through the ASSETS binding.
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    if (
      !env.TSDR_API_KEY ||
      !env.APP_PASSWORD ||
      env.APP_PASSWORD.length < 20
    ) {
      return reply(
        'Setup incomplete: configure TSDR_API_KEY and an APP_PASSWORD of at least 20 characters.',
        503
      );
    }

    const origin = request.headers.get('Origin');

    if (origin && origin !== url.origin) {
      return reply('Origin not allowed.', 403);
    }

    if (request.headers.get('Sec-Fetch-Site') === 'cross-site') {
      return reply('Cross-site access denied.', 403);
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'local';

    // Sign in.
    if (
      url.pathname === '/api/login' &&
      request.method === 'POST'
    ) {
      if (origin !== url.origin) {
        return reply('Origin required.', 403);
      }

      if (!throttle('login:' + ip, 10, 600000)) {
        return reply(
          'Too many sign-in attempts. Wait 10 minutes.',
          429,
          { 'Retry-After': '600' }
        );
      }

      const contentType =
        request.headers.get('Content-Type') || '';

      if (!contentType.startsWith('application/json')) {
        return reply('JSON required.', 415);
      }

      // Read at most 2 KB, without trusting Content-Length.
      const reader = request.body?.getReader();

      if (!reader) {
        return reply('Password required.', 400);
      }

      let size = 0;
      const chunks = [];

      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        size += value.length;

        if (size > 2048) {
          await reader.cancel();
          return reply('Request too large.', 413);
        }

        chunks.push(value);
      }

      const bytes = new Uint8Array(size);
      let offset = 0;

      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }

      let body;

      try {
        body = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return reply('Invalid request.', 400);
      }

      if (
        typeof body.password !== 'string' ||
        !equal(
          await digest(body.password),
          await digest(env.APP_PASSWORD)
        )
      ) {
        return reply('Incorrect app password.', 401);
      }

      const expires = Math.floor(Date.now() / 1000) + TTL;
      const random = hex(
        crypto.getRandomValues(new Uint8Array(16))
      );

      const value = expires + '.' + random;
      const signature = await sign(value, env.APP_PASSWORD);

      return reply('Signed in.', 200, {
        'Set-Cookie':
          COOKIE + '=' + value + '.' + signature +
          '; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=' +
          TTL
      });
    }

    // Sign out.
    if (
      url.pathname === '/api/logout' &&
      request.method === 'POST'
    ) {
      if (origin !== url.origin) {
        return reply('Origin required.', 403);
      }

      return reply('Signed out.', 200, {
        'Set-Cookie':
          COOKIE +
          '=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0'
      });
    }

    // All remaining API operations require a valid session.
    if (!await sessionValid(request, env.APP_PASSWORD)) {
      return reply('Please unlock the app.', 401);
    }

    if (
      url.pathname === '/api/session' &&
      request.method === 'GET'
    ) {
      return reply('Signed in.');
    }

    if (
      url.pathname !== '/api/lookup' ||
      request.method !== 'GET'
    ) {
      return reply('Not found.', 404);
    }

    const sn = url.searchParams.get('sn') || '';

    if (!/^\d{8}$/.test(sn)) {
      return reply(
        'Serial number must be exactly eight digits.',
        400
      );
    }

    const routes = {
      status:
        '/ts/cd/casestatus/sn' + sn + '/info.xml',

      documents:
        '/ts/cd/casedocs/bundle.xml?sn=' + sn,

      'status-pdf':
        '/ts/cd/casestatus/sn' + sn + '/download.pdf',

      'documents-pdf':
        '/ts/cd/casedocs/bundle.pdf?sn=' + sn,

      'documents-zip':
        '/ts/cd/casedocs/bundle.zip?sn=' + sn
    };

    const action = url.searchParams.get('action');

    if (!Object.hasOwn(routes, action)) {
      return reply('Unknown operation.', 400);
    }

    const download =
      action.endsWith('pdf') || action.endsWith('zip');

    if (
      !throttle(
        download ? 'download' : 'lookup',
        download ? 4 : 50,
        60000
      )
    ) {
      return reply(
        'Please wait before the next request.',
        429,
        { 'Retry-After': '60' }
      );
    }

    try {
      const upstreamStarted = Date.now();
      const upstream = await fetch(
        'https://tsdrapi.uspto.gov' + routes[action],
        {
          headers: {
            'USPTO-API-KEY': env.TSDR_API_KEY
          },

          // Cloudflare supports "manual", not "error".
          redirect: 'manual',

          signal: AbortSignal.timeout(90000)
        }
      );

      const upstreamHeadersMs = Date.now() - upstreamStarted;

      // Never forward the API key to a redirect destination.
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel();

        return reply(
          'USPTO returned an HTTP ' +
          upstream.status +
          ' redirect. The backend did not forward your API key to another address.',
          502
        );
      }

      if (!upstream.ok) {
        const hints = {
          401:
            'USPTO rejected the backend API key. Ask the app owner to check it.',
          403:
            'USPTO denied access.',
          404:
            'USPTO did not find this record.',
          429:
            'USPTO rate limit reached. Please wait.',
          500:
            'USPTO reported a server error.',
          503:
            'USPTO is temporarily unavailable.'
        };

        await upstream.body?.cancel();

        const retry = upstream.headers.get('Retry-After');

        return reply(
          hints[upstream.status] ||
            'USPTO could not complete this request.',
          upstream.status === 401 ? 502 : upstream.status,
          retry ? { 'Retry-After': retry } : {}
        );
      }

      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          'Content-Type':
            upstream.headers.get('Content-Type') ||
            'application/octet-stream',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Server-Timing':
            'app;dur=' + (upstreamStarted - workerStarted) +
            ', uspto;dur=' + upstreamHeadersMs,
        }
      });
    } catch (error) {
      if (
        error?.name === 'TimeoutError' ||
        error?.name === 'AbortError'
      ) {
        return reply(
          'USPTO request timed out. Please try again later.',
          504
        );
      }

      return reply(
        'The backend could not complete its connection to USPTO. Please try again later.',
        502
      );
    }
  }
};