import { Api, AssetCache, sniffFile } from './lib/api.mjs';
import { parseDocuments, filterDocuments, downloadReference, downloadFilename } from './lib/documents.mjs';
import { FileViewer } from './lib/viewer.mjs';

const $ = id => document.getElementById(id);
const state = { locked: true, busy: false, serial: '', version: 0, documents: null, selected: null };
let storage;
try { storage = window.localStorage; } catch { /* In-memory budget still applies. */ }
const cache = new AssetCache();
const statusViewer = new FileViewer($('statusViewer'));
const documentViewer = new FileViewer($('documentViewer'));
const api = new Api({ storage, onUnauthorized: () => showLogin('Please unlock the app again.') });
function visible(element, show) { element.classList.toggle('hidden', !show); }
function message(text, error = false) { $('message').textContent = text; $('message').className = 'notice' + (error ? ' error' : ''); }
function sectionMessage(id, text, error = false) { $(id).textContent = text; $(id).className = error ? 'notice error' : 'small'; }
function controls() {
  document.querySelectorAll('[data-network]').forEach(button => { button.disabled = state.locked || state.busy || button.dataset.unavailable === 'true'; });
  $('loadDocs').disabled = state.locked || state.busy || !state.serial || state.documents !== null;
  $('refreshStatus').disabled = state.locked || state.busy || !state.serial;
  $('refreshStatus').textContent = cache.entries.has('status') ? 'Refresh status PDF' : 'Load status PDF';
  document.querySelectorAll('.document-row').forEach(button => { button.disabled = state.busy; });
  updateWait();
}
function updateWait() {
  const wait = api.budget.wait(true);
  visible($('requestWait'), !state.locked && wait > 0);
  $('requestWait').textContent = wait > 0 ? 'Please wait ' + wait + ' seconds before another PDF, bundle or page request. Loaded files and direct image previews remain available.' : '';
}
function resetCase() {
  state.version++; api.cancelAll(); statusViewer.clear(); documentViewer.clear(); cache.clear();
  state.serial = ''; state.busy = false; state.documents = null; state.selected = null;
  for (const id of ['documentList', 'previewChoices', 'docsRaw']) $(id).replaceChildren();
  for (const id of ['documentQuery', 'documentFormat', 'dateFrom', 'dateTo']) $(id).value = '';
  $('documentOrder').value = 'newest';
  visible($('results'), false); visible($('documentTools'), false);
  $('previewState').className = 'notice';
  $('previewState').textContent = 'Select a document to read its description and open a preview here.';
  sectionMessage('docsState', 'Load the list when you need it. Images and documents open only when selected.');
  controls();
}
function showLogin(text = '') {
  state.locked = true; resetCase(); $('password').value = '';
  visible($('loginForm'), true); visible($('searchForm'), false); visible($('logout'), false);
  visible($('message'), false); $('loginMessage').textContent = text;
}
function showApp() {
  state.locked = false; $('password').value = '';
  visible($('loginForm'), false); visible($('searchForm'), true); visible($('logout'), true); visible($('message'), false); controls();
}
async function task(work, onError) {
  if (state.busy || state.locked) return;
  const version = state.version; state.busy = true; controls();
  try { await work(version); }
  catch (error) { if (version === state.version) onError(error); }
  finally { if (version === state.version) { state.busy = false; controls(); } }
}
async function loadStatus(refresh = false) {
  return task(async version => {
    sectionMessage('statusState', 'Preparing the official status PDF…');
    const asset = await cache.get('status', async () => {
      const result = await api.lookup(state.serial, 'status-pdf');
      if (sniffFile(new Uint8Array(await result.blob.slice(0, 16).arrayBuffer())).kind !== 'pdf') throw new Error('USPTO did not return a valid status PDF. Open official TSDR to inspect the record.');
      return result;
    }, { refresh });
    if (version !== state.version) return;
    statusViewer.show(asset, { title: 'Status · Application ' + state.serial });
    $('retrieved').textContent = 'Status PDF retrieved ' + asset.retrievedAt.toLocaleString();
    sectionMessage('statusState', 'Official PDF loaded. Scroll inside the reader.');
    visible($('message'), false);
  }, error => sectionMessage('statusState', error.message, true));
}
$('searchForm').addEventListener('submit', async event => {
  event.preventDefault(); if (state.busy || state.locked) return;
  const serial = $('serial').value.trim();
  if (!/^\d{8}$/.test(serial)) { message('Enter exactly eight digits.', true); return; }
  if (serial === state.serial && cache.entries.has('status')) { message('This case is already open. Use Refresh status PDF if you need a fresh copy.'); return; }
  resetCase(); state.serial = serial; visible($('results'), true);
  $('caseTitle').textContent = 'Application ' + serial; $('retrieved').textContent = '';
  $('officialLink').href = 'https://tsdr.uspto.gov/#caseNumber=' + serial + '&caseSearchType=US_APPLICATION&caseType=DEFAULT&searchType=statusSearch';
  visible($('message'), false); await loadStatus();
});
$('refreshStatus').onclick = () => loadStatus(true);

