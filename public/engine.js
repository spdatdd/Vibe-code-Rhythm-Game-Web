// Bốn phím tương ứng với các cột đàn từ trái sang phải.
export const LANE_KEYS = ['KeyD', 'KeyF', 'KeyJ', 'KeyK'];

// Danh sách các bài Demo tích hợp sẵn với BPM và giai điệu riêng.
export const DEMO_TRACKS = [
  {
    id: 'neon-drift',
    title: 'Neon Drift',
    bpm: 120,
    offset: 2,
    duration: 48,
    melody: [261.63, 329.63, 392.0, 493.88, 440.0, 392.0, 329.63, 293.66],
    bass: [65.41, 82.41],
  },
  {
    id: 'midnight-pulse',
    title: 'Midnight Pulse',
    bpm: 96,
    offset: 2,
    duration: 40,
    melody: [220.0, 261.63, 329.63, 392.0, 349.23, 329.63, 293.66, 246.94],
    bass: [55.0, 65.41],
  },
  {
    id: 'hyper-orbit',
    title: 'Hyper Orbit',
    bpm: 148,
    offset: 2,
    duration: 45,
    melody: [293.66, 349.23, 440.0, 523.25, 587.33, 523.25, 440.0, 392.0],
    bass: [73.42, 87.31],
  },
];

// Quy đổi độ chính xác và trạng thái hoàn thành sang Rank và số sao (0–3).
export function calculateRank(accuracy, failed = false) {
  if (failed) return { rank: 'F', stars: 0 };
  if (accuracy >= 95) return { rank: 'S', stars: 3 };
  if (accuracy >= 85) return { rank: 'A', stars: 2 };
  if (accuracy >= 70) return { rank: 'B', stars: 1 };
  return { rank: 'C', stars: 0 };
}

