import { analyzeChannelData } from './local-analyzer.js';

/** Nhận mảng PCM mono từ main thread và trả về kết quả phân tích DSP. */
self.onmessage = event => {
  const { mono, sampleRate } = event.data;
  try {
    const result = analyzeChannelData(mono, sampleRate);
    self.postMessage({ ok: true, result });
  } catch (error) {
    self.postMessage({ ok: false, error: error?.message || 'Lỗi phân tích tệp nhạc.' });
  }
};
