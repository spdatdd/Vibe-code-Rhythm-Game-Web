/**
 * Làm sạch luồng FLAC trước khi đưa vào Web Audio decodeAudioData:
 * Bỏ thẻ ID3v2 đầu tệp (nếu có) và loại bỏ các khối metadata phụ (như PICTURE lỗi thiếu MIME type
 * khiến FFmpeg/Chromium báo EncodingError), chỉ giữ khối STREAMINFO chuẩn và toàn bộ khung âm thanh.
 */
export function sanitizeFlacBuffer(arrayBuffer) {
  if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength < 42) return arrayBuffer;
  const data = new Uint8Array(arrayBuffer);
  let offset = 0;

  // Bỏ qua các thẻ ID3v2 ở đầu tệp nếu trình gắn thẻ chèn trước chữ ký "fLaC".
  while (
    offset + 10 <= data.length &&
    data[offset] === 0x49 &&
    data[offset + 1] === 0x44 &&
    data[offset + 2] === 0x33 &&
    data[offset + 3] < 0xff &&
    data[offset + 4] < 0xff
  ) {
    const flags = data[offset + 5];
    const bodySize =
      ((data[offset + 6] & 0x7f) << 21) |
      ((data[offset + 7] & 0x7f) << 14) |
      ((data[offset + 8] & 0x7f) << 7) |
      (data[offset + 9] & 0x7f);
    const footer = flags & 0x10 ? 10 : 0;
    const nextOffset = offset + 10 + bodySize + footer;
    if (nextOffset <= offset || nextOffset >= data.length) break;
    offset = nextOffset;
    while (offset < data.length && data[offset] === 0x00 && offset < nextOffset + 4096) offset++;
  }

  if (
    offset + 42 > data.length ||
    data[offset] !== 0x66 ||
    data[offset + 1] !== 0x4c ||
    data[offset + 2] !== 0x61 ||
    data[offset + 3] !== 0x43
  ) {
    return arrayBuffer;
  }

  let pos = offset + 4;
  let streamInfoStart = -1;
  let audioStart = -1;

  while (pos + 4 <= data.length) {
    const header = data[pos];
    const isLast = (header & 0x80) !== 0;
    const blockType = header & 0x7f;
    const blockLen = (data[pos + 1] << 16) | (data[pos + 2] << 8) | data[pos + 3];
    if (blockType === 127 || pos + 4 + blockLen > data.length) return arrayBuffer;
    if (blockType === 0) {
      if (blockLen !== 34) return arrayBuffer;
      if (streamInfoStart < 0) streamInfoStart = pos + 4;
    }
    pos += 4 + blockLen;
    if (isLast) {
      audioStart = pos;
      break;
    }
  }

  if (streamInfoStart < 0 || audioStart < 0 || audioStart >= data.length) return arrayBuffer;
  if (offset === 0 && audioStart === 42) return arrayBuffer;

  const audioLen = data.length - audioStart;
  const clean = new Uint8Array(42 + audioLen);
  clean[0] = 0x66;
  clean[1] = 0x4c;
  clean[2] = 0x61;
  clean[3] = 0x43;
  clean[4] = 0x80; // is_last = 1, block_type = 0 (STREAMINFO)
  clean[5] = 0x00;
  clean[6] = 0x00;
  clean[7] = 0x22; // 34 bytes
  clean.set(data.subarray(streamInfoStart, streamInfoStart + 34), 8);
  clean.set(data.subarray(audioStart), 42);
  return clean.buffer;
}

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
    return audio.decodeAudioData(sanitizeFlacBuffer(bytes));
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
