import { documentReference, DOCUMENT_ID } from './document-reference.mjs';

const key = name => name.toLowerCase().replace(/[^a-z0-9]/g, '');
export function documentDate(value) {
  const raw = (value || '').trim();
  const match = /^(\d{4})-?(\d{2})-?(\d{2})(?:T.*|Z|[+-]\d{2}:\d{2})?$/.exec(raw);
  if (!match) return { display: raw || 'Date not supplied', value: '' };
  const iso = match[1] + '-' + match[2] + '-' + match[3];
  const date = new Date(iso + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== iso) return { display: raw, value: '' };
  return { display: date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }), value: iso };
}

export function parseDocuments(text, serial, Parser = DOMParser) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('The metadata contains an unsupported XML declaration.');
  const xml = new Parser().parseFromString(text, 'application/xml');
  if (xml.getElementsByTagNameNS('*', 'parsererror').length || xml.documentElement?.localName.toLowerCase() === 'html') throw new Error('USPTO returned an unreadable document list.');
  if (xml.getElementsByTagNameNS('*', 'Fault').length) throw new Error('USPTO returned a service fault in the document list.');
  const all = [...xml.getElementsByTagName('*')];
  const records = all.filter(node => ['document', 'casedocument', 'documentmetadata', 'documentrecord'].includes(key(node.localName)))
    .filter(node => ![...node.getElementsByTagName('*')].some(child => ['document', 'casedocument', 'documentrecord'].includes(key(child.localName))));
  if (!records.length && !['documentlist', 'documents', 'casedocuments', 'documentbag'].includes(key(xml.documentElement?.localName || ''))) {
    throw new Error('This document-list structure is not recognized. You can inspect the original metadata below.');
  }
  return records.map((record, index) => {
    const fields = [];
    for (const attribute of [...record.attributes]) fields.push([key(attribute.localName || attribute.name), attribute.value.trim()]);
    for (const node of [...record.getElementsByTagName('*')]) {
      if (!node.children.length) fields.push([key(node.localName), node.textContent.trim()]);
      for (const attribute of [...node.attributes]) fields.push([key(attribute.localName || attribute.name), attribute.value.trim()]);
    }
    const get = names => {
      for (const name of names) { const value = fields.find(([field, value]) => field === name && value); if (value) return value[1]; }
      return '';
    };
    let id = get(['documentid', 'docid', 'id']);
    const mediaTypes = fields.filter(([name]) => name === 'pagemediatypename').map(([, value]) => value.toLowerCase());
    let urlIndex = 0;
    const choices = [], seen = new Set();
    for (const [, value] of fields) {
      if (!/^(https:\/\/|\/ts\/cd\/)/i.test(value)) continue;
      const media = mediaTypes[urlIndex++] || '';
      const reference = documentReference(value, serial);
      if (!reference) continue;
      if (!id && reference.id) id = reference.id;
      if (reference.format === 'original') continue;
      // TICRS can list an XML form as page 1, followed by JPEG pages. Use
      // the PDF option for form content; never embed upstream XML/HTML.
      if (reference.format === 'asset') {
        if (/xml|html/.test(media)) continue;
        reference.kind = /pdf/.test(media) || /\.pdf$/i.test(reference.path) ? 'pdf' : 'image';
      }
      const identity = JSON.stringify(reference);
      if (!seen.has(identity)) { choices.push(reference); seen.add(identity); }
    }
    if (DOCUMENT_ID.test(id) && !choices.some(choice => choice.format === 'pdf')) choices.push({ format: 'pdf', id });
    const rank = choice => choice.format === 'pdf' || choice.kind === 'pdf' ? 2 : choice.format === 'image' ? 1 : 0;
    choices.sort((a, b) => rank(a) - rank(b) || Number(a.page || 0) - Number(b.page || 0));
    const date = documentDate(get(['mailroomdate', 'documentdate', 'scandate', 'createdate', 'creationdate', 'date']));
    let filename = get(['filename', 'documentfilename', 'originalfilename', 'originalname', 'name']);
    if (!filename) {
      for (const [, value] of fields) {
        if (!/^(https:\/\/|\/ts\/cd\/)/i.test(value)) continue;
        try {
          const last = decodeURIComponent(new URL(value, 'https://tsdrapi.uspto.gov').pathname.split('/').filter(Boolean).at(-1) || '');
          if (/\.[a-z0-9]{1,8}$/i.test(last) && !/^(content|download)\./i.test(last)) { filename = last; break; }
        } catch { /* Use the document ID if a filename cannot be decoded. */ }
      }
    }
    filename ||= id || 'Document ' + (index + 1);
    return { key: String(index), id, date, choices, filename,
      pageCount: Number(get(['totalpagequantity', 'pagecount'])) || choices.filter(choice => choice.page).length || 1,
      description: get(['documentdescription', 'description', 'documenttypecodedescriptiontext', 'documenttypedescriptiontext', 'documenttypedescription', 'documentdescriptiontext', 'title']) || filename,
      code: get(['documenttypecode', 'documentcode', 'documenttype', 'doctype', 'code']),
      media: get(['pagemediatypename', 'mimetype', 'mediatype', 'contenttype', 'filetype', 'format']),
      format: choices.some(choice => choice.format === 'page' || choice.format === 'image' || choice.kind === 'image') ? 'Image / media' : choices.some(choice => choice.format === 'pdf' || choice.kind === 'pdf') ? 'PDF' : 'Original only'
    };
  });
}

export function filterDocuments(records, { query = '', format = '', from = '', to = '', order = 'newest' } = {}) {
  const search = query.trim().toLocaleLowerCase();
  return records.filter(record => (!search || [record.description, record.filename, record.code, record.id].join(' ').toLocaleLowerCase().includes(search))
    && (!format || record.format === format)
    && (!from || (record.date.value && record.date.value >= from))
    && (!to || (record.date.value && record.date.value <= to)))
    .sort((a, b) => {
      if (!a.date.value || !b.date.value) return Number(!a.date.value) - Number(!b.date.value) || Number(a.key) - Number(b.key);
      return (order === 'oldest' ? 1 : -1) * a.date.value.localeCompare(b.date.value) || Number(a.key) - Number(b.key);
    });
}

export function downloadReference(record) {
  if (record.pageCount === 1) {
    const original = record.choices.find(choice => choice.format === 'asset');
    if (original) return original;
  }
  return record.choices.find(choice => choice.format === 'pdf') || record.choices[0] || null;
}

export function downloadFilename(record, extension) {
  const base = (record.filename || record.id || 'document').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\.(pdf|png|jpe?g|gif|webp|bmp|tiff?|zip)$/i, '').replace(/[. ]+$/, '').slice(0, 160) || 'document';
  return base + '.' + extension;
}
