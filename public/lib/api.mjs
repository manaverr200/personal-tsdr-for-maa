import { isPublicImageReference } from './document-reference.mjs';

const MINUTE = 60000;
const STORAGE = 'maa-request-times-v2'; // Timestamps only; never credentials or file contents.

export class ClientBudget {
  constructor(storage, clock = Date.now) { this.storage = storage; this.clock = clock; this.memory = { all: [], files: [], blockedUntil: 0 }; }
  read() {
    try {
      const parsed = JSON.parse(this.storage?.getItem(STORAGE) || 'null');
      if (parsed && Array.isArray(parsed.all) && Array.isArray(parsed.files)) this.memory = parsed;
    } catch { /* Private browsing/storage restrictions: use memory. */ }
    const now = this.clock();
    const recent = list => list.filter(t => Number.isFinite(t) && t <= now && now - t < MINUTE).slice(-20);
    this.memory.all = recent(this.memory.all);
    this.memory.files = recent(this.memory.files);
    if (!Number.isFinite(this.memory.blockedUntil)) this.memory.blockedUntil = 0;
    return this.memory;
  }
  write(value) { this.memory = value; try { this.storage?.setItem(STORAGE, JSON.stringify(value)); } catch {} }
  wait(file) {
    const state = this.read(), now = this.clock();
    let until = state.blockedUntil;
    if (state.all.length >= 10) until = Math.max(until, state.all[0] + MINUTE);
    if (file && state.files.length) until = Math.max(until, state.files.at(-1) + 30000);
    if (file && state.files.length >= 2) until = Math.max(until, state.files[0] + MINUTE);
    return Math.max(0, Math.ceil((until - now) / 1000));
  }
  reserve(file) {
    const wait = this.wait(file);
    if (wait) throw new Error('Please wait ' + wait + ' seconds before making this request.');
    const state = this.read(), now = this.clock();
    state.all.push(now); if (file) state.files.push(now); this.write(state);
  }
  block(value) {
    const now = this.clock();
    const seconds = /^\d+$/.test(value || '') ? Math.max(1, Number(value))
      : Math.max(1, Math.ceil((Date.parse(value || '') - now) / 1000) || 60);
    const state = this.read(); state.blockedUntil = Math.max(state.blockedUntil, now + seconds * 1000); this.write(state);
  }
}

export function sniffFile(bytes) {
  const starts = (...signature) => signature.every((byte, index) => bytes[index] === byte);
  if (starts(37, 80, 68, 70, 45)) return { kind: 'pdf', type: 'application/pdf', extension: 'pdf' };
  if (starts(137, 80, 78, 71, 13, 10, 26, 10)) return { kind: 'image', type: 'image/png', extension: 'png' };
  if (starts(255, 216, 255)) return { kind: 'image', type: 'image/jpeg', extension: 'jpg' };
  if (starts(71, 73, 70, 56) && [55, 57].includes(bytes[4]) && bytes[5] === 97) return { kind: 'image', type: 'image/gif', extension: 'gif' };
  if (starts(82, 73, 70, 70) && [87, 69, 66, 80].every((byte, i) => bytes[i + 8] === byte)) return { kind: 'image', type: 'image/webp', extension: 'webp' };
  if (starts(66, 77)) return { kind: 'image', type: 'image/bmp', extension: 'bmp' };
  if (starts(73, 73, 42, 0) || starts(77, 77, 0, 42)) return { kind: 'unsupported', type: 'image/tiff', extension: 'tiff' };
  if (starts(80, 75, 3, 4) || starts(80, 75, 5, 6) || starts(80, 75, 7, 8)) return { kind: 'unsupported', type: 'application/zip', extension: 'zip' };
  return { kind: 'unsupported', type: 'application/octet-stream', extension: 'bin' };
}

