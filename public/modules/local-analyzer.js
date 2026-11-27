const TARGET_SR = 22050;
const FFT_SIZE = 1024;
const HOP_SIZE = 256;

const HANN_WINDOW = new Float32Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) {
  HANN_WINDOW[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
}

const BIT_REV = new Uint16Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) {
  let rev = 0;
  let x = i;
  for (let b = 0; b < 10; b++) {
    rev = (rev << 1) | (x & 1);
    x >>= 1;
  }
  BIT_REV[i] = rev;
}

const COS_TABLE = new Float32Array(FFT_SIZE / 2);
const SIN_TABLE = new Float32Array(FFT_SIZE / 2);
for (let i = 0; i < FFT_SIZE / 2; i++) {
  const angle = (-2 * Math.PI * i) / FFT_SIZE;
  COS_TABLE[i] = Math.cos(angle);
  SIN_TABLE[i] = Math.sin(angle);
}

/** Biến đổi FFT tại chỗ (Radix-2 Cooley-Tukey) cho khung kích thước FFT_SIZE. */
function fftInPlace(re, im) {
  for (let i = 0; i < FFT_SIZE; i++) {
    const j = BIT_REV[i];
    if (j > i) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let size = 2; size <= FFT_SIZE; size <<= 1) {
    const half = size >> 1;
    const step = FFT_SIZE / size;
    for (let start = 0; start < FFT_SIZE; start += size) {
      for (let k = 0; k < half; k++) {
        const idx = k * step;
        const cos = COS_TABLE[idx];
        const sin = SIN_TABLE[idx];
        const even = start + k;
        const odd = even + half;
        const tre = re[odd] * cos - im[odd] * sin;
        const tim = re[odd] * sin + im[odd] * cos;
        re[odd] = re[even] - tre;
        im[odd] = im[even] - tim;
        re[even] += tre;
        im[even] += tim;
      }
    }
  }
}

/** Giảm tần số lấy mẫu tuyến tính về ~22.05 kHz khi audio gốc cao hơn để đồng nhất FFT/hop. */
function resampleToTarget(samples, sampleRate) {
  if (sampleRate <= 24000) {
    return { mono: samples, sr: sampleRate };
  }
  const ratio = sampleRate / TARGET_SR;
  const outLength = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = samples[idx];
    const s1 = idx + 1 < samples.length ? samples[idx + 1] : s0;
    out[i] = s0 + (s1 - s0) * frac;
  }
  return { mono: out, sr: TARGET_SR };
}

/** Ước lượng BPM toàn cục từ đường bao onset flux bằng tự tương quan. */
function estimateTempo(flux, fps) {
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
  if (!bestLag || meanScore <= 0 || bestScore / meanScore < 2.2) return null;

  let refinedLag = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const s0 = scores[bestLag - 1];
    const s1 = scores[bestLag];
    const s2 = scores[bestLag + 1];
    const denom = s0 - 2 * s1 + s2;
    if (denom < -1e-12) {
      refinedLag = bestLag + (0.5 * (s0 - s2)) / denom;
    }
  }
  return {
    bpm: Number(((60 * fps) / refinedLag).toFixed(2)),
    periodFrames: refinedLag,
    centered,
  };
}

