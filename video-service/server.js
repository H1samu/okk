import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { GoogleAuth } from 'google-auth-library';

const PORT = Number(process.env.PORT || 8080);
const DRIVE_FILE_ID = requiredEnv('VIDEO_FILE_ID');
const APPS_SCRIPT_URL = requiredEnv('HISMAR_APPS_SCRIPT_URL');
const SIGNING_SECRET = requiredEnv('PLAYBACK_SIGNING_SECRET');
const ALLOWED_ORIGINS = new Set(
  requiredEnv('ALLOWED_ORIGINS').split(',').map(value => value.trim()).filter(Boolean)
);
const TICKET_TTL_SECONDS = 30 * 60;
const TICKET_AUDIENCE = 'hismar-training-video';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

if (SIGNING_SECRET.length < 32) {
  throw new Error('PLAYBACK_SIGNING_SECRET must contain at least 32 characters.');
}

const googleAuth = new GoogleAuth({ scopes: [DRIVE_SCOPE] });
let metadataCache = null;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(payload);
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  res.setHeader('Vary', 'Origin');
  if (!origin) return true;
  if (!ALLOWED_ORIGINS.has(origin)) return false;

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers',
    'Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  return true;
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function issueTicket() {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    aud: TICKET_AUDIENCE,
    fileId: DRIVE_FILE_ID,
    iat: now,
    exp: now + TICKET_TTL_SECONDS
  };
  const encoded = base64url(JSON.stringify(payload));
  const signature = createHmac('sha256', SIGNING_SECRET).update(encoded).digest('base64url');
  return encoded + '.' + signature;
}

function verifyTicket(ticket) {
  if (typeof ticket !== 'string' || ticket.length > 2048) return false;
  const parts = ticket.split('.');
  if (parts.length !== 2) return false;

  const expected = createHmac('sha256', SIGNING_SECRET).update(parts[0]).digest();
  let actual;
  try {
    actual = Buffer.from(parts[1], 'base64url');
  } catch {
    return false;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;

  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    return payload.v === 1 &&
      payload.aud === TICKET_AUDIENCE &&
      payload.fileId === DRIVE_FILE_ID &&
      Number.isInteger(payload.exp) &&
      payload.exp > now &&
      payload.iat <= now + 30 &&
      payload.exp - payload.iat <= TICKET_TTL_SECONDS;
  } catch {
    return false;
  }
}

async function readBody(req, maxBytes = 8192) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function verifyHismarSession(token) {
  if (typeof token !== 'string' || token.length < 10 || token.length > 4096) {
    return { ok: false, invalid: true };
  }

  const response = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'verify', token }),
    signal: AbortSignal.timeout(12000),
    redirect: 'follow'
  });

  if (!response.ok) throw new Error(`Hismar verification returned HTTP ${response.status}`);
  const data = await response.json();
  return { ok: data && data.ok === true, invalid: !(data && data.ok === true) };
}

async function getGoogleAccessToken() {
  return googleAuth.getAccessToken();
}

