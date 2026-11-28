import { LANE_KEYS, calculateRank, judge, award, findNote, buildAnalyzedChart } from './engine.js';
import {
  loadSettings,
  saveSettings,
  clampOffsetMs,
  clampScrollSpeed,
  normalizeDifficulty,
  renderModeForViewport,
  loadRecords,
  saveRecord,
} from './modules/settings.js';
import { createAudioEngine } from './modules/audio.js';
import { analyzeAudioBufferAsync } from './modules/local-analyzer.js';
import { createRenderer } from './modules/renderer.js';
import { createRenderer2D } from './modules/renderer2d.js';
import { setupInputs } from './modules/input.js';

const $ = id => document.getElementById(id);
const stage = document.querySelector('.stage');
const canvas2d = $('arena-2d');
const canvas3d = $('arena-3d');
const difficultyButtons = [...document.querySelectorAll('[data-difficulty]')];
const colors = ['#007aff', '#af52de', '#ff9500', '#10b981'];
const laneLabels = ['D', 'F', 'J', 'K'];
const activeHolds = new Map();
const MAX_MISSES = 5;
const RESUME_DELAY_MS = 3000;

let difficulty = 'normal', renderMode = '2d', scrollSpeed = 1.0, audioOffsetMs = 0;
let localTrack = null, localBuffer = null;
let screen = 'loading', mode = 'idle', chart = [], duration = 0, stats, anchor = 0, elapsed = 0;
let nextMissIndex = 0, resumeGraceUntil = 0, resumeUntil = 0, skipIntroCountdown = false, feedback = '', feedbackUntil = 0;

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
  onPause: () => { if (screen === 'game' && ['playing', 'paused', 'resuming'].includes(mode)) void togglePause(); },
});

