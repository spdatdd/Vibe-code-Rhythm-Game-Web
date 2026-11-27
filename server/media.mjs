import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

/** Truyền âm thanh hoặc video, hỗ trợ HTTP Range để trình phát tua và đệm từng đoạn. */
export async function serveMedia(req, res, file, contentType) {
  const { size } = await stat(file);
  const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  let start = 0;
  let end = size - 1;
  if (req.headers.range && !range) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
    return;
  }
  if (range) {
    start = Number(range[1]);
    end = range[2] ? Math.min(Number(range[2]), end) : end;
  }
  if (start > end || start >= size) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
    return;
  }
  res.writeHead(range ? 206 : 200, {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(file, { start, end });
  // Giải phóng tài nguyên khi hoàn tất hoặc khi tải âm thanh bị hủy.
  res.on('close', () => stream.destroy());
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}
