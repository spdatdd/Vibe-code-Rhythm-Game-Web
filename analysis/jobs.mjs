import { spawn } from 'node:child_process';
import { access, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
export const cacheRoot = path.join(root, '.cache', 'analysis');
const jobs = new Map();
let running = null;

// Tìm Python có sẵn, không dùng alias Windows Store nếu có runtime Codex.
async function pythonPath() {
  const candidates = [process.env.ORBIT_PYTHON, path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe')].filter(Boolean);
  for (const candidate of candidates) { try { await access(candidate); return candidate; } catch {} }
  return process.platform === 'win32' ? 'python' : 'python3';
}
// Chỉ dùng cache khi cả chart và âm thanh đều đã được ghi hoàn tất.
export async function cachedResult(id) {
  try {
    await access(path.join(cacheRoot, id, 'audio.wav'));
    const result = JSON.parse(await readFile(path.join(cacheRoot, id, 'result.json'), 'utf8'));
    return result.version === 1 && result.videoId === id && Array.isArray(result.events) ? result : null;
  } catch { return null; }
}
// Chuyển lỗi công cụ thành thông báo ngắn, không trả log hoặc đường dẫn nội bộ.
function friendlyError(message = '') {
  if (/sign in|bot|login|cookies/i.test(message)) return 'YouTube yêu cầu xác minh hoặc đăng nhập. Hãy thử video công khai khác; tool không tự lấy cookie trình duyệt.';
  if (/private|unavailable|not available|removed|restricted/i.test(message)) return 'Video không truy cập được hoặc có giới hạn. Hãy thử video công khai khác.';
  if (/No module named|ModuleNotFoundError/i.test(message)) return 'Thiếu thư viện. Chạy Setup-Analysis.ps1 trong thư mục dự án rồi thử lại.';
  if (/10013|network|connect|timed out|resolve|SSL/i.test(message)) return 'Không kết nối được YouTube. Kiểm tra mạng rồi bấm Phân tích lại.';
  return message && !/Traceback|File "/.test(message) ? message.slice(0, 500) : 'Phân tích thất bại. Hãy thử lại hoặc chọn bài khác.';
}
// Đọc trạng thái tác vụ hoặc khôi phục trạng thái sẵn sàng từ cache trên đĩa.
export async function getJob(id) {
  if (jobs.has(id)) return jobs.get(id);
  return await cachedResult(id) ? { id, stage: 'ready', progress: 100, message: 'Đã có bản phân tích trên máy.' } : null;
}
// Chỉ chạy một tiến trình phân tích tại một thời điểm để tránh quá tải máy.
export async function startJob(id) {
  if (await cachedResult(id)) { const job = { id, stage: 'ready', progress: 100, message: 'Đã có bản phân tích trên máy.' }; jobs.set(id, job); return job; }
  if (running) {
    if (running.id === id) return jobs.get(id);
    const error = new Error('Đang phân tích bài khác. Hãy chờ hoặc hủy tác vụ hiện tại.'); error.status = 409; throw error;
  }
  const job = { id, stage: 'queued', progress: 1, message: 'Đang khởi động công cụ phân tích…' };
  running = { id, child: null }; jobs.set(id, job);
  try {
    await mkdir(path.join(cacheRoot, id), { recursive: true });
    const python = await pythonPath();
    if (job.stage === 'cancelled') { running = null; return job; }
    const child = spawn(python, [path.join(root, 'analysis', 'prepare.py'), '--id', id, '--output', path.join(cacheRoot, id), '--node', process.execPath], {
      cwd: root, windowsHide: true, detached: process.platform !== 'win32',
      env: { ...process.env, ORBIT_BACKEND_SECRET: '', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1',
        PYTHONPATH: path.join(root, '.tools', 'python'), NUMBA_CACHE_DIR: path.join(root, '.cache', 'numba') }, stdio: ['ignore', 'pipe', 'pipe']
    });
    running.child = child;
    let buffer = '', stderr = '', completed = false;
    // Giới hạn thời gian tác vụ treo, bao gồm tải mạng và biên dịch thư viện lần đầu.
    const timer = setTimeout(() => { job.message = 'Chuẩn bị quá lâu. Kiểm tra mạng rồi thử lại.'; cancelJob(id, 'error'); }, 12 * 60 * 1000);
    // Chuyển JSON từng dòng thành tiến độ cho trình duyệt và giới hạn bộ đệm.
    child.stdout.on('data', data => {
      buffer += data.toString(); const lines = buffer.split('\n'); buffer = lines.pop().slice(-10000);
      for (const line of lines) {
        try {
          const item = JSON.parse(line);
          if (!['cancelled', 'error'].includes(job.stage) && ['downloading', 'decoding', 'analyzing', 'ready', 'error'].includes(item.stage)) {
            Object.assign(job, { stage: item.stage, progress: Math.max(0, Math.min(100, item.progress)), message: item.stage === 'error' ? friendlyError(item.message) : item.message });
          }
        } catch {}
      }
    });
    // Giữ phần cuối lỗi để chẩn đoán mà không tăng bộ nhớ vô hạn.
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-6000); });
    // Dọn tác vụ một lần dù cả sự kiện error và close cùng xảy ra.
    const complete = (code, error) => {
      if (completed) return;
      completed = true; clearTimeout(timer); if (running?.child === child) running = null;
      if (['cancelled', 'error'].includes(job.stage)) return;
      if (code !== 0 || job.stage !== 'ready') Object.assign(job, { stage: 'error', progress: 0, message: friendlyError(error?.message || stderr) });
    };
    child.on('error', error => complete(-1, error)); child.on('close', code => complete(code));
  } catch (error) { running = null; job.stage = 'error'; job.message = friendlyError(error.message); }
  return job;
}
// Hủy đúng cây tiến trình do server tạo, bao gồm ffmpeg nếu đang chuyển đổi âm thanh.
export function cancelJob(id, stage = 'cancelled') {
  const job = jobs.get(id);
  if (!running || running.id !== id || !job) return false;
  job.stage = stage; if (stage === 'cancelled') job.message = 'Đã hủy chuẩn bị bài nhạc.';
  const child = running.child;
  if (child?.pid) {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      // Dừng trực tiếp nếu hệ thống không cung cấp lệnh taskkill.
      killer.on('error', () => child.kill());
    } else {
      // Python và FFmpeg nằm chung nhóm tiến trình trên Linux.
      try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') child.kill('SIGTERM'); }
    }
  }
  return true;
}
