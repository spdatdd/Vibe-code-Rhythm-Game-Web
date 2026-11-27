import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { videoId, makeChart, judge, award, findNote, LANE_KEYS, DEMO_TRACKS, calculateRank, calibrateBeats, buildAnalyzedChart } from '../public/engine.js';
import { createView, project, laneAt, LANE_WIDTH, RUNWAY_HALF_WIDTH, PAD_HEIGHT, PAD_FRONT_Z, PAD_BACK_Z } from '../public/stage3d.js';
import { audioAsset, pruneCache } from '../analysis/cache.mjs';
import {
  clampOffsetMs,
  clampScrollSpeed,
  normalizeDifficulty,
  normalizeRenderMode,
  normalizePlayMode,
  loadSettings,
  saveSettings,
  loadRecords,
  saveRecord,
} from '../public/modules/settings.js';
import { analyzeChannelData } from '../public/modules/local-analyzer.js';
import { getLayout2D, laneAt2D } from '../public/modules/renderer2d.js';
// Kiểm tra URL hợp lệ và chặn tên miền giả mạo hoặc dữ liệu độc hại.
test('Đọc ID YouTube và từ chối tên miền giả', () => {
  assert.equal(videoId('https://youtu.be/abcdefghijk?t=3'), 'abcdefghijk');
  assert.equal(videoId('https://www.youtube.com/watch?v=abcdefghijk'), 'abcdefghijk');
  assert.equal(videoId('https://youtube.com/shorts/abcdefghijk'), 'abcdefghijk');
  assert.equal(videoId('https://youtube.com.evil.test/watch?v=abcdefghijk'), null);
  assert.equal(videoId('javascript:alert(1)'), null);
});
// Kiểm tra nốt giữ không đè lên nốt tiếp theo và bản đồ nằm trong thời lượng.
test('Bản đồ có nhịp xác định, nốt giữ và không chồng nốt', () => {
  for (const difficulty of ['easy', 'normal', 'hard']) {
    const notes = makeChart({ bpm: 120, offset: 2, duration: 48, difficulty });
    assert.ok(notes.some(n => n.hold > 0));
    assert.equal(notes[0].time, 2);
    for (let i = 1; i < notes.length; i++) assert.ok(notes[i].time > notes[i - 1].time + notes[i - 1].hold);
    assert.ok(notes.every(n => n.time < 47));
    assert.ok(notes.every(n => Number.isInteger(n.lane) && n.lane >= 0 && n.lane < 4));
  }
  assert.equal(makeChart({ bpm: 120, offset: 70, duration: 48, difficulty: 'normal' }).length, 0);
});
// Nốt chỉ nhận đúng cột, trong thời gian cho phép và chưa được đánh trước đó.
test('Piano nhận đúng cột và không chấm lại nốt đã đánh', () => {
  assert.deepEqual(LANE_KEYS, ['KeyD', 'KeyF', 'KeyJ', 'KeyK']);
  const notes = [{ lane: 0, time: 2, state: 'pending' }, { lane: 1, time: 2, state: 'hit' }];
  assert.equal(findNote(notes, 0, 2.1), notes[0]);
  assert.equal(findNote(notes, 1, 2), undefined);
  assert.equal(findNote(notes, 2, 2), undefined);
  assert.equal(findNote(notes, 0, 2.3), undefined);
});
// Xác nhận giới hạn chấm điểm và tính đối xứng giữa bấm sớm và bấm muộn.
test('Cửa sổ phán xét phân loại thời gian chính xác', () => {
  assert.equal(judge(.065), 'PERFECT'); assert.equal(judge(-.13), 'GREAT');
  assert.equal(judge(.19), 'GOOD'); assert.equal(judge(.191), null);
});
// Xác nhận miss làm đứt combo và vẫn được tính vào mẫu số chính xác.
test('Điểm, combo và chính xác có tính cả miss', () => {
  const stats = { score: 0, combo: 0, maxCombo: 0, judged: 0, weight: 0 };
  award(stats, 'PERFECT'); award(stats, 'GREAT'); award(stats, 'MISS');
  assert.equal(stats.score, 1800); assert.equal(stats.combo, 0); assert.equal(stats.maxCombo, 2);
  assert.equal(stats.judged, 3); assert.equal(stats.weight, 1.8);
});
// Mọi nốt vẫn nằm trên lưới phách sau nhiều nốt giữ và giữ pha mốc dưới hai giây.
test('Không trôi nửa phách sau nốt giữ hoặc khi bỏ qua intro', () => {
  for (const difficulty of ['easy', 'normal', 'hard']) {
    const bpm = 127.35, offset = .237;
    const step = 60 / bpm * (difficulty === 'easy' ? 2 : difficulty === 'hard' ? .5 : 1);
    const notes = makeChart({ bpm, offset, duration: 600, difficulty });
    assert.ok(notes[0].time >= 2);
    for (const note of notes) {
      const grid = (note.time - offset) / step;
      assert.ok(Math.abs(grid - Math.round(grid)) < 1e-8);
    }
  }
});
// Đo đồng thời BPM và pha từ một đoạn nhạc bất kỳ, có sai số thao tác nhỏ.
test('Căn BPM và mốc phách từ các lần gõ theo thời gian video', () => {
  const times = Array.from({ length: 16 }, (_, i) => 12.237 + i * .5 + (i % 2 ? .008 : -.008));
  const result = calibrateBeats(times);
  assert.ok(Math.abs(result.bpm - 120) < .1);
  assert.ok(Math.abs(result.offset - .237) < .02);
  assert.equal(calibrateBeats([1, 1.5, 2]), null);
  assert.equal(calibrateBeats([1, 1.5, 2.8, 2.9, 4.4]), null);
});
// Chart tự động giữ nguyên các thời điểm thật kể cả bài tăng hoặc giảm tốc độ.
test('Chart phân tích giữ timestamp, lọc nốt sát nhau và không tạo nhịp giả', () => {
  const events = [0.3, .8, 1.31, 1.72, 2.05, 2.35, 2.62, 2.86, 3.03, 3.3].map((time, i) => ({ time, strength: .9, brightness: 200 + i * 150 }));
  const easy = buildAnalyzedChart(events, 'easy', 4), hard = buildAnalyzedChart(events, 'hard', 4);
  assert.ok(hard.length > easy.length);
  assert.equal(hard[0].time, .3);
  assert.ok(hard.every(note => events.some(event => event.time === note.time)));
  assert.ok(hard.every(note => note.hold >= 0 && note.lane >= 0 && note.lane < 4));
  const withGaps = buildAnalyzedChart([
    { time: 0.4, strength: .9, brightness: 300 },
    { time: 1.5, strength: .9, brightness: 600 },
    { time: 2.8, strength: .9, brightness: 900 },
  ], 'normal', 4.5);
  assert.ok(withGaps.some(note => note.hold > 0));
  for (let i = 1; i < withGaps.length; i++) {
    assert.ok(withGaps[i].time > withGaps[i - 1].time + withGaps[i - 1].hold);
  }
  const close = buildAnalyzedChart([{ time: 1, strength: .2, brightness: 300 }, { time: 1.05, strength: 1, brightness: 500 }], 'normal', 5);
  assert.equal(close.length, 1); assert.equal(close[0].time, 1.05);
  assert.deepEqual(buildAnalyzedChart([], 'normal', 5), []);
});
// Khi hai nốt cùng cột nằm sát nhau trong cửa sổ phán xét, luôn chấm nốt sớm hơn trước.
test('Không chấm vượt mặt nốt trước khi gõ trễ trong đoạn nốt dày', () => {
  const notes = [
    { lane: 0, time: 1.00, state: 'pending' },
    { lane: 0, time: 1.15, state: 'pending' },
  ];
  assert.equal(findNote(notes, 0, 1.09), notes[0]);
  notes[0].state = 'hit';
  assert.equal(findNote(notes, 0, 1.09), notes[1]);
});
// Chuỗi âm thanh lặp nhanh cùng màu âm được tách sang cột kề để tránh gõ dồn một ngón.
test('Chống lặp một cột liên tiếp khi các onset sát nhau có cùng độ sáng phổ', () => {
  const repeated = Array.from({ length: 6 }, (_, i) => ({ time: 1 + i * .18, strength: .9, brightness: 420 }));
  const chart = buildAnalyzedChart(repeated, 'hard', 5);
  assert.equal(chart.length, 6);
  for (let i = 1; i < chart.length; i++) {
    assert.notEqual(chart[i].lane, chart[i - 1].lane);
  }
});
// Phép chiếu ngược Three.js trên Canvas nhận đúng cả bốn cột phím và từ chối vùng ngoài đường băng.
test('Giải ngược tọa độ 3D xác định đúng cột chạm trên sân chơi', () => {
  const view = createView(800, 490);
  const padCenterZ = (PAD_FRONT_Z + PAD_BACK_Z) / 2;
  for (let lane = 0; lane < 4; lane++) {
    const centerX = -RUNWAY_HALF_WIDTH + (lane + .5) * LANE_WIDTH;
    const padPoint = project(view, centerX, PAD_HEIGHT, padCenterZ);
    const runwayPoint = project(view, centerX, 0, -6);
    assert.equal(laneAt(view, padPoint.x, padPoint.y), lane);
    assert.equal(laneAt(view, runwayPoint.x, runwayPoint.y), lane);
  }
  assert.equal(laneAt(view, 5, 5), -1);
});
// Quản lý cache nhận đúng định dạng âm thanh v1/v2/v3 và xóa các bài cũ nhất theo LRU.
test('Phân giải tệp âm thanh theo phiên bản và dọn cache LRU an toàn', async () => {
  assert.deepEqual(audioAsset({ version: 1 }), { file: 'audio.wav', type: 'audio/wav' });
  assert.deepEqual(audioAsset({ version: 2 }), { file: 'audio-v2.wav', type: 'audio/wav' });
  assert.deepEqual(audioAsset({ version: 3 }), { file: 'audio-v3.mp3', type: 'audio/mpeg' });
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'orbit-cache-test-'));
  try {
    const ids = ['track000001', 'track000002', 'track000003', 'track000004'];
    for (const [index, id] of ids.entries()) {
      const dir = path.join(tempRoot, id);
      await mkdir(dir);
      const resultFile = path.join(dir, 'result.json');
      await writeFile(resultFile, '{}');
      const stamp = new Date(Date.now() - (ids.length - index) * 10000);
      await utimes(resultFile, stamp, stamp);
    }
    await pruneCache(2, tempRoot, new Set(['track000001']));
    const remaining = (await readdir(tempRoot)).sort();
    assert.deepEqual(remaining, ['track000001', 'track000003', 'track000004']);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
// Module settings chuẩn hóa độ khó, luật chơi, tốc độ rơi, giới hạn offset và chịu lỗi khi thiếu localStorage.
test('Lưu và đọc cấu hình độ khó, bù trễ âm thanh an toàn', () => {
  assert.equal(normalizeDifficulty('hard'), 'hard');
  assert.equal(normalizeDifficulty('unknown'), 'normal');
  assert.equal(normalizeRenderMode('3d'), '3d');
  assert.equal(normalizeRenderMode('invalid'), '2d');
  assert.equal(normalizePlayMode('sudden-death'), 'sudden-death');
  assert.equal(normalizePlayMode('invalid'), 'standard');
  assert.equal(clampScrollSpeed(3.5), 2.0);
  assert.equal(clampScrollSpeed(0.1), 0.5);
  assert.equal(clampScrollSpeed(1.24), 1.2);
  assert.equal(clampOffsetMs(350), 200);
  assert.equal(clampOffsetMs(-350), -200);
  assert.equal(clampOffsetMs(42.6), 43);
  const store = new Map();
  const mockStorage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
  assert.equal(
    saveSettings({ url: ' https://youtu.be/abcdefghijk ', difficulty: 'easy', audioOffsetMs: 35, renderMode: '3d', playMode: 'sudden-death', scrollSpeed: 1.4, hitsound: false, demoId: 'hyper-orbit' }, mockStorage),
    true,
  );
  assert.deepEqual(loadSettings(mockStorage), {
    url: 'https://youtu.be/abcdefghijk',
    difficulty: 'easy',
    audioOffsetMs: 35,
    renderMode: '3d',
    playMode: 'sudden-death',
    scrollSpeed: 1.4,
    hitsound: false,
    demoId: 'hyper-orbit',
  });
  assert.deepEqual(loadSettings({ getItem: () => '{broken' }), {
    url: '',
    difficulty: 'normal',
    audioOffsetMs: 0,
    renderMode: '2d',
    playMode: 'standard',
    scrollSpeed: 1.0,
    hitsound: true,
    demoId: 'neon-drift',
  });
});

// Kiểm tra danh sách bài demo, tính Rank/sao, lưu kỷ lục và nốt đôi ở mức Khó.
test('Demo tracks, tính Rank/sao, lưu kỷ lục và hợp âm mức Khó', () => {
  assert.ok(DEMO_TRACKS.length >= 3);
  for (const track of DEMO_TRACKS) {
    assert.ok(track.bpm >= 60 && track.duration >= 30 && track.melody.length >= 4);
  }
  assert.deepEqual(calculateRank(96, false), { rank: 'S', stars: 3 });
  assert.deepEqual(calculateRank(88, false), { rank: 'A', stars: 2 });
  assert.deepEqual(calculateRank(75, false), { rank: 'B', stars: 1 });
  assert.deepEqual(calculateRank(60, false), { rank: 'C', stars: 0 });
  assert.deepEqual(calculateRank(99, true), { rank: 'F', stars: 0 });

  const store = new Map();
  const mockStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const first = saveRecord('demo:neon-drift:normal:standard', { score: 12000, accuracy: 92, maxCombo: 20, rank: 'A', stars: 2 }, mockStorage);
  assert.equal(first.isNewRecord, true);
  const lower = saveRecord('demo:neon-drift:normal:standard', { score: 9000, accuracy: 95, maxCombo: 25, rank: 'S', stars: 3 }, mockStorage);
  assert.equal(lower.isNewRecord, false);
  assert.equal(loadRecords(mockStorage)['demo:neon-drift:normal:standard'].score, 12000);
  assert.equal(loadRecords(mockStorage)['demo:neon-drift:normal:standard'].accuracy, 95);

  const chordEvents = Array.from({ length: 10 }, (_, i) => ({ time: 0.5 + i * 0.25, strength: 0.9, brightness: 300 + i * 50 }));
  const hardWithChords = buildAnalyzedChart(chordEvents, 'hard', 5, { allowChords: true });
  assert.ok(hardWithChords.length > chordEvents.length);
  const sameTimeGroups = hardWithChords.filter((n, idx, arr) => arr.some((m, j) => j !== idx && m.time === n.time && m.lane !== n.lane));
  assert.ok(sameTimeGroups.length >= 2);
});
// Chế độ 2D xác định đúng 4 cột Piano Tiles căn giữa và từ chối vùng ngoài khung.
test('Chạm cột chế độ 2D xác định đúng cột và từ chối ngoài vùng', () => {
  const layout = getLayout2D(800, 600);
  for (let lane = 0; lane < 4; lane++) {
    const cx = layout.left + (lane + 0.5) * layout.laneWidth;
    assert.equal(laneAt2D(800, 600, cx, 300), lane);
  }
  assert.equal(laneAt2D(800, 600, 5, 300), -1);
  assert.equal(laneAt2D(800, 600, 795, 300), -1);
});
// Bộ phân tích trên thiết bị phát hiện đúng các xung nhịp tổng hợp và từ chối âm thanh im lặng.
test('Phân tích tệp nhạc từ thiết bị dò đúng onset và từ chối im lặng', () => {
  const sr = 22050;
  const onsets = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0];
  const samples = new Float32Array(sr * 6);
  for (const onset of onsets) {
    const start = Math.floor(onset * sr);
    const len = Math.floor(sr * 0.15);
    for (let i = 0; i < len && start + i < samples.length; i++) {
      const t = i / sr;
      const env = Math.min(1, t / 0.004) * Math.exp(-t * 22);
      samples[start + i] += 0.7 * env * Math.sin(2 * Math.PI * 330 * t);
    }
  }
  const result = analyzeChannelData(samples, sr);
  assert.equal(result.duration, 6);
  for (const onset of onsets) {
    const nearest = Math.min(...result.events.map(e => Math.abs(e.time - onset)));
    assert.ok(nearest < 0.05, `Lệch onset tại ${onset}s: ${nearest}s`);
  }
  assert.throws(() => analyzeChannelData(new Float32Array(sr * 6), sr));
  assert.throws(() => analyzeChannelData(new Float32Array(sr * 2), sr));
});
