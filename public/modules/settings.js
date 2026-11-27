const STORAGE_KEY = 'orbit-settings-v1';
const RECORDS_KEY = 'orbit-records-v1';
const DIFFICULTIES = ['normal', 'hard'];
const RENDER_MODES = ['2d', '3d'];

/** Chuẩn hóa độ khó về một trong hai mức hợp lệ. */
export function normalizeDifficulty(value) {
  return DIFFICULTIES.includes(value) ? value : 'normal';
}

/** Chuẩn hóa chế độ hiển thị, mặc định là 2D. */
export function normalizeRenderMode(value) {
  return RENDER_MODES.includes(value) ? value : '2d';
}

/** Giới hạn tốc độ rơi của nốt trong khoảng [0.5, 2.0] theo bước 0.1. */
export function clampScrollSpeed(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 1.0;
  return Math.max(0.5, Math.min(2.0, Math.round(num * 10) / 10));
}

/** Giới hạn bù trễ âm thanh trong khoảng [-200, 200] ms theo bước 1 ms. */
export function clampOffsetMs(value) {
  return Math.max(-200, Math.min(200, Math.round(Number(value) || 0)));
}

/** Đọc cấu hình đã lưu trong trình duyệt một cách an toàn. */
export function loadSettings(storage = globalThis.localStorage) {
  const defaults = {
    url: '',
    difficulty: 'normal',
    audioOffsetMs: 0,
    renderMode: '2d',
    scrollSpeed: 1.0,
    demoId: 'neon-drift',
  };
  try {
    const saved = JSON.parse(storage?.getItem(STORAGE_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return defaults;
    return {
      url: typeof saved.url === 'string' ? saved.url : '',
      difficulty: normalizeDifficulty(saved.difficulty),
      audioOffsetMs: Number.isFinite(saved.audioOffsetMs) ? clampOffsetMs(saved.audioOffsetMs) : 0,
      renderMode: normalizeRenderMode(saved.renderMode),
      scrollSpeed: Number.isFinite(saved.scrollSpeed) ? clampScrollSpeed(saved.scrollSpeed) : 1.0,
      demoId: typeof saved.demoId === 'string' && saved.demoId ? saved.demoId : 'neon-drift',
    };
  } catch {
    return defaults;
  }
}

/** Lưu cấu hình người dùng vào trình duyệt, bỏ qua nếu bị chặn quyền lưu trữ. */
export function saveSettings(settings, storage = globalThis.localStorage) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify({
      url: typeof settings.url === 'string' ? settings.url.trim() : '',
      difficulty: normalizeDifficulty(settings.difficulty),
      audioOffsetMs: clampOffsetMs(settings.audioOffsetMs),
      renderMode: normalizeRenderMode(settings.renderMode),
      scrollSpeed: clampScrollSpeed(settings.scrollSpeed ?? 1.0),
      demoId: typeof settings.demoId === 'string' && settings.demoId ? settings.demoId : 'neon-drift',
    }));
    return true;
  } catch {
    return false;
  }
}

/** Đọc bảng kỷ lục điểm cao và rank đã lưu theo từng bài/độ khó. */
export function loadRecords(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(RECORDS_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Lưu kỷ lục mới nếu đạt điểm cao hơn; trả về { records, isNewRecord }. */
export function saveRecord(key, entry, storage = globalThis.localStorage) {
  const records = loadRecords(storage);
  const prev = records[key];
  const isNewRecord = !prev || entry.score > prev.score;
  const next = isNewRecord
    ? {
        score: entry.score,
        accuracy: entry.accuracy,
        maxCombo: entry.maxCombo,
        rank: entry.rank,
        stars: entry.stars,
      }
    : {
        ...prev,
        accuracy: Math.max(prev.accuracy || 0, entry.accuracy),
        maxCombo: Math.max(prev.maxCombo || 0, entry.maxCombo),
      };
  records[key] = next;
  try {
    storage?.setItem(RECORDS_KEY, JSON.stringify(records));
  } catch {}
  return { records, record: next, isNewRecord };
}
