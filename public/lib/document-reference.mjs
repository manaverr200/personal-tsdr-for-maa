// Shared by the browser and Worker. No arbitrary upstream URLs are accepted.
const HOSTS = new Set(['tsdrapi.uspto.gov', 'tsdr.uspto.gov', 'tsdrsec.uspto.gov']);
export const DOCUMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;

export function publicAssetReference(path, serial) {
  if (!/^\d{8}$/.test(serial) || typeof path !== 'string' || path.length > 600) return null;
  const cms = /^\/resting2\/api\/casedoc\/cms\/cases\/(\d{8})\/[A-Za-z0-9_-]{1,30}\/[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}\.(jpg|jpeg|png|gif|webp|bmp|tif|tiff|pdf|zip)$/.exec(path);
  if (cms) return cms[1] === serial ? { format: 'asset', path } : null;
  const legacy = /^\/resting2\/api\/casedoc\/ts\/cd\/(\d{8})\/([A-Za-z0-9][A-Za-z0-9_-]{0,119})\/([1-9]\d{0,4})\/webcontent$/.exec(path);
  return legacy && legacy[1] === serial && Number(legacy[3]) <= 10000
    ? { format: 'asset', path, id: legacy[2], page: legacy[3] } : null;
}

export function documentReference(value, serial) {
  if (!/^\d{8}$/.test(serial) || typeof value !== 'string' || value.length > 1500) return null;
  let url;
  try { url = new URL(value, 'https://tsdrapi.uspto.gov'); } catch { return null; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
  if (url.hostname === 'tmng-al.uspto.gov') return publicAssetReference(url.pathname, serial);
  if (!HOSTS.has(url.hostname)) return null;
  if (url.pathname === '/ts/cd/rawImage/' + serial) return { format: 'image' };
  const match = /^\/ts\/cd\/casedoc\/sn(\d{8})\/([A-Za-z0-9][A-Za-z0-9_-]{0,119})\/(?:(\d{1,5})\/(media|webcontent)|(content|download)(?:\.(pdf|zip))?)\/?$/.exec(url.pathname);
  if (!match || match[1] !== serial) return null;
  const id = match[2];
  if (match[3]) {
    const page = Number(match[3]);
    return page >= 1 && page <= 10000 ? { format: 'page', id, page: String(page) } : null;
  }
  // Original packages are not silently substituted with a second request.
  return match[6] === 'zip' || (match[5] === 'content' && !match[6])
    ? { format: 'original', id } : { format: 'pdf', id };
}

export function previewPath(params, serial) {
  if (!/^\d{8}$/.test(serial)) return null;
  const format = params.get('format');
  if (format === 'image') return '/ts/cd/rawImage/' + serial;
  const id = params.get('id') || '';
  if (!DOCUMENT_ID.test(id)) return null;
  if (format === 'pdf') return '/ts/cd/casedoc/sn' + serial + '/' + id + '/content.pdf';
  if (format === 'page' && /^[1-9]\d{0,4}$/.test(params.get('page') || '') && Number(params.get('page')) <= 10000) {
    return '/ts/cd/casedoc/sn' + serial + '/' + id + '/' + params.get('page') + '/media';
  }
  return null;
}

export function previewTarget(params, serial) {
  if (params.get('format') === 'asset') {
    const reference = publicAssetReference(params.get('path'), serial);
    return reference ? { url: 'https://tmng-al.uspto.gov' + reference.path, authenticated: false, file: !isPublicImageReference(reference, serial) } : null;
  }
  const path = previewPath(params, serial);
  return path ? { url: 'https://tsdrapi.uspto.gov' + path, authenticated: true } : null;
}

export function isPublicImageReference(reference, serial) {
  return reference?.format === 'asset' && Boolean(publicAssetReference(reference.path, serial))
    && /^\/resting2\/api\/casedoc\/cms\/cases\//.test(reference.path)
    && /\.(jpg|jpeg|png|gif|webp|bmp|tif|tiff)$/i.test(reference.path);
}
