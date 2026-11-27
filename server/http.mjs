import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { handleApiRoute, json } from './routes.mjs';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Tạo HTTP server với lớp bảo vệ Host/Origin/Secret và phục vụ tệp tĩnh. */
export function createAppServer({ publicRoot, port, hosted, backendSecret }) {
  return http.createServer(async (req, res) => {
    try {
      const host = req.headers.host;
      const origin = `http://${host}`;
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);

      if (hosted) {
        if (pathname === '/healthz' && req.method === 'GET') {
          json(res, 200, { ok: true });
          return;
        }
        const supplied = Buffer.from(req.headers['x-orbit-backend-key'] || '');
        if (!pathname.startsWith('/api/') || supplied.length !== backendSecret.length || !timingSafeEqual(supplied, backendSecret)) {
          json(res, 403, { error: 'Truy cập bị từ chối.' });
          return;
        }
      } else if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) {
        json(res, 403, { error: 'Host không được phép.' });
        return;
      }

      if (pathname.startsWith('/api/')) {
        if (!hosted && ((req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site')) {
          json(res, 403, { error: 'Chỉ cho phép cùng nguồn.' });
          return;
        }
        await handleApiRoute(req, res, pathname);
        return;
      }

      if (!['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405).end();
        return;
      }
      const file = path.resolve(publicRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(publicRoot + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      const data = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      json(res, error.status || (error.code === 'ENOENT' ? 404 : 500), {
        error: error.status ? error.message : 'Không xử lý được yêu cầu. Hãy thử lại.',
      });
    }
  });
}
