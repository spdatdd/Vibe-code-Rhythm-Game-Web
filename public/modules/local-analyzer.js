/** Ước lượng BPM (nội suy dưới mức khung) và pha phách chính từ đường bao flux. */
function estimateBeatGrid(flux, fps) {
  const minBpm = 70;
  const maxBpm = 170;
  const minLag = Math.max(4, Math.floor((60 / maxBpm) * fps));
  const maxLag = Math.min(Math.floor(flux.length / 3), Math.ceil((60 / minBpm) * fps));
  if (maxLag <= minLag) return null;

  let mean = 0;
  for (let i = 0; i < flux.length; i++) mean += flux[i];
  mean /= flux.length;
  const centered = new Float32Array(flux.length);
  for (let i = 0; i < flux.length; i++) centered[i] = Math.max(0, flux[i] - mean * 0.85);

  const scores = new Float64Array(maxLag + 1);
  let bestLag = 0;
  let bestScore = -Infinity;
  let scoreSum = 0;
  let scoreCount = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    const limit = centered.length - lag;
    for (let i = 0; i < limit; i++) {
      corr += centered[i] * centered[i + lag];
    }
    const bpm = (60 * fps) / lag;
    const tempoPrior = Math.exp(-0.5 * (Math.log2(bpm / 118) / 0.45) ** 2);
    const score = (corr / limit) * (0.65 + 0.35 * tempoPrior);
    scores[lag] = score;
    scoreSum += score;
    scoreCount++;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  const meanScore = scoreCount ? scoreSum / scoreCount : 0;
  // Chỉ dùng lưới phách toàn cục khi bài hát có nhịp đều rõ rệt (tránh lệch pha ở nhạc rubato).
  if (!bestLag || meanScore <= 0 || bestScore / meanScore < 3.2) return null;

  // Nội suy parabol quanh đỉnh để lấy chu kỳ phách chính xác dưới 1 khung hình.
  let refinedLag = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const s0 = scores[bestLag - 1];
    const s1 = scores[bestLag];
    const s2 = scores[bestLag + 1];
    const denom = s0 - 2 * s1 + s2;
    if (denom < -1e-12) {
      refinedLag = bestLag + 0.5 * (s0 - s2) / denom;
    }
  }

  const beatSec = refinedLag / fps;
  let bestPhase = 0;
  let bestPhaseScore = -Infinity;
  const phaseSteps = Math.max(16, Math.round(refinedLag));
  for (let p = 0; p < phaseSteps; p++) {
    const offsetFrames = (p / phaseSteps) * refinedLag;
    let score = 0;
    for (let pos = offsetFrames; pos < centered.length; pos += refinedLag) {
      const i = Math.round(pos);
      if (i >= 0 && i < centered.length) {
        const prev = i > 0 ? centered[i - 1] * 0.5 : 0;
        const next = i + 1 < centered.length ? centered[i + 1] * 0.5 : 0;
        score += centered[i] + prev + next;
      }
    }
    if (score > bestPhaseScore) {
      bestPhaseScore = score;
      bestPhase = offsetFrames;
    }
  }
  return {
    bpm: Number((60 / beatSec).toFixed(2)),
    beatSec,
    beatOffset: Number((bestPhase / fps).toFixed(4)),
  };
}

/** Tính độ khớp của thời điểm t với lưới phách / nửa phách (0..1). */
function computeBeatScore(t, beatGrid) {
  if (!beatGrid) return 0;
  const halfBeat = beatGrid.beatSec / 2;
  const rel = ((t - beatGrid.beatOffset) % halfBeat + halfBeat) % halfBeat;
  const dist = Math.min(rel, halfBeat - rel);
  if (dist > 0.065) return 0;
  const beatRel = ((t - beatGrid.beatOffset) % beatGrid.beatSec + beatGrid.beatSec) % beatGrid.beatSec;
  const isMainBeat = Math.min(beatRel, beatGrid.beatSec - beatRel) <= 0.065;
  const closeness = 1 - dist / 0.065;
  return Number((closeness * (isMainBeat ? 1 : 0.65)).toFixed(3));
}

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
    totalEnergy[f] = Math.sqrt(sumSq / frameSize);
    highBand[f] = Math.sqrt(diffSq / frameSize);
  }

  if (peak < 0.0005) {
    throw new Error('Tệp âm thanh bị im lặng.');
  }

  // Tính phổ biến thiên năng lượng, giảm trọng số nhiễu cao tần để ưu tiên biến thiên theo nhịp.
  const flux = new Float32Array(frameCount);
  for (let f = 1; f < frameCount; f++) {
    const dTotal = Math.max(0, totalEnergy[f] - totalEnergy[f - 1]);
    const dHigh = Math.max(0, highBand[f] - highBand[f - 1]);
    flux[f] = dTotal + dHigh * 0.25;
  }

  const fps = sampleRate / hop;
  const beatGrid = estimateBeatGrid(flux, fps);

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

  for (const peakFrame of rawPeaks) {
    // Lùi về chân khởi âm trước đỉnh flux (tối đa ~24 ms) để khớp đúng thời điểm bắt đầu nốt.
    let onsetFrame = peakFrame;
    const backtrackLimit = Math.max(1, peakFrame - 2);
    while (onsetFrame > backtrackLimit && flux[onsetFrame - 1] < flux[onsetFrame]) {
      onsetFrame--;
    }
    const time = (onsetFrame * hop) / sampleRate;
    if (time < 0.05 || time > duration - 0.15) continue;
    const brightnessRatio = highBand[peakFrame] / Math.max(totalEnergy[peakFrame], 0.0001);
    events.push({
      time: Number(time.toFixed(5)),
      strength: Number(Math.min(1, flux[peakFrame] / Math.max(scale, 0.00001)).toFixed(4)),
      brightness: Number((brightnessRatio * 1000).toFixed(2)),
      beatScore: computeBeatScore(time, beatGrid),
    });
  }

  return {
    duration: Number(duration.toFixed(5)),
    bpm: beatGrid?.bpm || null,
    beatOffset: beatGrid?.beatOffset ?? null,
    events,
  };
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
