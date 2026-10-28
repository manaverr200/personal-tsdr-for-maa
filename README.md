# Personal TSDR for Maa

A private case-reading workspace served by one Cloudflare Worker. The app opens the official status PDF inside the browser and loads document metadata and individual previews only when requested. No frontend framework, build step, database, paid service, or external viewer dependency is required.

## Project structure

- `public/index.html`: accessible page structure, search, status reader and document workspace.
- `public/styles.css`: responsive layout, selected-document list and scrollable readers.
- `public/app.mjs`: login/session lifecycle, case selection, filters and user actions.
- `public/lib/api.mjs`: bounded requests, request budgets, signature checking and in-memory file cache.
- `public/lib/documents.mjs`: namespace-aware document metadata parsing, dates, sorting and filtering.
- `public/lib/document-reference.mjs`: shared validation of case-scoped document references. Rebuilds specific API routes; never accepts an arbitrary proxy destination.
- `public/lib/viewer.mjs`: embedded native PDF reader and image zoom/rotation controls.
- `worker.mjs`: password login, signed Secure/HttpOnly session cookies and origin/session checks.
- `lib/upstream.mjs`: restricted USPTO operations, streaming, conservative request limits and timing headers.
- `wrangler.jsonc`: existing Worker and static-asset configuration.
- `tests/`: entirely synthetic offline checks and a local-only browser fixture server.
- `AGENTS.md`: the owner's edit, commit, push and deployment restrictions.

## Everyday use

1. Unlock with the app password. A signed cookie remembers the browser for up to 30 days.
2. Enter an eight-digit application serial number. Exactly one status PDF request is made; the file opens in the in-app reader. There is no automatic status XML or document-metadata request.
3. Scroll, zoom or search using the browser's PDF toolbar. Expand reader increases the reading area. Native PDF support depends on the browser; current desktop Chrome/Edge are the primary targets.
4. Click Load document list when needed. Review official descriptions, dates and codes. Search, sort and filter the already-loaded list without further requests.
5. Select a document. Its first supported page/image or PDF loads on demand. Additional supplied page references and a PDF option appear as explicit buttons. Descriptions remain attached to the selected preview.
6. Zoom, rotate, resize and reopen cached files without requesting them again. Unsupported TIFF/ZIP originals show a clear fallback; supported originals already fetched can be saved without another request. Unknown/HTML/SVG bytes are never embedded.
7. Each document card has a circular download icon within its original compact layout. A single-page public original downloads in its native format (for example JPG); multi-page documents use the complete PDF when its document ID is available. Already-previewed files are reused. Missing descriptions display the filename (or document ID when no filename is supplied), in smaller text.
   The Exports section stays expanded with the all-document PDF/ZIP actions. Original metadata can still be inspected in its disclosure; there is no metadata export button.
8. Lock app clears both readers, document metadata and cached object URLs, and asks the server to remove the current session cookie.

The cache is in memory only, scoped to the open case. It clears on case changes, locking and leaving the page. It is bounded to 12 entries / 64 MiB, with at most 32 MiB per fetched response. Old previews can be evicted; selecting an evicted preview requires another request. A fresh status PDF is requested only when opening a different case or explicitly refreshing. Retrieval timestamps are displayed separately from document dates. A failed refresh leaves an existing PDF available.

## USPTO limits and request behavior

Official published standard limits are 60 requests per API key per minute, and 4 per minute for PDF/ZIP downloads. Displaying a PDF in the app still counts as fetching a PDF. These limits are shared with other tools using the same account/key.

This app deliberately uses lower limits:

- Browser: at most 10 lookup attempts per rolling minute, and at most 2 file attempts per rolling minute, at least 30 seconds apart.
- Worker isolate: at most 12 lookup attempts per rolling minute, and at most 2 file attempts per rolling minute, at least 30 seconds apart.
- PDF/ZIP and page-media previews use the stricter file budget. Validated direct CMS image files (JPG/PNG/etc.) use the conservative general budget and remain available during PDF cooldowns. They are fetched without an API key. Unknown native page formats remain in the stricter budget.
- Timestamps only (no credentials or file contents) are kept in browser localStorage to preserve the cooldown across reloads and coordinate tabs on the same origin as best effort.
- HTTP 429 and Retry-After pause new requests. Nothing is retried automatically. Reading files already in memory continues to work.
- No background refresh, prefetch, automatic thumbnail fetching or upstream range requests. The PDF viewer receives an already-fetched local blob.

**These are best-effort browser/per-isolate guards, not a global account-wide guarantee.** Multiple browsers, other tools and separate Worker instances can consume the same key's allowance. A globally coordinated limiter would require a separate hosting configuration decision; no Cloudflare configuration was changed for this update. The app remains intended for small private/family use.

## Credentials and deployment

The Worker requires the existing Cloudflare runtime secrets:

- `TSDR_API_KEY`: the TSDR-specific USPTO key.
- `APP_PASSWORD`: an app password of at least 20 characters.

The browser receives neither secret. Never place their values in the repository, frontend files, command arguments, logs or screenshots. Do not substitute a different USPTO product's key. Cloudflare dashboard: Worker → Settings → Variables and Secrets. Secret values belong only in that backend configuration.

Use the owner's existing GitHub-to-Cloudflare workflow when the owner chooses to release these changes. Include **all** new public modules and `lib/upstream.mjs` together with the updated entry files. There is no npm build/install step. Keep the existing Worker name, asset binding, runtime variables and wrangler configuration. The agent does not commit, push or deploy.

A CLI deployment remains possible for the owner with Node.js installed: `npx wrangler@4 deploy`. Changing source does not require replacing existing remote secrets. Secret rotation is done by the owner through Cloudflare's secret-entry UI or interactive `wrangler secret put`, never by placing values in command arguments.

## Run the real app locally

The local `.env` file supplies `APP_PASSWORD` and `TSDR_API_KEY` to Wrangler. It is ignored by Git and separate from the deployed Cloudflare runtime secrets. Do not create `.dev.vars` alongside it: Wrangler gives `.dev.vars` precedence over `.env`.

From PowerShell in this project directory:

```powershell
npx --yes wrangler@4 dev --local --ip 127.0.0.1 --port 8787
```

Open `http://127.0.0.1:8787/` and unlock with the app password. This runs the actual Worker and updated frontend, with real USPTO requests when you search or open a file. Normal account quotas apply. Opening the homepage and checking the login/session do not call USPTO. Keep the terminal open and use Ctrl+C to stop the server. This command does not deploy or change remote runtime secrets.

## Offline verification

Run backend/API/cache/reference tests with Node.js 24:

```powershell
node --test tests/run.mjs
```

For browser verification with **synthetic** PDF/image/XML responses:

```powershell
node tests/mock-server.mjs
```

Open `http://127.0.0.1:8788/__test__/` in Chrome. The browser suite exercises the real UI modules with a synthetic clock (only injected by this local test server) so cooldowns can be tested without waiting. Results also appear at `/__test__/results`. A different local port can be passed as the first argument. The server binds to loopback, never proxies external requests, never reads real secrets, and is separate from the production Worker. Do not deploy it as the app's backend.

The fixture metadata is explicitly synthetic. It covers both older DocumentList fields and current UrlPathList/PageMediaTypeList structures, document type descriptions, timezone-bearing dates, and IDs embedded in TICRS URLs. Unrecognized XML structures fail visibly and preserve the raw metadata for inspection. Current CMS and TICRS public assets are restricted to two validated, case-scoped URL patterns on `tmng-al.uspto.gov` and fetched without the API key. Other supported routes are reconstructed on `tsdrapi.uspto.gov`, which is the only destination receiving the key. Queries and redirects are never forwarded. XML/HTML form pages use an explicit PDF option instead of being embedded; mixed documents preview the supplied image pages. Some nonstandard files may require official TSDR.

Tests cover authentication, origin restrictions, no-follow redirects, safe preview destinations, streamed responses, 429 handling, response-size limits, cache reuse and invalidation, document filters and native browser interactions. No authenticated live USPTO calls were made while implementing this update. Individual live file routes and native viewer behavior should receive a small owner-controlled post-deployment check. Stop on rate-limit responses; do not bulk-test previews.

## Troubleshooting

- Setup incomplete: check both runtime secret names and the password's minimum length.
- Unlock rejected: the app password is case-sensitive and is separate from the USPTO password/key.
- Wait message: a previous file request, preview, export or upstream rate limit is still in its cooldown. Existing cached previews remain readable.
- No preview: unsupported formats and unrecognized references retain the official TSDR link; there is no automatic fallback request.
- PDF takes time: USPTO must still prepare it. In-app viewing changes the reading experience, not upstream generation speed.
- HTTP 5xx: a USPTO/network failure can be temporary. Retry manually later.
- Opening index.html directly: use the deployed origin or the local test server; the app needs same-origin API routes and ES modules.

Successful responses include Server-Timing: `app` measures Worker time before the upstream fetch, and `uspto` measures waiting for upstream headers (including network time). Browser-console TSDR timing messages include durations/bytes only. They do not contain document bodies, credentials or serial numbers. Body download and later browser rendering are separate from the upstream-header duration.

## Official references

- [USPTO TSDR API guide](https://www.uspto.gov/sites/default/files/documents/tm-enterprise-api-user-guide-v2.pdf)
- [USPTO TSDR FAQ](https://tsdr.uspto.gov/faqview)
- [Cloudflare Worker static assets](https://developers.cloudflare.com/workers/static-assets/)
- [Cloudflare runtime secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
