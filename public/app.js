import { LANE_KEYS, videoId, makeChart, judge, award, findNote, calibrateBeats, buildAnalyzedChart } from './engine.js';
// Lấy phần tử giao diện theo ID để các thao tác cập nhật gọn và nhất quán.
const $ = id => document.getElementById(id);
const canvas = $('arena'), ctx = canvas.getContext('2d');
const keys = new Set(), taps = [];
const colors = ['#baff65', '#b09aff', '#67d5ff', '#ffb184'];
const laneLabels = ['D', 'F', 'J', 'K'];
const pointers = new Map();
// Lưu hiệu ứng theo từng cột để các phím có thể sáng độc lập.
const laneEffects = new Map();

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let source = 'demo', loadedId = '', prepared = null, musicBuffer = null, musicSource = null;
let analysisAvailable = false;
let prepareVersion = 0, prepareAbort = null, pasteTimer = null;
let mode = 'idle', chart = [], settings, stats, audio, anchor = 0, elapsed = 0;
let lastTime = 0, lastBeat = -1, pendingHold = null, feedback = '', feedbackUntil = 0;
let activeSounds = [];
// Hiển thị thông báo ngắn về trạng thái trò chơi cho người dùng.
function status(message) { $('status').textContent = message; }
// Đọc và giới hạn các tham số để tránh bản đồ rỗng hoặc quá lớn.
function readSettings() {
  const bounds = { bpm: [40, 240, 120], offset: [0, 3600, 2], duration: [15, 600, 48], latency: [-300, 300, 0] };
  const result = { difficulty: $('difficulty').value };
  for (const [id, [min, max, fallback]] of Object.entries(bounds)) {
    const n = Number($(id).value);
    result[id] = Math.max(min, Math.min(max, Number.isFinite(n) ? n : fallback));
    $(id).value = result[id];
  }
  return result;
}
// Tạo lại lượt chơi và làm sạch toàn bộ điểm cùng trạng thái giữ phím.
function resetRound() {
  settings = readSettings();
  if (source === 'youtube' && prepared) { settings.duration = prepared.duration; chart = buildAnalyzedChart(prepared.events, settings.difficulty, settings.duration); }
  else chart = source === 'demo' ? makeChart(settings) : [];
  stats = { score: 0, combo: 0, maxCombo: 0, judged: 0, weight: 0 };
  elapsed = 0; lastTime = 0; lastBeat = -1; pendingHold = null; feedback = ''; clearInputs(); laneEffects.clear();
  $('note-count').textContent = `${chart.length} NỐT`;
  $('progress').style.width = '0%'; updateScore();
}
// Cập nhật các chỉ số, độ chính xác được tính trên toàn bộ nốt đã phán xét.
function updateScore() {
  $('score').textContent = String(stats.score).padStart(6, '0');
  $('combo').innerHTML = `${stats.combo}<span>×</span>`;
  $('accuracy').textContent = stats.judged ? `${Math.round(stats.weight / stats.judged * 100)}%` : '—';
}
// Khóa nút chơi đến khi cả chart và âm thanh đã sẵn sàng; vẫn cho phép hủy chuẩn bị.
function setMode(next) {
  mode = next;
  const active = ['playing', 'paused', 'waiting'].includes(mode), preparing = mode === 'preparing';
  $('settings').disabled = active || preparing;
  for (const id of ['demo-tab', 'youtube-tab', 'load-video', 'video-url', 'reset']) $(id).disabled = active || preparing;
  $('youtube-tab').disabled ||= !analysisAvailable;
  for (const id of ['bpm', 'offset', 'duration', 'tap']) $(id).disabled = source === 'youtube';
  $('start').disabled = active || preparing || (source === 'youtube' && (!prepared || !musicBuffer));
  $('restart').disabled = preparing || mode === 'waiting' || (source === 'youtube' && (!prepared || !musicBuffer));
  $('stop').disabled = !active || mode === 'waiting';
  $('cancel-prepare').hidden = !preparing;
  $('pause').disabled = !active || mode === 'waiting';
  $('pause').textContent = mode === 'paused' ? 'Tiếp tục' : 'Tạm dừng';
  $('phase').textContent = { idle: 'SẴN SÀNG', playing: 'ĐANG CHƠI', paused: 'TẠM DỪNG', waiting: 'CHUẨN BỊ PHÁT', preparing: 'ĐANG PHÂN TÍCH', ended: 'HOÀN THÀNH' }[mode];
  $('center-message').hidden = mode === 'playing';
}
// Hiển thị lời nhắc hoặc tổng kết ở giữa sân chơi bằng text an toàn.
function center(title, subtitle) {
  $('center-message').querySelector('strong').textContent = title;
  $('center-message').querySelector('p').textContent = subtitle;
}
// Dùng đồng hồ đầu ra âm thanh cho cả vị trí nốt và chấm điểm để không tích lũy độ trôi.
function time() {
  if (mode !== 'playing') return elapsed;
  let clock = audio.currentTime;
  if (source === 'youtube') {
    const stamp = audio.getOutputTimestamp?.();
    if (stamp?.contextTime > 0 && stamp.performanceTime > 0) {
      clock = Math.min(audio.currentTime, stamp.contextTime + Math.max(0, performance.now() - stamp.performanceTime) / 1000);
    } else clock -= audio.outputLatency || audio.baseLatency || 0;
  }
  return clock - anchor;
}
// Dừng nguồn phát đã chuẩn bị mà không làm mất AudioBuffer để có thể tiếp tục chính xác.
function stopMusic() {
  if (musicSource) { musicSource.onended = null; try { musicSource.stop(); } catch {} musicSource.disconnect(); musicSource = null; }
}
// Lên lịch âm thanh theo Web Audio; dành hai giây đếm vào để thấy các nốt đầu bài.
function playMusic(position) {
  stopMusic();
  const delay = .08 + Math.max(0, -position), offset = Math.max(0, position);
  anchor = audio.currentTime + delay - offset;
  musicSource = audio.createBufferSource(); musicSource.buffer = musicBuffer;
  musicSource.connect(audio.destination);
  // Hoàn tất lượt khi chính nguồn âm thanh kết thúc, không dựa vào timer JavaScript.
  musicSource.onended = () => { if (mode === 'playing') finish(); };
  musicSource.start(audio.currentTime + delay, offset);
}
// Khởi tạo Web Audio khi có tương tác để trình duyệt cho phép phát nhạc demo.
async function initAudio() {
  audio ||= new AudioContext();
  if (audio.state !== 'running') await audio.resume();
}
// Phát một âm tổng hợp với đường bao mềm, không cần tải tệp nhạc ngoài.
function tone(frequency, at, length, type, volume) {
  const osc = audio.createOscillator(), gain = audio.createGain();
  osc.type = type; osc.frequency.setValueAtTime(frequency, at);
  gain.gain.setValueAtTime(.001, at); gain.gain.exponentialRampToValueAtTime(volume, at + .01);
  gain.gain.exponentialRampToValueAtTime(.001, at + length);
  osc.connect(gain).connect(audio.destination); osc.start(at); osc.stop(at + length);
  activeSounds.push(osc);
  // Gỡ âm đã kết thúc khỏi danh sách để không tích lũy bộ nhớ.
  osc.onended = () => { activeSounds = activeSounds.filter(item => item !== osc); osc.disconnect(); gain.disconnect(); };
}
// Kích hoạt phản hồi thị giác theo cột, không tạo âm thanh khi nhấn phím.
function reactToLane(lane, rating = 'PRESS') {
  laneEffects.set(lane, { started: performance.now(), rating });
}
// Dừng cả âm đang phát và âm đã lên lịch khi tạm dừng hoặc chơi lại.
function stopSounds() { for (const osc of activeSounds) { try { osc.stop(); } catch {} } activeSounds = []; }
// Lên lịch vòng nhạc demo bằng đồng hồ âm thanh thay vì bộ đếm JavaScript.
function scheduleDemo(t) {
  const beat = 60 / settings.bpm;
  const phase = settings.offset % beat;
  const target = Math.floor((t - phase + .12) / beat);
  while (lastBeat < target) {
    lastBeat++;
    const at = anchor + phase + lastBeat * beat;
    if (at < audio.currentTime || phase + lastBeat * beat >= settings.duration) continue;
    const melody = [261.63, 329.63, 392, 493.88, 440, 392, 329.63, 293.66];
    tone(lastBeat % 4 === 0 ? 65.4 : 82.4, at, .22, 'triangle', .23);
    tone(melody[lastBeat % 8], at, .18, 'sine', .10);
    tone(lastBeat % 2 ? 1800 : 90, at, .05, 'triangle', .07);
  }
}
// Bắt đầu lượt sau khi dữ liệu âm thanh và chart cùng sẵn sàng.
async function start() {
  if (['playing', 'paused', 'waiting', 'preparing'].includes(mode)) return;
  if (source === 'youtube' && (!prepared || !musicBuffer)) { status('Hãy phân tích bài nhạc trước khi chơi.'); return; }
  resetRound();
  if (!chart.length) { status('Chưa có đủ nốt để chơi. Thử độ khó khác hoặc chọn bài khác.'); return; }
  setMode('waiting');
  try {
    await initAudio();
    if (source === 'youtube') { elapsed = -2; playMusic(-2); }
    else anchor = audio.currentTime;
    setMode('playing');
    status(source === 'youtube' ? 'Nốt bám theo điểm khởi âm đã phân tích. Nhạc đã nạp đủ, không tải đệm trong lượt chơi.' : 'Bấm D / F / J / K khi ô tới vạch sáng.');
    canvas.parentElement.focus();
  } catch { setMode('idle'); status('Không phát được âm thanh. Bấm Bắt đầu để thử lại.'); }
}
// Tạm dừng và tiếp tục tại đúng vị trí âm thanh đã nghe được.
async function togglePause() {
  if (mode === 'playing') {
    elapsed = time(); stopMusic(); clearInputs(); stopSounds();
    setMode('paused'); center('Tạm nghỉ một nhịp', 'Bấm Tiếp tục khi bạn đã sẵn sàng.');
  } else if (mode === 'paused') {
    try {
      await initAudio();
      if (source === 'youtube') playMusic(elapsed);
      else { anchor = audio.currentTime - elapsed; lastBeat = Math.floor((elapsed - settings.offset % (60 / settings.bpm)) / (60 / settings.bpm)); }
      setMode('playing'); canvas.parentElement.focus();
    } catch { status('Không thể tiếp tục âm thanh. Hãy thử lại.'); }
  }
}
// Kết thúc lượt và dừng mọi nguồn âm thanh đang phát.
function finish() {
  for (const note of chart) if (note.state === 'pending' || note.state === 'holding') { note.state = 'miss'; award(stats, 'MISS'); }
  elapsed = settings.duration; stopMusic(); stopSounds(); setMode('ended');
  updateScore(); center('Đã hoàn thành bài nhạc!', stats.score.toLocaleString('vi-VN') + ' điểm · Combo cao nhất ' + stats.maxCombo + '× · ' + (Math.round(stats.weight / stats.judged * 100) || 0) + '% chính xác');
  status('Bấm Chơi lại để thử lượt mới, hoặc chuẩn bị bài nhạc khác.');
}
// Dừng lượt để đổi độ khó hoặc bài nhạc mà không cần tải lại trang.
function stopRound() {
  stopMusic(); stopSounds(); setMode('idle'); resetRound(); center('Sẵn sàng vào nhịp?', 'Bấm Bắt đầu chơi khi bạn đã sẵn sàng.');
}
// Ghi nhận kết quả duy nhất cho một nốt và phát phản hồi trực quan.
function resolve(note, rating) {
  note.state = rating === 'MISS' ? 'miss' : 'hit'; award(stats, rating);
  reactToLane(note.lane, rating);
  feedback = rating; feedbackUntil = performance.now() + 650; updateScore();
}
// Xóa đồng thời bàn phím và cảm ứng khi tạm dừng hoặc bắt đầu lượt mới.
function clearInputs() { keys.clear(); pointers.clear(); }
// Kiểm tra cột đang được giữ bằng bàn phím, chuột hoặc ngón tay.
function laneHeld(lane) {
  return keys.has(LANE_KEYS[lane]) || [...pointers.values()].includes(lane);
}
// Chấm riêng từng cột; bấm ô trống làm đứt combo và giảm độ chính xác.
function strike(lane) {
  if (mode !== 'playing') {
    if (mode === 'idle' || mode === 'ended') reactToLane(lane);
    return;
  }
  const t = time() - settings.latency / 1000;
  if (pendingHold?.lane === lane) return;
  const note = findNote(chart, lane, t);
  if (!note) { reactToLane(lane, 'MISS'); award(stats, 'MISS'); feedback = 'Ô TRỐNG'; feedbackUntil = performance.now() + 400; updateScore(); return; }
  const rating = judge(t - note.time);
  if (note.hold) { note.state = 'holding'; note.rating = rating; pendingHold = note; reactToLane(lane, 'HOLD'); }
  else resolve(note, rating);
}
// Gọi API cục bộ với thông báo lỗi rõ ràng, không dùng dữ liệu lỗi như kết quả thành công.
async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: prepareAbort?.signal });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || 'Máy chủ không xử lý được yêu cầu.');
    error.code = data.code;
    throw error;
  }
  return data;
}
// Hiển thị tiến độ tải, phân tích và giải mã trước khi cho phép bắt đầu.
function showPreparation(progress, message) {
  $('analysis-panel').hidden = false;
  $('analysis-progress').value = progress;
  $('analysis-message').textContent = message;
  status(message);
}
// Chờ giữa các lần kiểm tra tiến độ, có thể hủy ngay khi người dùng nhấn Hủy.
function pollDelay(signal, milliseconds = 700) {
  return new Promise((resolveDelay, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolveDelay(); }, milliseconds);
    // Hủy bộ đếm chờ để không chạy tiếp tác vụ cũ.
    function abort() { clearTimeout(timer); reject(new DOMException('Đã hủy', 'AbortError')); }
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
// Thử lại khi host Free đang thức dậy; gửi cùng ID nên server có thể dùng lại tác vụ.
async function startPreparation(id, signal) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestJson('/api/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: id }),
      });
    } catch (error) {
      if (error.code !== 'BACKEND_STARTING' || attempt >= 7) throw error;
      showPreparation(1, 'Đang đánh thức máy chủ phân tích. Lần đầu có thể mất khoảng một phút…');
      await pollDelay(signal, 3000);
    }
  }
}
// Tải và phân tích bài hát rồi giải mã chính tệp PCM đó thành AudioBuffer để phát đồng bộ.
async function loadVideo() {
  if (['preparing', 'playing', 'paused', 'waiting'].includes(mode)) return;
  clearTimeout(pasteTimer);
  const id = videoId($('video-url').value);
  if (!id) { status('Dán một link YouTube hợp lệ.'); return; }
  stopMusic(); loadedId = id; prepared = null; musicBuffer = null;
  const version = ++prepareVersion;
  prepareAbort?.abort(); prepareAbort = new AbortController();
  setMode('preparing'); resetRound(); center('Đang chuẩn bị bài nhạc…', 'Chỉ bắt đầu khi âm thanh và bản đồ nốt đã sẵn sàng.');
  showPreparation(1, 'Đang gửi bài nhạc tới công cụ phân tích…');
  try {
    let job = await startPreparation(id, prepareAbort.signal);
    while (version === prepareVersion && job.stage !== 'ready') {
      if (['error', 'cancelled'].includes(job.stage)) throw new Error(job.message);
      showPreparation(job.progress * .9, job.message);
      await pollDelay(prepareAbort.signal);
      job = await requestJson('/api/tracks/' + id);
    }
    if (version !== prepareVersion) return;
    showPreparation(92, 'Đã phân tích xong. Đang nạp toàn bộ âm thanh để phát không gián đoạn…');
    const result = await requestJson('/api/tracks/' + id + '/result');
    const response = await fetch('/api/tracks/' + id + '/audio', { signal: prepareAbort.signal });
    if (!response.ok) throw new Error('Không tải được âm thanh đã chuẩn bị.');
    const bytes = await response.arrayBuffer();
    audio ||= new AudioContext();
    const decoded = await audio.decodeAudioData(bytes);
    if (version !== prepareVersion) return;
    if (Math.abs(decoded.duration - result.duration) > .1) throw new Error('Độ dài âm thanh không khớp bản phân tích. Hãy chuẩn bị lại.');
    prepared = result; musicBuffer = decoded;
    $('bpm').value = result.bpm; $('offset').value = result.events[0]?.time || 0;
    $('duration').value = result.duration; $('latency').value = 0; $('latency-value').textContent = '0 ms';
    $('track-title').textContent = result.title;
    $('original-video').href = 'https://www.youtube.com/watch?v=' + id; $('original-video').hidden = false;
    resetRound(); setMode('idle');
    showPreparation(100, 'Sẵn sàng · ' + chart.length + ' nốt · ' + formatTime(result.duration) + ' · Không cần nhập BPM');
    center('Bài nhạc đã sẵn sàng', 'Bấm Bắt đầu chơi. Có 2 giây đếm vào trước khi nhạc phát.');
  } catch (error) {
    if (version !== prepareVersion) return;
    prepared = null; musicBuffer = null; setMode('idle');
    showPreparation(0, error.name === 'AbortError' ? 'Đã hủy chuẩn bị.' : 'Không chuẩn bị được: ' + error.message);
    center('Chưa thể bắt đầu', 'Bấm Phân tích để thử lại hoặc chọn bài khác.');
  }
}
// Hủy cả tải phía trình duyệt và tác vụ phân tích phía máy chủ.
async function cancelPreparation() {
  const id = loadedId; ++prepareVersion; prepareAbort?.abort();
  try { await fetch('/api/tracks/' + id, { method: 'DELETE' }); } catch {}
  prepared = null; musicBuffer = null; setMode('idle');
  showPreparation(0, 'Đã hủy chuẩn bị. Bạn có thể chọn bài khác.'); center('Đã hủy', 'Dán link mới hoặc bấm Phân tích để thử lại.');
}
// Chuyển giữa nhạc demo và bài YouTube đã chuẩn bị; không để hai nguồn phát chồng nhau.
function selectSource(next) {
  if (next === 'youtube' && !analysisAvailable) return;
  if (['playing', 'paused', 'waiting', 'preparing'].includes(mode)) return;
  clearTimeout(pasteTimer); source = next; stopMusic(); stopSounds();
  $('demo-tab').classList.toggle('selected', next === 'demo'); $('youtube-tab').classList.toggle('selected', next === 'youtube');
  $('demo-panel').hidden = next !== 'demo'; $('youtube-panel').hidden = next !== 'youtube';
  $('mode-label').textContent = next === 'demo' ? 'NEON DRIFT' : 'YOUTUBE SESSION';
  $('source-label').textContent = next === 'demo' ? '/ DEMO ORIGINAL' : '/ AUTO CHART';
  if (next === 'demo') { $('bpm').value = 120; $('offset').value = 2; $('duration').value = 48; }
  else if (prepared) { $('bpm').value = prepared.bpm; $('duration').value = prepared.duration; }
  resetRound(); setMode('idle'); center('Sẵn sàng vào nhịp?', next === 'demo' ? 'Bấm D / F / J / K hoặc chạm cột.' : 'Dán link để tự động phân tích trước khi chơi.');
  status(next === 'demo' ? 'Nhạc demo đã sẵn sàng.' : 'Dán link YouTube. Game chỉ cho chơi sau khi chuẩn bị xong.');
}
// Tính kích thước bàn đàn và vạch đánh dùng chung cho vẽ và cảm ứng.
function boardGeometry() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const width = Math.min(w - 24, 460), left = (w - width) / 2;
  return { w, h, width, left, laneWidth: width / 4, hitY: h - 88, speed: (h - 110) / 2 };
}
// Vẽ ô đàn bo góc, dùng cùng hình dạng cho nốt đơn và nốt giữ.
function tile(x, y, width, height, color) {
  ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(x, y, width, Math.max(8, height), 7); ctx.fill();
}
// Vẽ bốn cột Piano Tiles; đáy ô chạm vạch sáng đúng thời điểm cần bấm.
function draw(t) {
  const { w, h, width, left, laneWidth, hitY, speed } = boardGeometry();
  const dpr = devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  for (let lane = 0; lane < 4; lane++) {
    const x = left + lane * laneWidth, held = laneHeld(lane);
    ctx.fillStyle = held ? colors[lane] + '22' : lane % 2 ? '#1c202b' : '#171b24';
    ctx.fillRect(x + 1, 0, laneWidth - 2, h - 40);
    ctx.strokeStyle = '#343b48'; ctx.lineWidth = 1;
    ctx.strokeRect(x, 0, laneWidth, h - 40);
    tile(x + 7, hitY + 12, laneWidth - 14, 32, held ? colors[lane] : '#2b3241');
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = 'bold 16px monospace';
    ctx.fillStyle = held ? '#10151c' : '#dce2ed'; ctx.fillText(laneLabels[lane], x + laneWidth / 2, hitY + 28);
  }
  ctx.save(); ctx.beginPath(); ctx.rect(left, 0, width, hitY + 10); ctx.clip();
  for (const note of chart) {
    if (!['pending', 'holding'].includes(note.state)) continue;
    const bottom = note.state === 'holding' ? hitY : hitY - (note.time - t) * speed;
    const top = note.hold ? hitY - (note.time + note.hold - t) * speed - 28 : bottom - 46;
    if (bottom < 0 || top > hitY + 10) continue;
    const x = left + note.lane * laneWidth + 8;
    tile(x, top, laneWidth - 16, bottom - top, colors[note.lane]);
    ctx.fillStyle = '#17201ccc'; ctx.font = 'bold 13px monospace';
    ctx.fillText(note.hold ? 'GIỮ' : '♪', x + (laneWidth - 16) / 2, bottom - 18);
    if (note.hold) { ctx.fillStyle = '#ffffff88'; ctx.fillRect(x + (laneWidth - 16) / 2 - 2, top + 10, 4, Math.max(0, bottom - top - 45)); }
  }
  ctx.restore();
  ctx.shadowColor = '#baff65'; ctx.shadowBlur = 12; ctx.fillStyle = '#baff65';
  ctx.fillRect(left, hitY, width, 3); ctx.shadowBlur = 0;
  drawFeedback(left, laneWidth, hitY);
  // Đếm vào hiển thị trực tiếp theo đồng hồ âm thanh trước khi bài nhạc bắt đầu.
  if (mode === 'playing' && t < 0) {
    ctx.fillStyle = '#baff65'; ctx.textAlign = 'center'; ctx.font = 'bold 42px monospace';
    ctx.fillText(String(Math.min(2, Math.ceil(-t))), w / 2, hitY / 2);
  }
  if (performance.now() < feedbackUntil) {
    ctx.textAlign = 'center'; ctx.fillStyle = ['MISS', 'Ô TRỐNG'].includes(feedback) ? '#ff8d9a' : '#baff65';
    ctx.font = 'bold 24px monospace'; ctx.fillText(feedback, w / 2, 42);
  }
}
// Vẽ ánh sáng, gợn và tia nhỏ; giảm chuyển động nếu hệ điều hành yêu cầu.
function drawFeedback(left, laneWidth, hitY) {
  const now = performance.now();
  for (const [lane, effect] of laneEffects) {
    const progress = (now - effect.started) / 420;
    if (progress >= 1) { laneEffects.delete(lane); continue; }
    const x = left + lane * laneWidth, centerX = x + laneWidth / 2;
    const color = effect.rating === 'MISS' ? '#ff7189' : colors[lane];
    ctx.save(); ctx.globalAlpha = (1 - progress) * .4;
    ctx.fillStyle = color; ctx.fillRect(x + 2, 0, laneWidth - 4, hitY + 48);
    ctx.globalAlpha = 1 - progress; ctx.strokeStyle = color; ctx.lineWidth = 3;
    ctx.strokeRect(x + 5, hitY + 10, laneWidth - 10, 36);
    if (!reducedMotion.matches) {
      ctx.beginPath(); ctx.ellipse(centerX, hitY, 10 + progress * laneWidth * .42, 5 + progress * 23, 0, 0, Math.PI * 2); ctx.stroke();
      if (!['MISS', 'PRESS'].includes(effect.rating)) {
        for (let i = 0; i < 6; i++) {
          const angle = Math.PI + i * Math.PI / 5;
          const distance = 12 + progress * 65;
          ctx.fillRect(centerX + Math.cos(angle) * distance - 2, hitY + Math.sin(angle) * distance - 2, 4, 4);
        }
      }
    }
    ctx.restore();
  }
}
// Bắt đầu nhấn trên cột bằng chuột hoặc cảm ứng, hỗ trợ nhiều ngón tay.
canvas.addEventListener('pointerdown', event => {
  if (['paused', 'waiting'].includes(mode) || (event.pointerType === 'mouse' && event.button !== 0)) return;
  const { left, width, laneWidth } = boardGeometry();
  const x = event.clientX - canvas.getBoundingClientRect().left;
  if (x < left || x >= left + width) return;
  event.preventDefault(); canvas.parentElement.focus();
  const lane = Math.floor((x - left) / laneWidth);
  const alreadyHeld = laneHeld(lane);
  pointers.set(event.pointerId, lane); canvas.setPointerCapture(event.pointerId);
  if (!alreadyHeld) strike(lane);
});
// Kết thúc thao tác giữ kể cả khi con trỏ đã rời khỏi sân chơi.
function releasePointer(event) { pointers.delete(event.pointerId); }
canvas.addEventListener('pointerup', releasePointer);
canvas.addEventListener('pointercancel', releasePointer);
canvas.addEventListener('lostpointercapture', releasePointer);
// Định dạng thời gian sang phút và giây để hiển thị trên thanh tiến trình.
function formatTime(t) { return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`; }
// Chạy vòng game, phát nhạc demo, kiểm tra miss/hold và cập nhật hình ảnh.
function frame() {
  let t = time();
  if (mode === 'playing') {
    {
      lastTime = t;
      if (source === 'demo') scheduleDemo(t);
      const judgedTime = t - settings.latency / 1000;
      if (pendingHold) {
        if (judgedTime >= pendingHold.time + pendingHold.hold - .07) { resolve(pendingHold, pendingHold.rating); pendingHold = null; }
        else if (!laneHeld(pendingHold.lane)) { resolve(pendingHold, 'MISS'); pendingHold = null; }
      }
      for (const note of chart) if (note.state === 'pending' && judgedTime - note.time > .19) resolve(note, 'MISS');
      if (t >= settings.duration) finish();
    }
  }
  if (mode === 'idle') t = 0;
  draw(t - settings.latency / 1000);
  $('clock').textContent = `${formatTime(Math.max(0, Math.min(t, settings.duration)))} / ${formatTime(settings.duration)}`;
  $('progress').style.width = `${Math.max(0, Math.min(100, t / settings.duration * 100))}%`;
  requestAnimationFrame(frame);
}
// Xử lý bàn phím gameplay, bỏ qua ô nhập và không nhận phím lặp tự động.
document.addEventListener('keydown', event => {
  if (event.target.closest('input,select,textarea,button')) return;
  if (event.code === 'Escape') { event.preventDefault(); togglePause(); return; }
  if (LANE_KEYS.includes(event.code)) {
    event.preventDefault(); if (event.repeat) return; keys.add(event.code);
    strike(LANE_KEYS.indexOf(event.code));
  }
});
// Thả trạng thái giữ ngay khi phím được nhả.
document.addEventListener('keyup', event => { keys.delete(event.code); });
// Tạm dừng khi chuyển cửa sổ để người chơi không mất điểm ngoài ý muốn.
window.addEventListener('blur', () => { if (mode === 'playing') togglePause(); clearInputs(); });
// Tạm dừng khi tab bị ẩn để vòng render không làm đồng hồ demo trôi quá xa.
document.addEventListener('visibilitychange', () => { if (document.hidden && mode === 'playing') togglePause(); });
$('start').addEventListener('click', start);
$('pause').addEventListener('click', togglePause);
$('load-video').addEventListener('click', loadVideo);
// Hủy lượt hiện tại trước khi khởi động lại từ đầu.
$('restart').addEventListener('click', () => { stopRound(); start(); });
$('stop').addEventListener('click', stopRound);
$('cancel-prepare').addEventListener('click', cancelPreparation);
// Tự chuẩn bị sau khi dán link hợp lệ, không khởi chạy trên mỗi ký tự đang nhập.
$('video-url').addEventListener('input', () => {
  clearTimeout(pasteTimer); prepared = null; musicBuffer = null; loadedId = ''; setMode('idle'); resetRound();
  $('track-title').textContent = ''; $('original-video').hidden = true;
  if (videoId($('video-url').value)) pasteTimer = setTimeout(loadVideo, 900);
});
// Chọn nhạc demo tích hợp cho chế độ thử không cần mạng.
$('demo-tab').addEventListener('click', () => selectSource('demo'));
// Mở chế độ nhập video YouTube của người dùng.
$('youtube-tab').addEventListener('click', () => selectSource('youtube'));
// Cập nhật số mili giây bù trễ được chọn trên thanh trượt.
$('latency').addEventListener('input', () => { $('latency-value').textContent = `${$('latency').value} ms`; });
// Tạo lại bản đồ xem trước khi người dùng thay đổi tham số trong trạng thái nghỉ.
$('settings').addEventListener('change', () => {
  if (mode === 'idle' || mode === 'ended') {
    resetRound();
    if (source === 'youtube' && prepared) showPreparation(100, 'Sẵn sàng · ' + chart.length + ' nốt · ' + formatTime(prepared.duration) + ' · Không cần nhập BPM');
  }
});
// Tap tempo chỉ dành cho demo; bản đồ YouTube luôn dùng timestamp đã phân tích.
$('tap').addEventListener('click', () => {
  if (source !== 'demo') return;
  const now = performance.now() / 1000;
  if (taps.length && now - taps.at(-1) > 1.6) taps.length = 0;
  taps.push(now); if (taps.length > 24) taps.shift();
  const result = calibrateBeats(taps);
  if (result) { $('bpm').value = result.bpm; resetRound(); status('Đã cập nhật BPM demo.'); }
});
// Lưu cấu hình vào trình duyệt hiện tại, báo lỗi khi localStorage bị chặn.
$('save').addEventListener('click', () => {
  try { localStorage.setItem('orbit-settings-v1', JSON.stringify({ ...readSettings(), url: $('video-url').value })); status('Đã lưu thiết lập trên trình duyệt này.'); }
  catch { status('Trình duyệt không cho phép lưu. Cấu hình hiện tại vẫn dùng được.'); }
});
// Khôi phục thông số gốc và xóa cấu hình đã lưu mà không tác động tệp dự án.
$('reset').addEventListener('click', () => {
  for (const [id, value] of Object.entries({ bpm: 120, offset: 2, duration: 48, difficulty: 'normal', latency: 0 })) $(id).value = value;
  $('latency-value').textContent = '0 ms'; try { localStorage.removeItem('orbit-settings-v1'); } catch {}
  resetRound(); status('Đã khôi phục nhịp mặc định.');
});
// Đọc cấu hình đã lưu một cách phòng thủ và khởi tạo vòng render đầu tiên.
try {
  const saved = JSON.parse(localStorage.getItem('orbit-settings-v1') || 'null');
  if (saved && typeof saved === 'object') {
    for (const id of ['bpm', 'offset', 'duration', 'latency']) if (typeof saved[id] === 'number') $(id).value = saved[id];
    if (['easy', 'normal', 'hard'].includes(saved.difficulty)) $('difficulty').value = saved.difficulty;
    if (typeof saved.url === 'string') $('video-url').value = saved.url;
    $('latency-value').textContent = `${$('latency').value} ms`;
  }
} catch {}
// Bật phân tích YouTube khi máy chủ xác nhận hỗ trợ; bản web tĩnh chỉ mở demo.
async function checkAnalysisSupport() {
  try {
    const response = await fetch('/api/capabilities', { signal: AbortSignal.timeout(5000) });
    analysisAvailable = response.ok && (await response.json()).youtubeAnalysis === true;
  } catch {
    analysisAvailable = false;
  }
  $('analysis-unavailable').hidden = analysisAvailable;
  $('youtube-tab').disabled = !analysisAvailable || ['playing', 'paused', 'waiting', 'preparing'].includes(mode);
}

resetRound(); setMode('idle'); requestAnimationFrame(frame);
void checkAnalysisSupport();