function formatTime(t) { return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`; }
function setStatus(message) { $('menu-status').textContent = message; }
function persistSettings() {
  saveSettings({
    difficulty,
    audioOffsetMs,
    scrollSpeed,
  });
}

function getRecordKey() {
  return `local:${localTrack?.title || 'local'}:${difficulty}`;
}
function time() { return mode === 'playing' ? audio.outputClock() - anchor - audioOffsetMs / 1000 : elapsed; }
function missWindow() { return Math.max(0.22, 0.36 / scrollSpeed); }

/** Chuyển đổi giữa các màn hình: loading, menu và game. */
function showScreen(next) {
  screen = next;
  $('screen-loading').hidden = next !== 'loading';
  $('screen-menu').hidden = next !== 'menu';
  $('screen-game').hidden = next !== 'game';
}

function activePrepared() {
  return localTrack && localBuffer ? { data: localTrack, buffer: localBuffer } : null;
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
  stats = { score: 0, combo: 0, maxCombo: 0, judged: 0, weight: 0, misses: 0, perfect: 0, great: 0, good: 0 };
  elapsed = 0; nextMissIndex = 0; resumeGraceUntil = 0; resumeUntil = 0; skipIntroCountdown = false; feedback = '';
  activeHolds.clear(); inputs.clear(); renderer2d.clearEffects(); renderer3d?.clearEffects();
  $('note-count').textContent = `${chart.length} nốt`;
  $('progress').style.width = '0%';
  updateScore();
}

function setMode(next) {
  mode = next;
  const active = ['playing', 'paused', 'waiting', 'resuming'].includes(mode);
  const preparing = mode === 'preparing';
  for (const button of difficultyButtons) button.disabled = active || preparing;
  $('scroll-speed').disabled = active || preparing;
  $('start').disabled = active || preparing || !activePrepared();
  $('pause-overlay').hidden = mode !== 'paused';
  $('result-overlay').hidden = mode !== 'ended';
}

function updateGameHeader() {
  const diffLabel = { normal: 'THƯỜNG', hard: 'KHÓ' }[difficulty] || 'THƯỜNG';
  $('game-title').textContent = localTrack?.title || 'NHẠC THIẾT BỊ';
  $('game-meta').textContent = `${diffLabel} · ${chart.length} NỐT`;
}

async function start() {
  if (['playing', 'paused', 'waiting', 'resuming', 'preparing'].includes(mode)) return;
  const custom = activePrepared();
  if (!custom) {
    setStatus('Hãy chọn một tệp nhạc từ thiết bị trước khi chơi.');
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
  } else if (mode === 'resuming') {
    resumeUntil = 0;
    inputs.clear();
    $('pause-subtitle').textContent = `${$('game-title').textContent} · ${stats.score.toLocaleString('vi-VN')} điểm`;
    setMode('paused');
  } else if (mode === 'paused') {
    try {
      await audio.ensureRunning();
      if (mode !== 'paused') return;
      const custom = activePrepared();
      if (!custom) return;
      resumeUntil = performance.now() + RESUME_DELAY_MS;
      setMode('resuming');
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
  $('result-perfect').textContent = String(stats.perfect);
  $('result-great').textContent = String(stats.great);
  $('result-good').textContent = String(stats.good);
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
  const lateWindow = missWindow();
  const note = findNote(chart, lane, t, lateWindow);
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
  const rating = judge(t - note.time, lateWindow);
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
  if (!file || ['playing', 'paused', 'waiting', 'resuming', 'preparing'].includes(mode)) return;
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

function selectDifficulty(next) {
  if (!['normal', 'hard'].includes(next) || ['playing', 'paused', 'waiting', 'resuming', 'preparing'].includes(mode)) return;
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

function syncViewportRenderMode() {
  renderMode = renderModeForViewport(window.innerWidth, window.innerHeight);
  canvas2d.hidden = renderMode !== '2d';
  canvas3d.hidden = renderMode !== '3d';
}

function setAudioOffset(value) {
  audioOffsetMs = clampOffsetMs(value);
  $('audio-offset').value = String(audioOffsetMs);
  $('offset-value').textContent = `${audioOffsetMs > 0 ? '+' : ''}${audioOffsetMs} ms`;
}

function frame() {
  if (screen === 'game') {
    const now = performance.now();
    if (mode === 'resuming' && now >= resumeUntil) {
      const custom = activePrepared();
      if (custom) {
        resumeUntil = 0;
        if (elapsed < 0) skipIntroCountdown = true;
        anchor = audio.playBuffer(custom.buffer, elapsed);
        if (activeHolds.size) resumeGraceUntil = now + 450;
        setMode('playing');
        stage.focus();
      } else {
        returnToMenu();
      }
    }
    let t = time();
    if (mode === 'playing') {
      const inGrace = now < resumeGraceUntil;
      for (const [lane, holdNote] of activeHolds) {
        if (mode !== 'playing') break;
        if (t >= holdNote.time + holdNote.hold - .07) {
          activeHolds.delete(lane);
          resolve(holdNote, 'PERFECT');
        } else if (!inputs.isLaneHeld(lane) && !inGrace) {
          activeHolds.delete(lane);
          resolve(holdNote, holdNote.rating === 'PERFECT' ? 'GREAT' : holdNote.rating);
        }
      }
      const missDelay = missWindow();
      while (mode === 'playing' && nextMissIndex < chart.length && chart[nextMissIndex].time + missDelay < t) {
        if (chart[nextMissIndex].state === 'pending') resolve(chart[nextMissIndex], 'MISS');
        nextMissIndex++;
      }
      if (mode === 'playing' && t >= duration) finish();
    }
    let countdown = '';
    if (mode === 'resuming') {
      countdown = String(Math.max(1, Math.min(3, Math.ceil((resumeUntil - now) / 1000))));
    } else if (mode === 'playing' && t < 0 && !skipIntroCountdown) {
      countdown = String(Math.min(2, Math.ceil(-t)));
    }
    const audioData = audio.sampleVisualization();
    activeRenderer().draw({
      time: t,
      mode,
      chart,
      isHeld: inputs.isLaneHeld,
      feedback,
      feedbackUntil,
      scrollSpeed,
      audioData,
      countdown,
    });
    $('clock').textContent = `${formatTime(Math.max(0, Math.min(t, duration)))} / ${formatTime(duration)}`;
    $('progress').style.width = `${Math.max(0, Math.min(100, duration ? (t / duration) * 100 : 0))}%`;
  }
  requestAnimationFrame(frame);
}

// Sự kiện điều hướng và nguồn nhạc.
function pauseOnLeave() {
  if (screen === 'game' && (mode === 'playing' || mode === 'resuming')) void togglePause();
  inputs.clear();
}
window.addEventListener('blur', pauseOnLeave);
window.addEventListener('pagehide', pauseOnLeave);
document.addEventListener('pause', pauseOnLeave);
document.addEventListener('visibilitychange', () => { if (document.hidden) pauseOnLeave(); });
$('start').addEventListener('click', start);
$('pause').addEventListener('click', togglePause);
$('resume-btn').addEventListener('click', togglePause);
$('restart-btn').addEventListener('click', restartRound);
$('menu-btn').addEventListener('click', returnToMenu);
$('result-restart-btn').addEventListener('click', restartRound);
$('result-menu-btn').addEventListener('click', returnToMenu);
$('audio-offset').addEventListener('input', event => { setAudioOffset(event.target.value); persistSettings(); });
$('scroll-speed').addEventListener('input', event => { setScrollSpeed(event.target.value); persistSettings(); });
for (const button of difficultyButtons) button.addEventListener('click', () => selectDifficulty(button.dataset.difficulty));
window.addEventListener('resize', syncViewportRenderMode);
window.addEventListener('orientationchange', syncViewportRenderMode);
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
difficulty = saved.difficulty;
for (const button of difficultyButtons) button.classList.toggle('selected', button.dataset.difficulty === difficulty);
syncViewportRenderMode();
setScrollSpeed(saved.scrollSpeed);
setAudioOffset(saved.audioOffsetMs);

async function bootstrap() {
  showScreen('loading');
  $('loading-fill').style.width = '55%';
  $('loading-status').textContent = 'Đang khởi tạo…';
  $('loading-fill').style.width = '100%';
  $('loading-status').textContent = 'Sẵn sàng';
  resetRound();
  setMode('idle');
  requestAnimationFrame(frame);
  setTimeout(() => showScreen('menu'), 280);
}

void bootstrap();
