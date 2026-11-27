import { LANE_KEYS, calculateRank, videoId, judge, award, findNote, buildAnalyzedChart } from './engine.js';
import {
  loadSettings,
  saveSettings,
  clampOffsetMs,
  clampScrollSpeed,
  normalizeDifficulty,
  normalizeRenderMode,
  loadRecords,
  saveRecord,
} from './modules/settings.js';
import { createAudioEngine } from './modules/audio.js';
import { analyzeAudioBufferAsync } from './modules/local-analyzer.js';
import { checkAnalysisSupport, prepareTrack, cancelTrackPreparation } from './modules/youtube-client.js';
import { createRenderer } from './modules/renderer.js';
import { createRenderer2D } from './modules/renderer2d.js';
import { setupInputs } from './modules/input.js';

const $ = id => document.getElementById(id);
const stage = document.querySelector('.stage');
const canvas2d = $('arena-2d');
const canvas3d = $('arena-3d');
const difficultyButtons = [...document.querySelectorAll('[data-difficulty]')];
const renderModeButtons = [...document.querySelectorAll('[data-render-mode]')];
const colors = ['#007aff', '#af52de', '#ff9500', '#10b981'];
const laneLabels = ['D', 'F', 'J', 'K'];
const activeHolds = new Map();
const MAX_MISSES = 5;

let difficulty = 'normal', renderMode = '2d', scrollSpeed = 1.0, audioOffsetMs = 0;
let source = 'local', loadedId = '', prepared = null, musicBuffer = null, analysisAvailable = false;
let localTrack = null, localBuffer = null;
let prepareVersion = 0, prepareAbort = null, pasteTimer = null;
let screen = 'loading', mode = 'idle', chart = [], duration = 0, stats, anchor = 0, elapsed = 0;
let nextMissIndex = 0, resumeGraceUntil = 0, feedback = '', feedbackUntil = 0;

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const audio = createAudioEngine({ onBufferEnded: () => { if (mode === 'playing') finish(); } });
const renderer2d = createRenderer2D(canvas2d, {
  colors,
  laneLabels,
  reducedMotion,
  countdownEl: $('countdown'),
  feedbackEl: $('judge-feedback'),
});
let renderer3d = null;
function activeRenderer() {
  if (renderMode === '3d') {
    renderer3d ||= createRenderer(canvas3d, {
      colors,
      laneLabels,
      reducedMotion,
      countdownEl: $('countdown'),
      feedbackEl: $('judge-feedback'),
    });
    return renderer3d;
  }
  return renderer2d;
}
const inputs = setupInputs({
  stage,
  laneKeys: LANE_KEYS,
  getRenderMode: () => renderMode,
  isBlocked: () => screen !== 'game' || mode !== 'playing',
  onStrike: strike,
  onPause: () => { if (screen === 'game' && ['playing', 'paused'].includes(mode)) togglePause(); },
});

