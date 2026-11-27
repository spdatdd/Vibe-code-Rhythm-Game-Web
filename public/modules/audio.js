/** Quản lý Web Audio: đồng hồ đầu ra và phát AudioBuffer. */
export function createAudioEngine({ onBufferEnded }) {
  let context = null;
  let musicSource = null;

  async function ensureRunning() {
    context ||= new AudioContext();
    if (context.state !== 'running') await context.resume();
    return context;
  }

  function currentTime() {
    return context ? context.currentTime : 0;
  }

  /** Lấy mốc thời gian âm thanh thực tế đi ra thiết bị phát hiện tại. */
  function outputClock() {
    if (!context) return 0;
    const stamp = context.getOutputTimestamp?.();
    if (stamp?.contextTime > 0 && stamp.performanceTime > 0) {
      return Math.min(
        context.currentTime,
        stamp.contextTime + Math.max(0, performance.now() - stamp.performanceTime) / 1000,
      );
    }
    return context.currentTime - (context.outputLatency || context.baseLatency || 0);
  }

  async function decode(bytes) {
    const audio = await ensureRunning();
    return audio.decodeAudioData(bytes);
  }

  function stopBuffer() {
    if (!musicSource) return;
    musicSource.onended = null;
    try { musicSource.stop(); } catch {}
    musicSource.disconnect();
    musicSource = null;
  }

  function playBuffer(buffer, position) {
    stopBuffer();
    const delay = .08 + Math.max(0, -position);
    const offset = Math.max(0, position);
    const anchor = context.currentTime + delay - offset;
    musicSource = context.createBufferSource();
    musicSource.buffer = buffer;
    musicSource.connect(context.destination);
    // Hoàn tất lượt khi chính nguồn âm thanh kết thúc, không dựa vào timer JavaScript.
    musicSource.onended = () => onBufferEnded?.();
    musicSource.start(context.currentTime + delay, offset);
    return anchor;
  }

  return {
    ensureRunning,
    currentTime,
    outputClock,
    decode,
    playBuffer,
    stopBuffer,
  };
}