$('loadDocs').onclick = () => task(async version => {
  sectionMessage('docsState', 'Loading document metadata…');
  const result = await api.lookup(state.serial, 'documents');
  const text = await result.blob.text();
  if (version !== state.version) return;
  $('docsRaw').textContent = text;
  state.documents = parseDocuments(text, state.serial);
  visible($('documentTools'), true);
  sectionMessage('docsState', state.documents.length + ' documents · Metadata retrieved ' + result.retrievedAt.toLocaleString());
  renderDocuments();
}, error => sectionMessage('docsState', error.message, true));

function renderDocuments() {
  if (!state.documents) return;
  const from = $('dateFrom').value, to = $('dateTo').value;
  const records = filterDocuments(state.documents, { query: $('documentQuery').value, format: $('documentFormat').value,
    from, to, order: $('documentOrder').value });
  $('documentCount').textContent = from && to && from > to ? 'Choose a From date earlier than the To date.'
    : records.length + ' of ' + state.documents.length + ' documents';
  const fragment = document.createDocumentFragment();
  for (const record of records) {
    const card = document.createElement('article');
    card.className = 'document-card' + (state.selected?.key === record.key ? ' is-selected' : '');
    const row = document.createElement('button'); row.type = 'button'; row.className = 'document-row';
    row.setAttribute('aria-pressed', String(state.selected?.key === record.key)); row.disabled = state.busy;
    for (const [className, text] of [['row-date', record.date.display], ['row-description', record.description],
      ['row-meta', [record.code, record.format, record.filename !== record.description ? record.filename : '', record.id !== record.filename ? record.id : ''].filter(Boolean).join(' · ')]]) {
      const part = document.createElement('span'); part.className = className; part.textContent = text; row.append(part);
    }
    row.onclick = () => selectDocument(record);
    const download = document.createElement('button'), reference = downloadReference(record);
    download.type = 'button'; download.className = 'document-download'; download.dataset.network = '';
    download.dataset.unavailable = String(!reference); download.disabled = state.busy || !reference;
    download.setAttribute('aria-label', 'Download ' + record.filename);
    download.title = 'Download ' + record.filename;
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    arrow.setAttribute('d', 'M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4'); icon.append(arrow); download.append(icon);
    if (!reference) download.title = 'No supported download reference was supplied. Open official TSDR for the original.';
    download.onclick = () => downloadDocument(record); card.append(row, download); fragment.append(card);
  }
  if (!records.length) { const empty = document.createElement('p'); empty.className = 'notice'; empty.textContent = state.documents.length ? 'No documents match these filters.' : 'USPTO returned an empty document list.'; fragment.append(empty); }
  $('documentList').replaceChildren(fragment);
}