function formatTime(t) { return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`; }
function setStatus(message) { $('menu-status').textContent = message; }
function persistSettings() {
  saveSettings({
    url: $('video-url').value,
    difficulty,
    audioOffsetMs,
    renderMode,
    scrollSpeed,
  });
}

function getRecordKey() {
  const trackKey = source === 'local' ? (localTrack?.title || 'local') : (loadedId || 'youtube');
  return `${source}:${trackKey}:${difficulty}`;
}
function time() { return mode === 'playing' ? audio.outputClock() - anchor - audioOffsetMs / 1000 : elapsed; }

/** Chuyển đổi giữa các màn hình: loading, menu và game. */
function showScreen(next) {
  screen = next;
  $('screen-loading').hidden = next !== 'loading';
  $('screen-menu').hidden = next !== 'menu';
  $('screen-game').hidden = next !== 'game';
}

function activePrepared() {
  if (source === 'local') return localTrack && localBuffer ? { data: localTrack, buffer: localBuffer } : null;
  if (source === 'youtube') return prepared && musicBuffer ? { data: prepared, buffer: musicBuffer } : null;
  return null;
}

function updateScore() {
  $('score').textContent = String(stats.score).padStart(6, '0');
  $('combo-value').textContent = String(stats.combo);
  $('accuracy').textContent = stats.judged ? `${Math.round(stats.weight / stats.judged * 100)}%` : '—';
}

function resetRound() {
  const custom = activePrepared();
  duration = custom ? custom.data.duration : 0;
  chart = custom
    ? buildAnalyzedChart(custom.data.events, difficulty, duration, { allowChords: difficulty === 'hard' })
    : [];
  stats = { score: 0, combo: 0, maxCombo: 0, judged: 0, weight: 0, misses: 0 };
  elapsed = 0; nextMissIndex = 0; resumeGraceUntil = 0; feedback = '';
  activeHolds.clear(); inputs.clear(); renderer2d.clearEffects(); renderer3d?.clearEffects();
  $('note-count').textContent = `${chart.length} nốt`;
  $('progress').style.width = '0%';
  updateScore();
}

function setMode(next) {
  mode = next;
  const active = ['playing', 'paused', 'waiting'].includes(mode);
  const preparing = mode === 'preparing';
  for (const button of difficultyButtons) button.disabled = active || preparing;
  for (const button of renderModeButtons) button.disabled = active || preparing;
  $('scroll-speed').disabled = active || preparing;
  for (const id of ['local-tab', 'youtube-tab', 'load-video', 'video-url']) $(id).disabled = active || preparing;
  $('youtube-tab').disabled ||= !analysisAvailable;
  $('start').disabled = active || preparing || !activePrepared();
  $('cancel-prepare').hidden = !preparing;
  $('pause-overlay').hidden = mode !== 'paused';
  $('result-overlay').hidden = mode !== 'ended';
}

function updateGameHeader() {
  const diffLabel = { normal: 'THƯỜNG', hard: 'KHÓ' }[difficulty] || 'THƯỜNG';
  const title = source === 'local'
    ? (localTrack?.title || 'NHẠC THIẾT BỊ')
    : (prepared?.title || 'YOUTUBE');
  $('game-title').textContent = title;
  $('game-meta').textContent = `${diffLabel} · ${chart.length} NỐT`;
}

async function start() {
  if (['playing', 'paused', 'waiting', 'preparing'].includes(mode)) return;
  const custom = activePrepared();
  if (!custom) {
    setStatus(source === 'local' ? 'Hãy chọn một tệp nhạc từ thiết bị trước khi chơi.' : 'Hãy phân tích bài nhạc YouTube trước khi chơi.');
    return;
  }
  resetRound();
  if (!chart.length) { setStatus('Chưa có đủ nốt để chơi. Hãy chọn bài khác.'); return; }
  updateGameHeader();
  showScreen('game');
  setMode('waiting');
  try {
    await audio.ensureRunning();
    elapsed = -2;
    anchor = audio.playBuffer(custom.buffer, -2);
    setMode('playing');
    stage.focus();
  } catch {
    showScreen('menu');
    setMode('idle');
    setStatus('Không phát được âm thanh. Bấm Bắt đầu để thử lại.');
  }
}

async function togglePause() {
  if (mode === 'playing') {
    elapsed = time();
    audio.stopBuffer();
    inputs.clear();
    $('pause-subtitle').textContent = `${$('game-title').textContent} · ${stats.score.toLocaleString('vi-VN')} điểm`;
    setMode('paused');
  } else if (mode === 'paused') {
    try {
      await audio.ensureRunning();
      const custom = activePrepared();
      if (!custom) return;
      anchor = audio.playBuffer(custom.buffer, elapsed);
      if (activeHolds.size) resumeGraceUntil = performance.now() + 450;
      setMode('playing');
      stage.focus();
    } catch {
      setStatus('Không thể tiếp tục âm thanh.');
    }
  }
}

function finish(failed = false) {
  activeHolds.clear();
  for (const note of chart) if (note.state === 'pending' || note.state === 'holding') { note.state = 'miss'; award(stats, 'MISS'); }
  elapsed = failed ? time() : duration;
  audio.stopBuffer();
  updateScore();
  const acc = Math.round(stats.weight / stats.judged * 100) || 0;
  const { rank, stars } = calculateRank(acc, failed);
  const { isNewRecord } = failed
    ? { isNewRecord: false }
    : saveRecord(getRecordKey(), { score: stats.score, accuracy: acc, maxCombo: stats.maxCombo, rank, stars });
  $('result-title').textContent = failed ? 'Thất bại!' : 'Hoàn thành';
  $('result-rank').textContent = rank;
  $('result-rank').dataset.rank = rank;
  $('result-stars').textContent = '★'.repeat(stars) + '☆'.repeat(3 - stars);
  $('result-new-record').hidden = !isNewRecord;
  $('result-score').textContent = stats.score.toLocaleString('vi-VN');
  $('result-combo').textContent = `${stats.maxCombo}×`;
  $('result-accuracy').textContent = `${acc}%`;
  setMode('ended');
}

function returnToMenu() {
  audio.stopBuffer();
  resetRound();
  setMode('idle');
  showScreen('menu');
}

async function restartRound() {
  audio.stopBuffer();
  setMode('idle');
  await start();
}

function handleMiss() {
  stats.misses += 1;
  if (mode !== 'playing') return;
  if (stats.misses >= MAX_MISSES) {
    finish(true);
  }
}

function resolve(note, rating) {
  note.state = rating === 'MISS' ? 'miss' : 'hit';
  award(stats, rating);
  activeRenderer().triggerEffect(note.lane, rating);
  feedback = rating;
  feedbackUntil = performance.now() + 650;
  updateScore();
  if (rating === 'MISS') {
    navigator.vibrate?.(35);
    handleMiss();
  }
}

function strike(lane) {
  if (screen !== 'game' || mode !== 'playing') return;
  const t = time();
  if (activeHolds.has(lane)) return;
  const note = findNote(chart, lane, t);
  if (!note) {
    activeRenderer().triggerEffect(lane, 'MISS');
    award(stats, 'MISS');
    feedback = 'Ô TRỐNG';
    feedbackUntil = performance.now() + 400;
    updateScore();
    navigator.vibrate?.(30);
    handleMiss();
    return;
  }
  const rating = judge(t - note.time);
  if (note.hold) {
    note.state = 'holding';
    note.rating = rating;
    activeHolds.set(lane, note);
    activeRenderer().triggerEffect(lane, 'HOLD');
  } else {
    resolve(note, rating);
  }
}

async function handleLocalFile(file) {
  if (!file || ['playing', 'paused', 'waiting', 'preparing'].includes(mode)) return;
  setMode('preparing');
  setStatus(`Đang đọc và phân tích "${file.name}"…`);
  try {
    const bytes = await file.arrayBuffer();
    const decoded = await audio.decode(bytes);
    const analyzed = await analyzeAudioBufferAsync(decoded);
    const title = file.name.replace(/\.[^/.]+$/, '') || file.name;
    localTrack = { ...analyzed, title };
    localBuffer = decoded;
    $('local-title').textContent = title;
    $('local-meta').textContent = `${formatTime(analyzed.duration)} · Đã phân tích`;
    $('local-track-info').hidden = false;
    resetRound();
    setMode('idle');
    setStatus(`Đã sẵn sàng "${title}" (${chart.length} nốt). Bấm Bắt đầu chơi.`);
  } catch (error) {
    localTrack = null;
    localBuffer = null;
    $('local-track-info').hidden = true;
    resetRound();
    setMode('idle');
    setStatus(`Không nạp được tệp nhạc: ${error.message}`);
  }
}

function showPreparation(progress, message) {
  $('analysis-panel').hidden = false;
  $('analysis-progress').value = progress;
  $('analysis-message').textContent = message;
  setStatus(message);
}

async function loadVideo() {
  if (['preparing', 'playing', 'paused', 'waiting'].includes(mode)) return;
  clearTimeout(pasteTimer);
  const id = videoId($('video-url').value);
  if (!id) { setStatus('Dán một link YouTube hợp lệ.'); return; }
  loadedId = id; prepared = null; musicBuffer = null;
  const version = ++prepareVersion;
  prepareAbort?.abort(); prepareAbort = new AbortController();
  setMode('preparing'); resetRound();
  showPreparation(1, 'Đang gửi bài nhạc tới công cụ phân tích…');
  try {
    const { result, buffer } = await prepareTrack(id, {
      signal: prepareAbort.signal,
      onProgress: (p, msg) => { if (version === prepareVersion) showPreparation(p, msg); },
      decodeAudio: bytes => audio.decode(bytes),
    });
    if (version !== prepareVersion) return;
    prepared = result; musicBuffer = buffer; persistSettings();
    $('track-title').textContent = result.title;
    $('original-video').href = `https://www.youtube.com/watch?v=${id}`;
    $('original-video').hidden = false;
    resetRound(); setMode('idle');
    showPreparation(100, `Sẵn sàng · ${chart.length} nốt · ${formatTime(result.duration)}`);
  } catch (error) {
    if (version !== prepareVersion) return;
    prepared = null; musicBuffer = null; setMode('idle');
    showPreparation(0, error.name === 'AbortError' ? 'Đã hủy chuẩn bị.' : `Không chuẩn bị được: ${error.message}`);
  }
}

