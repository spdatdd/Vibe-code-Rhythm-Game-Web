// Bốn phím tương ứng với các cột đàn từ trái sang phải.
export const LANE_KEYS = ['KeyD', 'KeyF', 'KeyJ', 'KeyK'];
// Tạo chart từ onset thật, chọn nốt nổi bật theo độ khó mà không dời timestamp.
export function buildAnalyzedChart(events, difficulty, duration) {
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
  // Cột được phân theo độ sáng phổ để tạo biến thiên; không nhận là bản chép nốt piano.
  return selected.map(event => ({ time: event.time, lane: boundaries.filter(value => event.brightness > value).length, hold: 0, state: 'pending' }));
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
// Tìm nốt gần nhất trong đúng cột và trong cửa sổ chấm điểm.
export function findNote(notes, lane, time) {
  return notes.filter(note => note.state === 'pending' && note.lane === lane && judge(time - note.time))
    .sort((a, b) => Math.abs(a.time - time) - Math.abs(b.time - time))[0];
}
// Cập nhật điểm, combo và tổng trọng số chính xác sau một nốt đã kết thúc.
export function award(stats, rating) {
  const weight = { PERFECT: 1, GREAT: .8, GOOD: .5, MISS: 0 }[rating];
  stats.judged++; stats.weight += weight;
  stats.combo = weight ? stats.combo + 1 : 0;
  stats.maxCombo = Math.max(stats.maxCombo, stats.combo);
  stats.score += Math.round(weight * 1000 * (1 + Math.min(Math.floor(stats.combo / 10), 4) * .25));
}