// Tạo chart từ onset thật, chọn nốt nổi bật theo độ khó mà không dời timestamp.
export function buildAnalyzedChart(events, difficulty, duration, { allowChords = false } = {}) {
  const gap = { easy: .42, normal: .25, hard: .14 }[difficulty] || .25;
  const threshold = { easy: .30, normal: .12, hard: .035 }[difficulty] || .12;
  const candidates = events.filter(event => Number.isFinite(event.time) && event.time >= 0 && event.time < duration - .1 && event.strength >= threshold);
  const selected = [];
  // Ưu tiên điểm khởi âm mạnh trong những cụm nốt quá sát nhau.
  for (const event of [...candidates].sort((a, b) => b.strength - a.strength || a.time - b.time)) {
    if (!selected.some(other => Math.abs(other.time - event.time) < gap)) selected.push(event);
  }
  selected.sort((a, b) => a.time - b.time);
  const brightness = selected.map(event => event.brightness).sort((a, b) => a - b);
  const boundaries = [.25, .5, .75].map(q => brightness[Math.floor((brightness.length - 1) * q)] || 0);
  // Phân cột theo độ sáng phổ, đổi cột khi lặp nhanh và tạo nốt giữ khi đủ khoảng trống.
  let lastLane = -1, lastTime = -Infinity, notesSinceChord = 0;
  const notes = [];
  for (let index = 0; index < selected.length; index++) {
    const event = selected[index];
    let lane = boundaries.filter(value => event.brightness > value).length;
    if (lane === lastLane && event.time - lastTime < .32) {
      lane = lane === 0 ? 1 : lane === 3 ? 2 : index % 2 ? lane + 1 : lane - 1;
    }
    lastLane = lane;
    lastTime = event.time;
    const nextTime = index + 1 < selected.length ? selected[index + 1].time : duration - .15;
    const maxHold = Math.min(1.6, nextTime - event.time - .2, duration - .2 - event.time);
    const hold = maxHold >= .32 ? Number(maxHold.toFixed(3)) : 0;
    notes.push({ time: event.time, lane, hold, state: 'pending' });
    if (allowChords && difficulty === 'hard' && hold === 0 && event.strength >= .78 && notesSinceChord >= 3) {
      notes.push({ time: event.time, lane: (lane + 2) % 4, hold: 0, state: 'pending' });
      notesSinceChord = 0;
    } else {
      notesSinceChord++;
    }
  }
  return notes;
}
// Đọc ID video hợp lệ từ URL YouTube thông dụng hoặc ID thuần.
export function videoId(input) {
  if (/^[\w-]{11}$/.test(input.trim())) return input.trim();
  try {
    const url = new URL(input.trim());
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    const host = url.hostname.replace(/^www\./, '');
    const id = host === 'youtu.be' ? url.pathname.slice(1) : ['youtube.com', 'm.youtube.com', 'youtube-nocookie.com'].includes(host) ? (url.searchParams.get('v') || url.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/)?.[1]) : null;
    return /^[\w-]{11}$/.test(id || '') ? id : null;
  } catch { return null; }
}
// Sinh bản đồ nốt xác định theo BPM; chừa khoảng trống sau nốt giữ.
export function makeChart({ bpm, offset, duration, difficulty }) {
  const beat = 60 / bpm;
  const step = beat * (difficulty === 'easy' ? 2 : difficulty === 'hard' ? .5 : 1);
  const notes = [];
  // Bỏ qua các phách quá sớm nhưng giữ nguyên pha của mốc nhịp người dùng chọn.
  const first = Math.max(0, Math.ceil((2 - offset) / step - 1e-9));
  for (let grid = first, i = 0; offset + grid * step < duration - 1; i++) {
    const t = offset + grid * step;
    const hold = i % 8 === 6 ? beat * 1.5 : 0;
    notes.push({ time: t, lane: (i * 3 + Math.floor(i / 4)) % 4, hold: Math.min(hold, duration - t - .5), state: 'pending' });
    // Tiến theo số bước nguyên để nốt giữ không đẩy nốt sau lệch nửa phách.
    grid += hold ? Math.ceil(hold / step) + 1 : 1;
  }
  return notes;
}
// Ước lượng chu kỳ và mốc phách từ thời gian video của các lần gõ liên tiếp.
export function calibrateBeats(times) {
  if (times.length < 4) return null;
  const n = times.length, meanX = (n - 1) / 2;
  const meanY = times.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0, denominator = 0;
  for (let i = 0; i < n; i++) { numerator += (i - meanX) * (times[i] - meanY); denominator += (i - meanX) ** 2; }
  const beat = numerator / denominator, bpm = 60 / beat;
  if (bpm < 40 || bpm > 240) return null;
  const origin = meanY - beat * meanX;
  const error = Math.sqrt(times.reduce((sum, value, i) => sum + (value - origin - i * beat) ** 2, 0) / n);
  if (error > .09) return null;
  return { bpm: Number(bpm.toFixed(3)), offset: Number(((origin % beat + beat) % beat).toFixed(4)) };
}
// Phân loại độ lệch thời gian theo cửa sổ chấm điểm tính bằng giây.
export function judge(delta) { const d = Math.abs(delta); return d <= .065 ? 'PERFECT' : d <= .13 ? 'GREAT' : d <= .19 ? 'GOOD' : null; }
// Tìm nốt pending sớm nhất trong đúng cột và nằm trong cửa sổ chấm điểm.
export function findNote(notes, lane, time) {
  let earliest;
  for (const note of notes) {
    if (note.state === 'pending' && note.lane === lane && judge(time - note.time)) {
      if (!earliest || note.time < earliest.time) earliest = note;
    }
  }
  return earliest;
}
// Cập nhật điểm, combo và tổng trọng số chính xác sau một nốt đã kết thúc.
export function award(stats, rating) {
  const weight = { PERFECT: 1, GREAT: .8, GOOD: .5, MISS: 0 }[rating];
  stats.judged++; stats.weight += weight;
  stats.combo = weight ? stats.combo + 1 : 0;
  stats.maxCombo = Math.max(stats.maxCombo, stats.combo);
  stats.score += Math.round(weight * 1000 * (1 + Math.min(Math.floor(stats.combo / 10), 4) * .25));
}
