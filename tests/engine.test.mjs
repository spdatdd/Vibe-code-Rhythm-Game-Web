import test from 'node:test';
import assert from 'node:assert/strict';
import { videoId, makeChart, judge, award, findNote, LANE_KEYS, calibrateBeats, buildAnalyzedChart } from '../public/engine.js';
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
  assert.ok(hard.every(note => note.hold === 0 && note.lane >= 0 && note.lane < 4));
  const close = buildAnalyzedChart([{ time: 1, strength: .2, brightness: 300 }, { time: 1.05, strength: 1, brightness: 500 }], 'normal', 5);
  assert.equal(close.length, 1); assert.equal(close[0].time, 1.05);
  assert.deepEqual(buildAnalyzedChart([], 'normal', 5), []);
});
