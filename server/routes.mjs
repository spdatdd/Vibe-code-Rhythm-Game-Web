import path from 'node:path';
import { videoId } from '../public/engine.js';
import { startJob, getJob, cancelJob } from '../analysis/jobs.mjs';
import { cachedResult, cacheRoot, audioAsset } from '../analysis/cache.mjs';
import { serveMedia } from './media.mjs';

/** Trả JSON nhất quán cho tiến độ, kết quả và lỗi. */
export function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

/** Đọc body JSON nhỏ với giới hạn 4 KB để bảo vệ API cục bộ. */
async function readJsonBody(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 4096) {
      const error = new Error('Yêu cầu quá lớn.');
      error.status = 413;
      throw error;
    }
  }
  try {
    return JSON.parse(data);
  } catch {
    const error = new Error('JSON không hợp lệ.');
    error.status = 400;
    throw error;
  }
}

/** Xử lý toàn bộ các endpoint /api/* cho chuẩn bị, theo dõi và truyền phát bài nhạc. */
export async function handleApiRoute(req, res, pathname) {
  if (pathname === '/api/capabilities' && req.method === 'GET') {
    json(res, 200, { youtubeAnalysis: true });
    return;
  }
  if (pathname === '/api/prepare' && req.method === 'POST') {
    if (!req.headers['content-type']?.startsWith('application/json')) {
      json(res, 415, { error: 'Cần Content-Type application/json.' });
      return;
    }
    const input = await readJsonBody(req);
    const id = videoId(typeof input?.url === 'string' ? input.url : '');
    if (!id) {
      json(res, 400, { error: 'Link YouTube không hợp lệ.' });
      return;
    }
    json(res, 202, await startJob(id));
    return;
  }
  const match = pathname.match(/^\/api\/tracks\/([\w-]{11})(?:\/(result|audio|video))?$/);
  if (!match) {
    json(res, 404, { error: 'Không tìm thấy API.' });
    return;
  }
  const [, id, action] = match;
  if (req.method === 'DELETE' && !action) {
    json(res, 200, { cancelled: cancelJob(id) });
    return;
  }
  if (!['GET', 'HEAD'].includes(req.method)) {
    json(res, 405, { error: 'Phương thức không được phép.' });
    return;
  }
  if (!action) {
    const job = await getJob(id);
    json(res, job ? 200 : 404, job || { error: 'Chưa có tác vụ.' });
    return;
  }
  const result = await cachedResult(id);
  if (!result) {
    json(res, 409, { error: 'Bài nhạc chưa phân tích xong.' });
    return;
  }
  if (action === 'result') {
    json(res, 200, result);
    return;
  }
  if (action === 'video') {
    if (!result.hasVideo) {
      json(res, 404, { error: 'Bài này chưa có video nền.' });
      return;
    }
    await serveMedia(req, res, path.join(cacheRoot, id, 'background.mp4'), 'video/mp4');
    return;
  }
  const asset = audioAsset(result);
  await serveMedia(req, res, path.join(cacheRoot, id, asset.file), asset.type);
}