async function cancelPreparation() {
  const id = loadedId; ++prepareVersion; prepareAbort?.abort();
  await cancelTrackPreparation(id);
  prepared = null; musicBuffer = null; setMode('idle');
  showPreparation(0, 'Đã hủy chuẩn bị. Bạn có thể chọn bài khác.');
}

function selectSource(next) {
  if ((next === 'youtube' && !analysisAvailable) || ['playing', 'paused', 'waiting', 'preparing'].includes(mode)) return;
  clearTimeout(pasteTimer);
  source = next;
  $('local-tab').classList.toggle('selected', next === 'local');
  $('youtube-tab').classList.toggle('selected', next === 'youtube');
  $('local-panel').hidden = next !== 'local';
  $('youtube-panel').hidden = next !== 'youtube';
  resetRound();
  setMode('idle');
  if (next === 'local') setStatus(localTrack ? `Đã nạp "${localTrack.title}".` : 'Chọn tệp nhạc từ thiết bị để tự động tạo bản đồ nốt.');
  else setStatus(prepared ? `Đã sẵn sàng "${prepared.title}".` : 'Dán link YouTube để phân tích trước khi chơi.');
}

function selectDifficulty(next) {
  if (!['normal', 'hard'].includes(next) || ['playing', 'paused', 'waiting', 'preparing'].includes(mode)) return;
  difficulty = normalizeDifficulty(next);
  for (const button of difficultyButtons) button.classList.toggle('selected', button.dataset.difficulty === difficulty);
  persistSettings();
  resetRound();
}

