import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from './db.mjs';
import { handleApi } from './api.mjs';
import { cleanupSessions, userFromToken } from './auth.mjs';
import { AppError } from './util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOAD_DIR = process.env.SRK_UPLOAD_DIR
  ? path.resolve(process.env.SRK_UPLOAD_DIR)
  : path.join(ROOT, 'storage', 'uploads');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

export const SESSION_COOKIE = 'srk_session';

migrate();
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
cleanupSessions();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

async function readJson(req, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new AppError(413, 'Слишком большой запрос');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError(400, 'Тело запроса должно быть корректным JSON');
  }
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  let stat;
  try { stat = fs.statSync(filePath); } catch { stat = null; }
  if (!stat || !stat.isFile()) {
    const index = path.join(PUBLIC_DIR, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
    fs.createReadStream(index).pipe(res);
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const revalidate = ext === '.html' || ext === '.js' || ext === '.css';
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': revalidate ? 'no-cache' : 'public, max-age=300',
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const remote = req.socket.remoteAddress || '';
  const trustProxy = process.env.SRK_TRUST_PROXY === '1';
  const fromLocalProxy = trustProxy || remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const forwardedProto = fromLocalProxy ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() : '';
  const secureCookie = process.env.SECURE_COOKIES === '1' || forwardedProto === 'https';
  const forwardedFor = fromLocalProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  const clientIp = forwardedFor || remote;
  if (url.pathname === '/api/health') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
  }
  try {
    if (url.pathname.startsWith('/api/')) {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE] || null;
      const user = userFromToken(token);

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const origin = req.headers.origin;
        if (origin) {
          const originHost = (() => { try { return new URL(origin).host; } catch { return null; } })();
          if (originHost !== req.headers.host) throw new AppError(403, 'Запрос с чужого источника отклонён');
        }
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '') && url.pathname !== '/api/auth/logout') {
          throw new AppError(415, 'Ожидается Content-Type: application/json');
        }
      }

      let body = {};
      if (req.method !== 'GET' && req.method !== 'HEAD') body = await readJson(req);

      const result = await handleApi({
        req, res, url, user, token, body, ip: clientIp,
        setSessionCookie(tokenValue, expiresAt) {
          const parts = [
            `${SESSION_COOKIE}=${encodeURIComponent(tokenValue)}`,
            'Path=/',
            'HttpOnly',
            'SameSite=Strict',
            ...(secureCookie ? ['Secure'] : []),
            `Expires=${new Date(expiresAt).toUTCString()}`,
          ];
          res.setHeader('Set-Cookie', parts.join('; '));
        },
        clearSessionCookie() {
          const parts = [
            `${SESSION_COOKIE}=`,
            'Path=/',
            'HttpOnly',
            'SameSite=Strict',
            ...(secureCookie ? ['Secure'] : []),
            'Max-Age=0',
          ];
          res.setHeader('Set-Cookie', parts.join('; '));
        },
        sendFile(filePath, contentType, downloadName) {
          const stat = fs.statSync(filePath);
          const headers = {
            'Content-Type': contentType,
            'Content-Length': stat.size,
            'Cache-Control': 'private, max-age=60',
          };
          if (downloadName) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
          res.writeHead(200, headers);
          fs.createReadStream(filePath).pipe(res);
        },
        sendCsv(fileName, csv) {
          const buf = Buffer.from(csv, 'utf8');
          res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
            'Content-Length': buf.length,
            'Cache-Control': 'no-store',
          });
          res.end(buf);
        },
        sendJson: (status, payload) => sendJson(res, status, payload),
      });
      if (result !== undefined && !res.headersSent) sendJson(res, 200, result);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('Method Not Allowed');
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (err) {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (err instanceof AppError) {
      sendJson(res, err.status, { error: err.message, details: err.details || null });
      return;
    }
    console.error('[error]', err);
    sendJson(res, 500, { error: 'Внутренняя ошибка сервера' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Stockroom Kids запущен: http://${HOST}:${PORT}`);
});
