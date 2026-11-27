async function requestJson(url, options = {}, signal) {
  const response = await fetch(url, { ...options, signal });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || 'Máy chủ không xử lý được yêu cầu.');
    error.code = data.code;
    throw error;
  }
  return data;
}

/** Chờ giữa các lần kiểm tra tiến độ, hủy ngay lập tức khi có tín hiệu AbortError. */
function pollDelay(signal, milliseconds = 700) {
  return new Promise((resolveDelay, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolveDelay();
    }, milliseconds);
    function abort() {
      clearTimeout(timer);
      reject(new DOMException('Đã hủy', 'AbortError'));
    }
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Thử lại khi host Free đang thức dậy; gửi cùng ID nên server có thể dùng lại tác vụ. */
async function startPreparation(id, signal, onProgress) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestJson('/api/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: id }),
      }, signal);
    } catch (error) {
      if (error.code !== 'BACKEND_STARTING' || attempt >= 7) throw error;
      onProgress(1, 'Đang đánh thức máy chủ phân tích. Lần đầu có thể mất khoảng một phút…');
      await pollDelay(signal, 3000);
    }
  }
}

/** Kiểm tra máy chủ hiện tại có bật phân tích YouTube hay không. */
export async function checkAnalysisSupport() {
  try {
    const response = await fetch('/api/capabilities', { signal: AbortSignal.timeout(5000) });
    return response.ok && (await response.json()).youtubeAnalysis === true;
  } catch {
    return false;
  }
}

/** Gửi yêu cầu phân tích, theo dõi tiến độ và giải mã âm thanh hoàn chỉnh. */
export async function prepareTrack(id, { signal, onProgress, decodeAudio }) {
  let job = await startPreparation(id, signal, onProgress);
  while (job.stage !== 'ready') {
    if (['error', 'cancelled'].includes(job.stage)) throw new Error(job.message);
    onProgress(job.progress * .9, job.message);
    await pollDelay(signal);
    job = await requestJson('/api/tracks/' + id, {}, signal);
  }
  onProgress(92, 'Đã phân tích xong. Đang nạp toàn bộ âm thanh để phát không gián đoạn…');
  const result = await requestJson('/api/tracks/' + id + '/result', {}, signal);
  const response = await fetch('/api/tracks/' + id + '/audio', { signal });
  if (!response.ok) throw new Error('Không tải được âm thanh đã chuẩn bị.');
  const buffer = await decodeAudio(await response.arrayBuffer());
  if (Math.abs(buffer.duration - result.duration) > .1) {
    throw new Error('Độ dài âm thanh không khớp bản phân tích. Hãy chuẩn bị lại.');
  }
  return { result, buffer };
}

/** Gửi lệnh hủy tác vụ chuẩn bị trên máy chủ. */
export async function cancelTrackPreparation(id) {
  if (!id) return;
  try { await fetch('/api/tracks/' + id, { method: 'DELETE' }); } catch {}
}