export class Api {
  constructor({ onUnauthorized = () => {}, storage, fetcher = (url, options) => fetch(url, options) } = {}) {
    this.fetcher = fetcher; this.onUnauthorized = onUnauthorized;
    this.budget = new ClientBudget(storage); this.controllers = new Set();
  }
  cancelAll() { for (const controller of this.controllers) controller.abort(); this.controllers.clear(); }
  async request(path, { method = 'GET', body, lookup = false, file = false, timeout = 95000 } = {}) {
    if (lookup) this.budget.reserve(file);
    const controller = new AbortController(); this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeout), started = performance.now();
    try {
      const response = await this.fetcher(path, { method, body: body === undefined ? undefined : JSON.stringify(body),
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal });
      const headersMs = Math.round(performance.now() - started);
      if (!response.ok) {
        if (response.status === 429) this.budget.block(response.headers.get('Retry-After'));
        const detail = (await response.text()).slice(0, 400);
        if (response.status === 401) this.onUnauthorized();
        throw new Error(detail || 'The service could not complete this request (HTTP ' + response.status + ').');
      }
      if (response.status === 204) throw new Error('No content was returned.');
      // Keep browser memory bounded. Cancel oversized files rather than auto-retrying.
      const reader = response.body?.getReader(), chunks = []; let size = 0;
      if (reader) {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > 32 * 1024 * 1024) { await reader.cancel(); throw new Error('This file is too large for the in-app reader. Open official TSDR for the original.'); }
          chunks.push(value);
        }
      }
      const blob = new Blob(chunks, { type: response.headers.get('Content-Type') || 'application/octet-stream' });
      if (lookup) console.info('TSDR timing', { headersMs, totalMs: Math.round(performance.now() - started), bytes: size,
        serverTiming: response.headers.get('Server-Timing') || '' });
      return { blob, retrievedAt: new Date() };
    } catch (error) {
      if (error.name === 'AbortError' || error.name === 'TimeoutError') throw new Error('The request was cancelled or timed out. You can try again when ready.');
      if (error instanceof TypeError) throw new Error('Could not connect. Check your connection and try again.');
      throw error;
    } finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
  lookup(serial, action, reference = {}) {
    return this.request('/api/lookup?' + new URLSearchParams({ sn: serial, action, ...reference }),
      { lookup: true, file: action !== 'documents' && action !== 'status' && !(action === 'preview' && isPublicImageReference(reference, serial)) });
  }
}

export class AssetCache {
  constructor() { this.entries = new Map(); this.pending = new Map(); this.version = 0; }
  async get(key, loader, { refresh = false } = {}) {
    if (!refresh && this.entries.has(key)) {
      const asset = this.entries.get(key); this.entries.delete(key); this.entries.set(key, asset); return asset;
    }
    if (this.pending.has(key)) return this.pending.get(key);
    const version = this.version;
    const task = (async () => {
      const result = await loader();
      const format = sniffFile(new Uint8Array(await result.blob.slice(0, 16).arrayBuffer()));
      if (version !== this.version) throw new Error('The case was closed.');
      // Do not create a renderable object URL for HTML/SVG or unknown bytes.
      const known = format.kind !== 'unsupported' || ['zip', 'tiff'].includes(format.extension);
      const blob = new Blob([result.blob], { type: format.type });
      const asset = { ...result, ...format, blob, url: known ? URL.createObjectURL(blob) : null };
      const previous = this.entries.get(key);
      if (previous?.url) URL.revokeObjectURL(previous.url);
      this.entries.set(key, asset);
      let total = [...this.entries.values()].reduce((sum, value) => sum + value.blob.size, 0);
      for (const [oldKey, old] of this.entries) {
        if (total <= 64 * 1024 * 1024 && this.entries.size <= 12) break;
        if (oldKey === 'status' || oldKey === key) continue;
        if (old.url) URL.revokeObjectURL(old.url); this.entries.delete(oldKey); total -= old.blob.size;
      }
      return asset;
    })();
    this.pending.set(key, task);
    try { return await task; } finally { if (this.pending.get(key) === task) this.pending.delete(key); }
  }
  remove(key) { const asset = this.entries.get(key); if (asset?.url) URL.revokeObjectURL(asset.url); this.entries.delete(key); }
  clear() { this.version++; for (const asset of this.entries.values()) if (asset.url) URL.revokeObjectURL(asset.url); this.entries.clear(); this.pending.clear(); }
}
