import { access, readdir, readFile, rm, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
export const cacheRoot = path.join(root, '.cache', 'analysis');
export const maxCachedTracks = Math.max(3, Number(process.env.ORBIT_CACHE_LIMIT) || 15);

/** Xác định tệp âm thanh và kiểu MIME theo phiên bản cache của bài nhạc. */
export function audioAsset(result) {
  if (result?.version === 1) return { file: 'audio.wav', type: 'audio/wav' };
  if (result?.version === 2) return { file: 'audio-v2.wav', type: 'audio/wav' };
  return { file: 'audio-v3.mp3', type: 'audio/mpeg' };
}

/** Giữ số lượng bản phân tích trên đĩa trong giới hạn LRU để không đầy bộ nhớ. */
export async function pruneCache(limit = maxCachedTracks, directory = cacheRoot, keepIds = new Set(), onEvict) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const items = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[\w-]{11}$/.test(entry.name) || keepIds.has(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      try {
        const info = await stat(path.join(fullPath, 'result.json')).catch(() => stat(fullPath));
        items.push({ name: entry.name, fullPath, mtimeMs: info.mtimeMs });
      } catch {}
    }
    items.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const stale of items.slice(limit)) {
      onEvict?.(stale.name);
      await rm(stale.fullPath, { recursive: true, force: true });
    }
  } catch {}
}

/** Chỉ dùng cache khi cả chart và âm thanh đều đã được ghi hoàn tất. */
export async function cachedResult(id) {
  try {
    const resultPath = path.join(cacheRoot, id, 'result.json');
    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    if (![1, 2, 3].includes(result.version) || result.videoId !== id || !Array.isArray(result.events)) return null;
    await access(path.join(cacheRoot, id, audioAsset(result).file));
    if (result.hasVideo) await access(path.join(cacheRoot, id, 'background.mp4'));
    const now = new Date();
    void utimes(resultPath, now, now).catch(() => {});
    return result;
  } catch {
    return null;
  }
}