/** Bám chuỗi phách bằng quy hoạch động (kiểu beat_track) để chịu được dao động tempo nhẹ. */
function trackBeats(tempoInfo, fps) {
  if (!tempoInfo) return { beatTimes: [], beatOffset: null };
  const { periodFrames, centered } = tempoInfo;
  const n = centered.length;
  const minPrev = Math.max(2, Math.round(periodFrames * 0.5));
  const maxPrev = Math.round(periodFrames * 1.8);
  const cumScore = new Float64Array(n);
  const backLink = new Int32Array(n).fill(-1);
  const tightness = 100;

  let maxFlux = 0;
  for (let i = 0; i < n; i++) {
    if (centered[i] > maxFlux) maxFlux = centered[i];
  }
  const norm = maxFlux > 0 ? 1 / maxFlux : 1;

  for (let i = 0; i < n; i++) {
    const localOnset = centered[i] * norm;
    let bestPrevScore = 0;
    let bestPrevIdx = -1;
    const start = Math.max(0, i - maxPrev);
    const end = i - minPrev;
    for (let j = start; j <= end; j++) {
      const dist = i - j;
      const logRatio = Math.log(dist / periodFrames);
      const penalty = tightness * logRatio * logRatio;
      const candidate = cumScore[j] - penalty;
      if (candidate > bestPrevScore) {
        bestPrevScore = candidate;
        bestPrevIdx = j;
      }
    }
    cumScore[i] = localOnset + bestPrevScore;
    backLink[i] = bestPrevIdx;
  }

  let bestEnd = 0;
  let bestEndScore = -Infinity;
  const tailStart = Math.max(0, n - Math.ceil(periodFrames * 2));
  for (let i = tailStart; i < n; i++) {
    if (cumScore[i] > bestEndScore) {
      bestEndScore = cumScore[i];
      bestEnd = i;
    }
  }

  const frames = [];
  for (let cur = bestEnd; cur >= 0; cur = backLink[cur]) {
    frames.push(cur);
  }
  frames.reverse();
  const beatTimes = frames.map(f => f / fps);
  const beatOffset = beatTimes.length ? Number((beatTimes[0] % (periodFrames / fps)).toFixed(4)) : null;
  return { beatTimes, beatOffset };
}

/** Tính độ khớp của thời điểm t với phách chính / nửa phách gần nhất (0..1). */
function computeBeatScore(seconds, beatTimes) {
  if (beatTimes.length < 2) return 0;
  let lo = 0;
  let hi = beatTimes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (beatTimes[mid] < seconds) lo = mid + 1;
    else hi = mid;
  }
  const distLeft = lo > 0 ? Math.abs(seconds - beatTimes[lo - 1]) : 1e9;
  const distRight = lo < beatTimes.length ? Math.abs(beatTimes[lo] - seconds) : 1e9;
  const distBeat = Math.min(distLeft, distRight);
  if (distBeat <= 0.065) {
    return Number((1 - distBeat / 0.065).toFixed(3));
  }
  if (lo > 0 && lo < beatTimes.length) {
    const midBeat = 0.5 * (beatTimes[lo - 1] + beatTimes[lo]);
    const distHalf = Math.abs(seconds - midBeat);
    if (distHalf <= 0.065) {
      return Number(((1 - distHalf / 0.065) * 0.65).toFixed(3));
    }
  }
  return 0;
}

