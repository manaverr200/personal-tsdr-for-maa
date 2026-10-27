# Personal TSDR for Maa — deployment lesson

This project serves the page and its API from ONE free Cloudflare Workers address.
No purchased domain, database, GitHub Pages, or paid Workers plan is needed.
GitHub is optional source storage. The USPTO key is entered once by the deployer,
not by Maa. Keep your Cloudflare account on Workers Free.

## What each file does

- public/index.html: frontend: search, all returned status fields, document metadata,
  raw responses, status PDF, and complete document bundles as PDF/ZIP.
- worker.mjs: backend: password login, signed session cookie, and authenticated USPTO requests.
- wrangler.jsonc: tells Cloudflare how to deploy both parts together.
- .gitignore: keeps common local secret files and generated files out of Git.

## Why browser CORS is not enough

Chrome/Edge enforce CORS; the API server must allow your origin and the
USPTO-API-KEY request header. Our unauthenticated OPTIONS probe previously
returned HTTP 500 without Access-Control-Allow-Origin. That does not establish
how every authenticated request behaves, but direct browser access is unreliable.
Even if CORS works, an API key embedded in JavaScript or a build-time environment
variable is visible to visitors. A private repository does not hide a key in
published browser code. This backend sends the header server-to-server.

## Deploy from your computer

1. Create a free account at https://dash.cloudflare.com/ . Use Workers Free;
   do not upgrade to a paid plan. Install the current Node.js LTS from
   https://nodejs.org/ if you do not already have it. Restart your terminal.

2. Extract this ZIP. Open a terminal INSIDE the extracted folder containing
   wrangler.jsonc. On Windows you can open the folder in File Explorer and type
   `powershell` into its address bar. On macOS use Terminal and `cd` to this folder.

3. Check your installation:

   node --version
   npm --version

4. Sign into Cloudflare using Wrangler (Cloudflare's deployment command tool):

   npx wrangler@4 login

   Accept the npm installation prompt if shown. A browser opens; authorize
   Cloudflare Wrangler. Do not paste your USPTO key into this login.

5. Deploy the files together:

   npx wrangler@4 deploy

   On your first deployment, follow any prompt to choose a workers.dev subdomain.
   The command prints your site URL, similar to:
   https://personal-tsdr-for-maa.your-subdomain.workers.dev

   Until the secrets below are configured, the page intentionally reports that
   setup is incomplete. It does not provide unprotected API access.

6. Save your USPTO TSDR key as a backend secret:

   npx wrangler@4 secret put TSDR_API_KEY

   When prompted, paste your TSDR-specific API key. Input is hidden. Do not type
   the key into the command itself or save it in index.html or wrangler.jsonc.
   Creating/verifying a USPTO account alone is not the same as requesting its
   TSDR key. Key manager: https://account.uspto.gov/api-manager/

7. Save an app password:

   npx wrangler@4 secret put APP_PASSWORD

   Enter a NEW password of at least 20 characters, preferably a password-manager
   generated random password. This is separate from your USPTO account password
   and API key. Give this app password to Maa privately. Her password manager can
   save it. Both secret commands deploy the secret immediately.

   Alternative to steps 6–7: Cloudflare dashboard → Workers & Pages → your Worker
   → Settings → Variables and Secrets → Add → type Secret. Use exactly the names
   TSDR_API_KEY and APP_PASSWORD; save and deploy the changes.

8. Open the printed HTTPS site URL. Unlock with the APP_PASSWORD, then enter a
   known eight-digit serial number. Bookmark this URL on Maa's device.
   Check status and documents, and try one PDF download. Wait at least 16 seconds
   between PDF/ZIP downloads. Seeing the page alone does not verify USPTO access.

## Everyday use

Maa opens the bookmark, searches the serial number, and downloads documents.
The signed Secure, HttpOnly cookie lasts up to 30 days. Clearing cookies,
private browsing, expiration, or changing APP_PASSWORD requires unlocking again.
No API keys, backend URLs, or connection settings are entered in the page.
Click Lock app to remove the current browser's cookie. The cookie is a bearer
session: an already stolen copy remains valid until expiry or password rotation.

## Where is the key stored?

Cloudflare holds TSDR_API_KEY as an encrypted Worker secret. Only server code
uses it. Browser requests carry a session cookie to your own backend. The key
is never included in the HTML, Git repository, URL, downloads, or browser storage.
The backend uses fixed USPTO endpoints and rejects arbitrary proxy URLs.

## Updating or rotating credentials

After editing code, from this same folder:

   npx wrangler@4 deploy

Existing remote secrets remain configured. To replace the key, rerun
`npx wrangler@4 secret put TSDR_API_KEY`. To change the app password and invalidate
all existing sessions, rerun `npx wrangler@4 secret put APP_PASSWORD`.
Do not change the Worker name unless you intend to create a separate deployment.

## Optional GitHub storage

Create a repository and upload the project files, including the public folder.
Public or private is fine; none of the supplied files contain secrets. You do
not enable GitHub Pages for this deployment. Never upload .dev.vars, .env,
secret values, or screenshots containing keys. GitHub Actions secrets do not
hide values injected into published frontend JavaScript.

Keeping GitHub Pages specifically would require a separate backend plus CORS
and cross-site authentication. That adds complexity without benefiting this
small personal app, so this package intentionally uses one Cloudflare origin.

## Limits and troubleshooting

Cloudflare's published Workers Free limit is 100,000 dynamic requests/day with
10 ms CPU/request; network wait time does not count as CPU. Static assets have
separate handling. Choose Free and do not enable paid products. Limits and plans
can change. Verify https://developers.cloudflare.com/workers/platform/limits/ .

USPTO quotas still apply and are shared by all uses of your API key. The app
spaces downloads; the backend also has best-effort per-isolate throttling.
Those in-memory counters are not global rate limits and reset/multiply as Workers
scale. The app requires a strong password and is intended for a small family,
not as a public multi-user service. It does not automatically retry failed calls.

- Setup incomplete: check both secret names and that APP_PASSWORD is >=20 chars.
- Incorrect password: use APP_PASSWORD, not your USPTO password or API key.
- Backend reports USPTO rejected key: verify the TSDR key, then replace its secret.
- HTTP 429: stop repeated attempts and wait; other tools may share your key.
- Status works but documents fail: separate upstream operations can fail independently.
- HTTP 5xx: USPTO or network failure may be temporary; a proxy cannot fix an outage.
- Worker Error 1027: the Free account daily request quota was reached.
- Opening index.html directly: it needs the deployed backend. Use the HTTPS URL.

## Validation and scope

Backend tests cover login, cookie properties, forged/expired sessions, origin
restrictions, route validation, secret forwarding, and streamed upstream data.
Frontend JavaScript syntax is checked. Live authenticated USPTO retrieval must
be verified after YOUR key is configured; no key was available while building.
The managed visual preview service was unavailable. Rendering has not been
verified in a live browser. The XML field viewer preserves all returned fields;
it does not invent deadline interpretations or promise individual-document links.

## Official documentation

https://developers.cloudflare.com/workers/static-assets/get-started/
https://developers.cloudflare.com/workers/configuration/secrets/
https://developers.cloudflare.com/workers/platform/limits/
https://www.uspto.gov/sites/default/files/documents/tm-enterprise-api-user-guide-v2.pdf
