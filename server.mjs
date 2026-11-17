import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { videoId } from './public/engine.js';
import { startJob, getJob, cancelJob, cachedResult, cacheRoot } from './analysis/jobs.mjs';
const root = path.resolve(fileURLToPath(new URL('./public/', import.meta.url)));
const port = process.env.PORT || '5173';
const hosted = process.env.ORBIT_HOSTED === '1';
const backendSecret = Buffer.from(process.env.ORBIT_BACKEND_SECRET || '');
if (hosted && backendSecret.length < 32) throw new Error('ORBIT_BACKEND_SECRET cần có ít nhất 32 ký tự.');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
// Trả JSON nhất quán cho tiến độ, kết quả và lỗi.
function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
// Đọc body nhỏ với giới hạn dung lượng để bảo vệ API cục bộ.
async function body(req) {
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > 4096) { const error = new Error('Yêu cầu quá lớn.'); error.status = 413; throw error; } }
  try { return JSON.parse(data); } catch { const error = new Error('JSON không hợp lệ.'); error.status = 400; throw error; }
}
// Phục vụ tệp PCM đã phân tích, hỗ trợ Range và hủy luồng khi client ngắt kết nối.
async function serveAudio(req, res, file) {
  const { size } = await stat(file);
  const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  let start = 0, end = size - 1;
  if (req.headers.range && !range) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
  if (range) { start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), end) : end; }
  if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
  res.writeHead(range ? 206 : 200, { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
  if (req.method === 'HEAD') { res.end(); return; }
  const stream = createReadStream(file, { start, end });
  // Giải phóng tài nguyên khi hoàn tất hoặc khi tải âm thanh bị hủy.
  res.on('close', () => stream.destroy()); stream.on('error', () => res.destroy()); stream.pipe(res);
}
// Chỉ nhận Host localhost và Origin cùng nguồn để trang web khác không kích hoạt tải ngầm.
const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host;
    const origin = `http://${host}`;
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (hosted) {
      // Chỉ công khai dấu hiệu tiến trình còn hoạt động cho kiểm tra sức khỏe của Render.
      if (pathname === '/healthz' && req.method === 'GET') { json(res, 200, { ok: true }); return; }
      const supplied = Buffer.from(req.headers['x-orbit-backend-key'] || '');
      if (!pathname.startsWith('/api/') || supplied.length !== backendSecret.length ||
          !timingSafeEqual(supplied, backendSecret)) { json(res, 403, { error: 'Truy cập bị từ chối.' }); return; }
    } else if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) {
      json(res, 403, { error: 'Host không được phép.' }); return;
    }
    if (pathname.startsWith('/api/')) {
      if (!hosted && ((req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site')) { json(res, 403, { error: 'Chỉ cho phép cùng nguồn.' }); return; }
      // Cho giao diện biết máy chủ hiện tại có hỗ trợ phân tích YouTube.
      if (pathname === '/api/capabilities' && req.method === 'GET') {
        json(res, 200, { youtubeAnalysis: true }); return;
      }
      if (pathname === '/api/prepare' && req.method === 'POST') {
        if (!req.headers['content-type']?.startsWith('application/json')) { json(res, 415, { error: 'Cần Content-Type application/json.' }); return; }
        const input = await body(req), id = videoId(typeof input?.url === 'string' ? input.url : '');
        if (!id) { json(res, 400, { error: 'Link YouTube không hợp lệ.' }); return; }
        json(res, 202, await startJob(id)); return;
      }
      const match = pathname.match(/^\/api\/tracks\/([\w-]{11})(?:\/(result|audio))?$/);
      if (!match) { json(res, 404, { error: 'Không tìm thấy API.' }); return; }
      const [, id, action] = match;
      if (req.method === 'DELETE' && !action) { json(res, 200, { cancelled: cancelJob(id) }); return; }
      if (!['GET', 'HEAD'].includes(req.method)) { json(res, 405, { error: 'Phương thức không được phép.' }); return; }
      if (!action) { const job = await getJob(id); json(res, job ? 200 : 404, job || { error: 'Chưa có tác vụ.' }); return; }
      const result = await cachedResult(id);
      if (!result) { json(res, 409, { error: 'Bài nhạc chưa phân tích xong.' }); return; }
      if (action === 'result') { json(res, 200, result); return; }
      await serveAudio(req, res, path.join(cacheRoot, id, 'audio.wav')); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': `${types[path.extname(file)] || 'application/octet-stream'}; charset=utf-8`,
      'Cache-Control': 'no-cache', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (error) {
    if (res.headersSent) { res.destroy(); return; }
    json(res, error.status || (error.code === 'ENOENT' ? 404 : 500), { error: error.status ? error.message : 'Không xử lý được yêu cầu. Hãy thử lại.' });
  }
});
// Bản cục bộ nghe loopback; bản Render nhận kết nối của proxy trên cổng được cấp.
const bindAddress = hosted ? '0.0.0.0' : '127.0.0.1';
server.listen(Number(port), bindAddress, () => console.log(`Orbit Rhythm: http://${bindAddress}:${port}`));
// Báo lỗi cổng đang dùng bằng hướng dẫn dễ hiểu.
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'Game đang chạy ở cổng này. Tắt cửa sổ server cũ trước khi chạy lại.' : error.message); process.exitCode = 1; });