function choiceLabel(reference) { return reference.page ? 'Preview page ' + reference.page : reference.format === 'image' || reference.kind === 'image' ? 'Preview image' : 'Preview PDF'; }
function selectDocument(record) {
  if (state.busy) return;
  state.selected = record; documentViewer.clear(); renderDocuments(); $('previewChoices').replaceChildren();
  sectionMessage('previewState', record.description + '\nDocument date: ' + record.date.display);
  for (const [index, reference] of record.choices.entries()) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary preview-choice';
    button.textContent = choiceLabel(reference); button.dataset.network = ''; button.dataset.choice = String(index);
    button.setAttribute('aria-pressed', 'false'); button.onclick = () => openPreview(record, index); $('previewChoices').append(button);
  }
  const close = document.createElement('button'); close.type = 'button'; close.className = 'secondary'; close.textContent = 'Close preview';
  close.onclick = () => { if (state.busy) return; state.selected = null; documentViewer.clear(); $('previewChoices').replaceChildren(); sectionMessage('previewState', 'Select a document to open a preview here.'); renderDocuments(); };
  $('previewChoices').append(close);
  if (!record.choices.length) { sectionMessage('previewState', record.description + '\nNo supported preview reference was supplied. Open official TSDR for the original.'); return; }
  openPreview(record, 0);
}
function openPreview(record, index) {
  return task(async version => {
    const reference = record.choices[index];
    sectionMessage('previewState', record.description + '\nLoading ' + choiceLabel(reference).toLowerCase().replace('preview ', '') + '…');
    const key = 'preview:' + JSON.stringify(reference);
    const asset = await cache.get(key, () => api.lookup(state.serial, 'preview', reference));
    if (version !== state.version) return;
    documentViewer.show(asset, { title: reference.page ? 'Document · Page ' + reference.page : 'Document preview',
      description: record.description, date: record.date.display,
      onSave: () => saveAsset(asset, downloadFilename(record, asset.extension)) });
    visible($('previewState'), false);
    $('previewChoices').querySelectorAll('[data-choice]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.choice) === index)));
  }, error => sectionMessage('previewState', record.description + '\n\n' + error.message, true));
}
for (const id of ['documentQuery', 'documentFormat', 'documentOrder', 'dateFrom', 'dateTo']) $(id).addEventListener('input', renderDocuments);
$('clearFilters').onclick = () => { for (const id of ['documentQuery', 'documentFormat', 'dateFrom', 'dateTo']) $(id).value = ''; $('documentOrder').value = 'newest'; renderDocuments(); };

function saveAsset(asset, name) { if (!asset.url) return; const link = document.createElement('a'); link.href = asset.url; link.download = name; link.click(); }
function downloadDocument(record) {
  const reference = downloadReference(record);
  if (!reference) return;
  return task(async version => {
    message('Preparing ' + record.filename + '…');
    const asset = await cache.get('preview:' + JSON.stringify(reference), () => api.lookup(state.serial, 'preview', reference));
    if (version !== state.version) return;
    if (!asset.url || (reference.format === 'pdf' && asset.kind !== 'pdf')) throw new Error('USPTO did not return the expected document. Open official TSDR for the original.');
    saveAsset(asset, downloadFilename(record, asset.extension)); message('Your document is ready.');
  }, error => message(error.message, true));
}
document.querySelectorAll('[data-download]').forEach(button => { button.onclick = () => task(async version => {
  const action = button.dataset.download;
  message('Preparing the document bundle. Large bundles can take a while…');
  const asset = await cache.get(action, async () => {
    const result = await api.lookup(state.serial, action);
    const signature = sniffFile(new Uint8Array(await result.blob.slice(0, 16).arrayBuffer()));
    if (signature.extension !== (action.endsWith('pdf') ? 'pdf' : 'zip')) throw new Error('USPTO returned an unexpected document bundle.');
    return result;
  });
  if (version !== state.version) return;
  saveAsset(asset, state.serial + '-' + action + '.' + asset.extension); message('Your document bundle is ready.');
}, error => message(error.message, true)); });

$('loginForm').onsubmit = async event => {
  event.preventDefault(); $('loginButton').disabled = true; $('loginMessage').textContent = 'Unlocking…';
  try { await api.request('/api/login', { method: 'POST', body: { password: $('password').value }, timeout: 20000 }); showApp(); $('serial').focus(); }
  catch (error) { $('loginMessage').textContent = error.message; }
  finally { $('password').value = ''; $('loginButton').disabled = false; }
};
$('logout').onclick = async () => {
  showLogin('Locking app…');
  try { await api.request('/api/logout', { method: 'POST', timeout: 12000 }); $('loginMessage').textContent = 'App locked.'; }
  catch { $('loginMessage').textContent = 'Could not confirm sign-out with the server. Check your connection and try unlocking and locking again.'; }
};
window.addEventListener('pagehide', () => { resetCase(); state.locked = true; });
window.addEventListener('pageshow', event => { if (event.persisted) checkSession(); });
window.addEventListener('storage', updateWait);
setInterval(updateWait, 1000); // Updates local countdown text only. No polling requests.
async function checkSession() {
  controls(); message('Opening app…');
  try { await api.request('/api/session', { timeout: 12000 }); showApp(); }
  catch (error) { showLogin(error.message.includes('unlock') ? '' : error.message); }
}
checkSession();