/** Phân tích mảng PCM đơn kênh bằng FFT 2 dải tần, spectral centroid và bám phách. */
export function analyzeChannelData(samples, sampleRate) {
  if (!samples?.length || !sampleRate) {
    throw new Error('Dữ liệu âm thanh không hợp lệ.');
  }
  const duration = samples.length / sampleRate;
  if (duration < 5) {
    throw new Error('Bài nhạc quá ngắn (cần tối thiểu 5 giây).');
  }

  const { mono, sr } = resampleToTarget(samples, sampleRate);
  const frameCount = Math.floor((mono.length - FFT_SIZE) / HOP_SIZE) + 1;
  if (frameCount < 16) {
    throw new Error('Không đủ dữ liệu để tạo bản đồ nốt.');
  }

  let peak = 0;
  for (let i = 0; i < mono.length; i++) {
    const abs = mono[i] < 0 ? -mono[i] : mono[i];
    if (abs > peak) peak = abs;
  }
  if (peak < 0.0005) {
    throw new Error('Tệp âm thanh bị im lặng.');
  }

  const halfBins = FFT_SIZE / 2;
  const hzPerBin = sr / FFT_SIZE;
  const binLowStart = Math.max(1, Math.floor(45 / hzPerBin));
  const binLowEnd = Math.min(halfBins - 1, Math.ceil(2500 / hzPerBin));
  const binMidEnd = Math.min(halfBins - 1, Math.ceil(6000 / hzPerBin));
  const binCentEnd = Math.min(halfBins - 1, Math.ceil(8000 / hzPerBin));

  const flux = new Float32Array(frameCount);
  const centroid = new Float32Array(frameCount);
  const prevLog = new Float32Array(binMidEnd + 1);
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);

  for (let f = 0; f < frameCount; f++) {
    const start = f * HOP_SIZE;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = mono[start + i] * HANN_WINDOW[i];
      im[i] = 0;
    }
    fftInPlace(re, im);

    let lowFlux = 0;
    let midFlux = 0;
    let magSum = 0;
    let weightedFreqSum = 0;

    for (let k = binLowStart; k <= binCentEnd; k++) {
      const mag = Math.hypot(re[k], im[k]);
      magSum += mag;
      weightedFreqSum += k * hzPerBin * mag;

      if (k <= binMidEnd) {
        const logMag = Math.log1p(10 * mag);
        if (f > 0) {
          const diff = logMag - prevLog[k];
          if (diff > 0) {
            if (k <= binLowEnd) lowFlux += diff;
            else midFlux += diff;
          }
        }
        prevLog[k] = logMag;
      }
    }

    const lowCount = Math.max(1, binLowEnd - binLowStart + 1);
    const midCount = Math.max(1, binMidEnd - binLowEnd);
    flux[f] = f > 0 ? 0.72 * (lowFlux / lowCount) + 0.28 * (midFlux / midCount) : 0;
    centroid[f] = magSum > 1e-7 ? weightedFreqSum / magSum : 0;
  }

  const fps = sr / HOP_SIZE;
  const tempoInfo = estimateTempo(flux, fps);
  const { beatTimes, beatOffset } = trackBeats(tempoInfo, fps);

  // Ngưỡng thích nghi cục bộ theo trung bình trượt 2 chiều.
  const windowHalf = 10;
  const minGapFrames = Math.max(4, Math.round(0.06 * fps));
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
    if (flux[f] > localMean * 1.45 + 0.012 && f - lastPeakFrame >= minGapFrames) {
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
    // Lùi về chân khởi âm trước đỉnh phổ (tối đa 3 khung ≈ 35 ms) và quy đổi theo tâm khung FFT.
    let onsetFrame = peakFrame;
    const backtrackLimit = Math.max(1, peakFrame - 3);
    while (onsetFrame > backtrackLimit && flux[onsetFrame - 1] < flux[onsetFrame]) {
      onsetFrame--;
    }
    const time = (onsetFrame * HOP_SIZE + FFT_SIZE / 2) / sr;
    if (time < 0.05 || time > duration - 0.15) continue;
    events.push({
      time: Number(time.toFixed(5)),
      strength: Number(Math.min(1, flux[peakFrame] / Math.max(scale, 0.00001)).toFixed(4)),
      brightness: Number(centroid[peakFrame].toFixed(2)),
      beatScore: computeBeatScore(time, beatTimes),
    });
  }

  return {
    duration: Number(duration.toFixed(5)),
    bpm: tempoInfo?.bpm || null,
    beatOffset,
    events,
  };
}

/** Trộn các kênh của AudioBuffer sang mono. */
function mixAudioBufferToMono(audioBuffer) {
  const { numberOfChannels, length } = audioBuffer;
  const mono = new Float32Array(length);
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const channel = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      mono[i] += channel[i] / numberOfChannels;
    }
  }
  return mono;
}

/** Trộn các kênh của AudioBuffer sang mono và phân tích đồng bộ trên luồng hiện tại. */
export function analyzeAudioBuffer(audioBuffer) {
  return analyzeChannelData(mixAudioBufferToMono(audioBuffer), audioBuffer.sampleRate);
}

/** Chạy phân tích trong Web Worker để tránh đơ giao diện; tự fallback nếu Worker không khả dụng. */
export function analyzeAudioBufferAsync(audioBuffer) {
  const mono = mixAudioBufferToMono(audioBuffer);
  const sampleRate = audioBuffer.sampleRate;
  if (typeof Worker === 'undefined') {
    return Promise.resolve(analyzeChannelData(mono, sampleRate));
  }
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./local-analyzer-worker.js', import.meta.url), { type: 'module' });
    } catch {
      try {
        resolve(analyzeChannelData(mono, sampleRate));
      } catch (error) {
        reject(error);
      }
      return;
    }
    worker.onmessage = event => {
      worker.terminate();
      if (event.data?.ok) resolve(event.data.result);
      else reject(new Error(event.data?.error || 'Không thể phân tích tệp nhạc.'));
    };
    worker.onerror = () => {
      worker.terminate();
      try {
        resolve(analyzeChannelData(mono, sampleRate));
      } catch (error) {
        reject(error);
      }
    };
    worker.postMessage({ mono, sampleRate }, [mono.buffer]);
  });
}
