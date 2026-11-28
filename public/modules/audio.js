/** Quản lý Web Audio: đồng hồ đầu ra, phát AudioBuffer và trích xuất dữ liệu FFT. */
export function createAudioEngine({ onBufferEnded }) {
  let context = null;
  let musicSource = null;
  let analyser = null;
  let freqBins = new Uint8Array(128);
  let timeBins = new Uint8Array(128).fill(128);

  function ensureAnalyser(audioCtx) {
    if (!analyser) {
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.78;
      analyser.connect(audioCtx.destination);
      freqBins = new Uint8Array(analyser.frequencyBinCount);
      timeBins = new Uint8Array(analyser.frequencyBinCount).fill(128);
    }
    return analyser;
  }

  function averageRange(arr, start, end) {
    const hi = Math.min(arr.length, end);
    if (hi <= start) return 0;
    let sum = 0;
    for (let i = start; i < hi; i++) sum += arr[i];
    return sum / ((hi - start) * 255);
  }

  /** Lấy dữ liệu tần số & biên độ thời gian thực để vẽ trực quan hóa. */
  function sampleVisualization() {
    if (!analyser || !musicSource) {
      freqBins.fill(0);
      timeBins.fill(128);
      return { freqBins, timeBins, bass: 0, mid: 0, treble: 0, energy: 0, active: false };
    }
    analyser.getByteFrequencyData(freqBins);
    analyser.getByteTimeDomainData(timeBins);
    const bass = averageRange(freqBins, 0, 8);
    const mid = averageRange(freqBins, 8, 32);
    const treble = averageRange(freqBins, 32, 96);
    const energy = averageRange(freqBins, 0, 96);
    return { freqBins, timeBins, bass, mid, treble, energy, active: true };
  }

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
    musicSource.connect(ensureAnalyser(context));
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
    sampleVisualization,
  };
}