async function getDriveMetadata() {
  if (metadataCache && metadataCache.expiresAt > Date.now()) return metadataCache.value;

  const accessToken = await getGoogleAccessToken();
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(DRIVE_FILE_ID)}`);
  url.searchParams.set('fields', 'id,name,mimeType,size,md5Checksum,modifiedTime,capabilities(canDownload)');
  url.searchParams.set('supportsAllDrives', 'true');

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    console.error('Drive metadata request failed:', response.status, detail.slice(0, 300));
    throw new Error('drive_metadata_failed');
  }

  const file = await response.json();
  if (file.id !== DRIVE_FILE_ID || file.mimeType !== 'video/mp4' ||
      !/^\d+$/.test(String(file.size || '')) || file.capabilities?.canDownload === false) {
    throw new Error('drive_file_not_downloadable_mp4');
  }

  metadataCache = { value: file, expiresAt: Date.now() + 5 * 60 * 1000 };
  return file;
}

function validRangeHeader(range) {
  if (!range) return true;
  if (range.length > 100 || range.includes(',')) return false;
  return /^bytes=(?:\d+-\d*|-\d+)$/.test(range);
}

function setVideoHeaders(res, metadata, upstreamHeaders = null) {
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Content-Disposition', 'inline; filename="hismar-training.mp4"');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const headers = upstreamHeaders;
  if (headers) {
    for (const name of ['content-length', 'content-range', 'last-modified', 'etag']) {
      const value = headers.get(name);
      if (value) res.setHeader(name, value);
    }
  } else {
    res.setHeader('Content-Length', String(metadata.size));
    if (metadata.modifiedTime) res.setHeader('Last-Modified', new Date(metadata.modifiedTime).toUTCString());
    if (metadata.md5Checksum) res.setHeader('ETag', '"' + metadata.md5Checksum + '"');
  }
}

async function handleTicket(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
  }
  if (!req.headers.origin || !ALLOWED_ORIGINS.has(req.headers.origin)) {
    return sendJson(res, 403, { ok: false, error: 'origin_not_allowed' });
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { ok: false, error: 'invalid_request' });
  }

  try {
    const session = await verifyHismarSession(body.token);
    if (!session.ok) return sendJson(res, 401, { ok: false, error: 'session_invalid' });
    return sendJson(res, 200, {
      ok: true,
      ticket: issueTicket(),
      expiresIn: TICKET_TTL_SECONDS
    });
  } catch (error) {
    console.error('Ticket issuance failed:', error.message || error);
    return sendJson(res, 503, { ok: false, error: 'auth_service_unavailable' });
  }
}

async function handleStream(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
  }
  if (req.headers.origin && !ALLOWED_ORIGINS.has(req.headers.origin)) {
    return sendJson(res, 403, { ok: false, error: 'origin_not_allowed' });
  }

  const ticket = url.searchParams.get('ticket');
  if (!verifyTicket(ticket)) return sendJson(res, 401, { ok: false, error: 'ticket_expired_or_invalid' });

  const range = req.headers.range;
  if (!validRangeHeader(range)) {
    return sendJson(res, 416, { ok: false, error: 'invalid_range' });
  }

  let metadata;
  try {
    metadata = await getDriveMetadata();
  } catch (error) {
    console.error('Drive metadata unavailable:', error.message || error);
    return sendJson(res, 502, { ok: false, error: 'video_storage_unavailable' });
  }

  if (req.method === 'HEAD') {
    setVideoHeaders(res, metadata);
    res.statusCode = 200;
    return res.end();
  }

  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const accessToken = await getGoogleAccessToken();
    const driveUrl = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(DRIVE_FILE_ID)}`);
    driveUrl.searchParams.set('alt', 'media');
    driveUrl.searchParams.set('supportsAllDrives', 'true');

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Accept-Encoding': 'identity'
    };
    if (range) headers.Range = range;

    const upstream = await fetch(driveUrl, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: controller.signal
    });

    if (upstream.status === 416) {
      const contentRange = upstream.headers.get('content-range');
      if (contentRange) res.setHeader('Content-Range', contentRange);
      res.setHeader('Accept-Ranges', 'bytes');
      return sendJson(res, 416, { ok: false, error: 'range_not_satisfiable' });
    }

    if (!upstream.ok || (range && upstream.status !== 206) ||
        (!range && upstream.status !== 200 && upstream.status !== 206)) {
      console.error('Drive media request failed:', upstream.status, 'range:', Boolean(range));
      await upstream.body?.cancel().catch(() => {});
      return sendJson(res, 502, { ok: false, error: 'video_stream_unavailable' });
    }

    setVideoHeaders(res, metadata, upstream.headers);
    res.statusCode = upstream.status;
    if (!upstream.body) return res.end();

    await new Promise((resolve, reject) => {
      const source = Readable.fromWeb(upstream.body);
      source.on('error', reject);
      res.on('error', reject);
      res.on('finish', resolve);
      source.pipe(res);
    });
  } catch (error) {
    if (error.name === 'AbortError') return;
    console.error('Video proxy failed:', error.message || error);
    if (!res.headersSent) sendJson(res, 502, { ok: false, error: 'video_stream_unavailable' });
    else res.destroy(error);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/healthz' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'OPTIONS') {
    if (!applyCors(req, res)) return sendJson(res, 403, { ok: false, error: 'origin_not_allowed' });
    res.statusCode = 204;
    return res.end();
  }

  if (!applyCors(req, res)) return sendJson(res, 403, { ok: false, error: 'origin_not_allowed' });

  if (url.pathname === '/api/playback-ticket') return handleTicket(req, res);
  if (url.pathname === '/stream') return handleStream(req, res, url);

  return sendJson(res, 404, { ok: false, error: 'not_found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Hismar video service listening on port ${PORT}`);
});