function setScrollSpeed(value) {
  scrollSpeed = clampScrollSpeed(value);
  $('scroll-speed').value = String(scrollSpeed);
  $('speed-value').textContent = `${scrollSpeed.toFixed(1)}×`;
}

function selectRenderMode(next) {
  if (!['2d', '3d'].includes(next) || ['playing', 'paused', 'waiting', 'preparing'].includes(mode)) return;
  renderMode = normalizeRenderMode(next);
  for (const button of renderModeButtons) button.classList.toggle('selected', button.dataset.renderMode === renderMode);
  canvas2d.hidden = renderMode !== '2d';
  canvas3d.hidden = renderMode !== '3d';
  persistSettings();
}

function setAudioOffset(value) {
  audioOffsetMs = clampOffsetMs(value);
  $('audio-offset').value = String(audioOffsetMs);
  $('offset-value').textContent = `${audioOffsetMs > 0 ? '+' : ''}${audioOffsetMs} ms`;
}

function frame() {
  if (screen === 'game') {
    let t = time();
    if (mode === 'playing') {
      const inGrace = performance.now() < resumeGraceUntil;
      for (const [lane, holdNote] of activeHolds) {
        if (mode !== 'playing') break;
        if (t >= holdNote.time + holdNote.hold - .07) { activeHolds.delete(lane); resolve(holdNote, holdNote.rating); }
        else if (!inputs.isLaneHeld(lane) && !inGrace) { activeHolds.delete(lane); resolve(holdNote, 'MISS'); }
      }
      while (mode === 'playing' && nextMissIndex < chart.length && chart[nextMissIndex].time + .19 < t) {
        if (chart[nextMissIndex].state === 'pending') resolve(chart[nextMissIndex], 'MISS');
        nextMissIndex++;
      }
      if (mode === 'playing' && t >= duration) finish();
    }
    activeRenderer().draw({ time: t, mode, chart, isHeld: inputs.isLaneHeld, feedback, feedbackUntil, scrollSpeed });
    $('clock').textContent = `${formatTime(Math.max(0, Math.min(t, duration)))} / ${formatTime(duration)}`;
    $('progress').style.width = `${Math.max(0, Math.min(100, duration ? (t / duration) * 100 : 0))}%`;
  }
  requestAnimationFrame(frame);
}

