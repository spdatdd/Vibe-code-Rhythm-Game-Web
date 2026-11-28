const STORAGE_KEY = 'orbit-settings-v1';
const RECORDS_KEY = 'orbit-records-v1';
const DIFFICULTIES = ['normal', 'hard'];

/** Chuẩn hóa độ khó về một trong hai mức hợp lệ. */
export function normalizeDifficulty(value) {
  return DIFFICULTIES.includes(value) ? value : 'normal';
}

/** Mặc định chế độ 2D; tự chuyển sang 3D khi ở màn hình ngang. */
export function renderModeForViewport(width, height) {
  return Number(width) > Number(height) ? '3d' : '2d';
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
    difficulty: 'normal',
    audioOffsetMs: 0,
    scrollSpeed: 1.0,
  };
  try {
    const saved = JSON.parse(storage?.getItem(STORAGE_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return defaults;
    return {
      difficulty: normalizeDifficulty(saved.difficulty),
      audioOffsetMs: Number.isFinite(saved.audioOffsetMs) ? clampOffsetMs(saved.audioOffsetMs) : 0,
      scrollSpeed: Number.isFinite(saved.scrollSpeed) ? clampScrollSpeed(saved.scrollSpeed) : 1.0,
    };
  } catch {
    return defaults;
  }
}

/** Lưu cấu hình người dùng vào trình duyệt, bỏ qua nếu bị chặn quyền lưu trữ. */
export function saveSettings(settings, storage = globalThis.localStorage) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify({
      difficulty: normalizeDifficulty(settings.difficulty),
      audioOffsetMs: clampOffsetMs(settings.audioOffsetMs),
      scrollSpeed: clampScrollSpeed(settings.scrollSpeed ?? 1.0),
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
