/** Phân tích mảng PCM đơn kênh trên trình duyệt để tìm các điểm khởi âm (onset). */
export function analyzeChannelData(samples, sampleRate) {
  if (!samples?.length || !sampleRate) {
    throw new Error('Dữ liệu âm thanh không hợp lệ.');
  }
  const duration = samples.length / sampleRate;
  if (duration < 5) {
    throw new Error('Bài nhạc quá ngắn (cần tối thiểu 5 giây).');
  }

  const hop = Math.max(256, Math.round(sampleRate * 0.012));
  const frameSize = hop * 2;
  const frameCount = Math.floor((samples.length - frameSize) / hop) + 1;
  if (frameCount < 16) {
    throw new Error('Không đủ dữ liệu để tạo bản đồ nốt.');
  }

  let peak = 0;
  const lowBand = new Float32Array(frameCount);
  const highBand = new Float32Array(frameCount);
  const totalEnergy = new Float32Array(frameCount);

  for (let f = 0; f < frameCount; f++) {
    const start = f * hop;
    let sumSq = 0;
    let diffSq = 0;
    let prev = samples[start];
    for (let i = 0; i < frameSize; i++) {
      const s = samples[start + i];
      const abs = s < 0 ? -s : s;
      if (abs > peak) peak = abs;
      sumSq += s * s;
      const d = s - prev;
      diffSq += d * d;
      prev = s;
    }
    const rms = Math.sqrt(sumSq / frameSize);
    const hf = Math.sqrt(diffSq / frameSize);
    totalEnergy[f] = rms;
    highBand[f] = hf;
    lowBand[f] = Math.max(0, rms - hf * 0.35);
  }

  if (peak < 0.0005) {
    throw new Error('Tệp âm thanh bị im lặng.');
  }

  // Tính phổ biến thiên năng lượng (spectral flux đơn giản hóa) theo từng khung.
  const flux = new Float32Array(frameCount);
  for (let f = 1; f < frameCount; f++) {
    const dTotal = Math.max(0, totalEnergy[f] - totalEnergy[f - 1]);
    const dHigh = Math.max(0, highBand[f] - highBand[f - 1]);
    flux[f] = dTotal + dHigh * 0.65;
  }

  // Ngưỡng thích nghi cục bộ bằng trung bình trượt 2 chiều.
  const windowHalf = 10;
  const minGapFrames = Math.max(3, Math.round((0.06 * sampleRate) / hop));
  const rawPeaks = [];
  let lastPeakFrame = -minGapFrames;

  for (let f = 2; f < frameCount - 2; f++) {
    if (flux[f] <= flux[f - 1] || flux[f] < flux[f + 1]) continue;
    let sum = 0;
    let count = 0;
    const from = Math.max(0, f - windowHalf);
    const to = Math.min(frameCount - 1, f + windowHalf);
    for (let k = from; k <= to; k++) {
      sum += flux[k];
      count++;
    }
    const localMean = sum / count;
    if (flux[f] > localMean * 1.45 + 0.004 && f - lastPeakFrame >= minGapFrames) {
      rawPeaks.push(f);
      lastPeakFrame = f;
    }
  }

  if (rawPeaks.length < 8) {
    throw new Error('Không tìm thấy đủ nhịp rõ ràng trong tệp âm thanh này.');
  }

  const strengths = rawPeaks.map(f => flux[f]).sort((a, b) => a - b);
  const scale = strengths[Math.floor(strengths.length * 0.9)] || 1;
  const events = [];

  for (const frame of rawPeaks) {
    const time = (frame * hop) / sampleRate;
    if (time < 0.05 || time > duration - 0.15) continue;
    const brightnessRatio = highBand[frame] / Math.max(totalEnergy[frame], 0.0001);
    events.push({
      time: Number(time.toFixed(5)),
      strength: Number(Math.min(1, flux[frame] / Math.max(scale, 0.00001)).toFixed(4)),
      brightness: Number((brightnessRatio * 1000).toFixed(2)),
    });
  }

  return { duration: Number(duration.toFixed(5)), events };
}

/** Trộn các kênh của AudioBuffer sang mono và phân tích bản đồ nốt trực tiếp trên thiết bị. */
export function analyzeAudioBuffer(audioBuffer) {
  const { numberOfChannels, length, sampleRate } = audioBuffer;
  const mono = new Float32Array(length);
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const channel = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      mono[i] += channel[i] / numberOfChannels;
    }
  }
  return analyzeChannelData(mono, sampleRate);
}