// Sự kiện điều hướng và nguồn nhạc.
window.addEventListener('blur', () => { if (screen === 'game' && mode === 'playing') togglePause(); inputs.clear(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && screen === 'game' && mode === 'playing') togglePause(); });
$('start').addEventListener('click', start);
$('pause').addEventListener('click', togglePause);
$('resume-btn').addEventListener('click', togglePause);
$('restart-btn').addEventListener('click', restartRound);
$('menu-btn').addEventListener('click', returnToMenu);
$('result-restart-btn').addEventListener('click', restartRound);
$('result-menu-btn').addEventListener('click', returnToMenu);
$('local-tab').addEventListener('click', () => selectSource('local'));
$('youtube-tab').addEventListener('click', () => selectSource('youtube'));
$('load-video').addEventListener('click', loadVideo);
$('cancel-prepare').addEventListener('click', cancelPreparation);
$('audio-offset').addEventListener('input', event => { setAudioOffset(event.target.value); persistSettings(); });
$('scroll-speed').addEventListener('input', event => { setScrollSpeed(event.target.value); persistSettings(); });
for (const button of difficultyButtons) button.addEventListener('click', () => selectDifficulty(button.dataset.difficulty));
for (const button of renderModeButtons) button.addEventListener('click', () => selectRenderMode(button.dataset.renderMode));
$('video-url').addEventListener('input', () => {
  clearTimeout(pasteTimer); prepared = null; musicBuffer = null; loadedId = ''; setMode('idle'); resetRound();
  $('track-title').textContent = ''; $('original-video').hidden = true;
  if (videoId($('video-url').value)) pasteTimer = setTimeout(loadVideo, 900);
});
$('local-file').addEventListener('change', event => { void handleLocalFile(event.target.files?.[0]); });

const dropZone = document.querySelector('.file-drop');
dropZone.addEventListener('dragover', event => { event.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => { dropZone.classList.remove('dragover'); });
dropZone.addEventListener('drop', event => {
  event.preventDefault();
  dropZone.classList.remove('dragover');
  void handleLocalFile(event.dataTransfer?.files?.[0]);
});

// Khôi phục thiết lập và chạy màn hình Loading khởi tạo.
const saved = loadSettings();
$('video-url').value = saved.url;
difficulty = saved.difficulty;
for (const button of difficultyButtons) button.classList.toggle('selected', button.dataset.difficulty === difficulty);
selectRenderMode(saved.renderMode);
setScrollSpeed(saved.scrollSpeed);
setAudioOffset(saved.audioOffsetMs);

async function bootstrap() {
  showScreen('loading');
  $('loading-fill').style.width = '55%';
  $('loading-status').textContent = 'Đang khởi tạo…';
  analysisAvailable = await checkAnalysisSupport();
  $('analysis-unavailable').hidden = analysisAvailable;
  $('youtube-tab').disabled = !analysisAvailable;
  $('loading-fill').style.width = '100%';
  $('loading-status').textContent = 'Sẵn sàng';
  resetRound();
  setMode('idle');
  requestAnimationFrame(frame);
  setTimeout(() => showScreen('menu'), 280);
}

void bootstrap();
