const backendSecret = process.env.ORBIT_BACKEND_SECRET || '';

// Chỉ chuyển API game tới địa chỉ HTTPS của Render được đặt trong môi trường Netlify.
function getBackendOrigin() {
  try {
    const url = new URL(process.env.ORBIT_BACKEND_URL);
    if (url.protocol === 'https:' && url.hostname.endsWith('.onrender.com') &&
        !url.port && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash) {
      return url.origin;
    }
  } catch {}
  return null;
}

// Trả lỗi JSON cho giao diện và tránh cache kết quả chuẩn bị bài nhạc.
function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

// Lấy trạng thái proxy ngay cả khi Render đang ngủ, rồi chuyển tiếp yêu cầu bằng khóa nội bộ.
export default async function handleRequest(request) {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  if ((origin && origin !== url.origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
    return json({ error: 'Chỉ cho phép cùng nguồn.' }, 403);
  }

  const backend = getBackendOrigin();
  const configured = Boolean(backend && Buffer.byteLength(backendSecret) >= 32);
  if (url.pathname === '/api/capabilities' && request.method === 'GET') {
    return json({ youtubeAnalysis: configured });
  }

  const track = /^\/api\/tracks\/[\w-]{11}(?:\/(result|audio))?$/.exec(url.pathname);
  const prepare = url.pathname === '/api/prepare' && request.method === 'POST';
  const trackRequest = track && (['GET', 'HEAD'].includes(request.method) ||
    (request.method === 'DELETE' && !track[1]));
  if (!prepare && !trackRequest) return json({ error: 'Không tìm thấy API.' }, 404);
  if (!configured) return json({ error: 'Chưa cấu hình máy chủ phân tích trên Netlify.' }, 503);

  const headers = new Headers({ 'X-Orbit-Backend-Key': backendSecret });
  for (const name of ['content-type', 'range']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  // Giới hạn thời gian chờ header, sau đó chuyển WAV dạng luồng và giữ nguyên thông tin Range.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const upstream = await fetch(backend + url.pathname, {
      method: request.method,
      headers,
      ...(prepare && request.body ? { body: request.body, duplex: 'half' } : {}),
      redirect: 'manual',
      signal: AbortSignal.any([request.signal, controller.signal]),
    });
    if (upstream.status === 403) {
      await upstream.body?.cancel();
      return json({ error: 'Khóa kết nối giữa Netlify và máy chủ không khớp.' }, 502);
    }
    const contentType = upstream.headers.get('content-type') || '';
    if ([502, 503, 504].includes(upstream.status) ||
        (!/^(application\/json|audio\/wav)\b/i.test(contentType) && upstream.status !== 416)) {
      await upstream.body?.cancel();
      return json({ error: 'Máy chủ phân tích đang khởi động hoặc tạm thời chưa phản hồi.', code: 'BACKEND_STARTING' }, 503);
    }
    const forwarded = new Headers({ 'Cache-Control': 'no-store' });
    for (const name of ['content-type', 'accept-ranges', 'content-range', 'content-length']) {
      const value = upstream.headers.get(name);
      if (value && (name !== 'content-length' || !upstream.headers.has('content-encoding'))) forwarded.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers: forwarded });
  } catch {
    return json({ error: 'Máy chủ phân tích đang khởi động hoặc tạm thời chưa phản hồi.', code: 'BACKEND_STARTING' }, 503);
  } finally {
    clearTimeout(timer);
  }
}
