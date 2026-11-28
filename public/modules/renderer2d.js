import { createBackgroundVisualizer, computeLaneEnergy } from './visualizer.js';

const PIXELS_PER_SECOND = 460;

/** Tính khung 4 cột Piano Tiles 2D căn giữa theo kích thước màn hình. */
export function getLayout2D(width, height) {
  const boardWidth = Math.min(Math.max(width - 16, 220), 520);
  const left = (width - boardWidth) / 2;
  const laneWidth = boardWidth / 4;
  const padHeight = Math.max(48, Math.round(height * 0.25));
  const noteHeight = padHeight;
  const hitY = Math.max(120, height - padHeight - 22);
  const padTop = hitY + 10;
  return { width, height, left, boardWidth, laneWidth, hitY, padTop, padHeight, noteHeight };
}

/** Xác định cột chạm từ tọa độ 2D trên sân chơi Piano Tiles. */
export function laneAt2D(width, height, x, y) {
  if (y < 0 || y > height) return -1;
  const { left, boardWidth, laneWidth } = getLayout2D(width, height);
  if (x < left || x >= left + boardWidth) return -1;
  return Math.floor((x - left) / laneWidth);
}

/** Dựng bộ vẽ Canvas 2D tối giản, sắc nét theo phong cách Piano Tiles trên iPhone. */
export function createRenderer2D(canvas, { colors, reducedMotion, countdownEl, feedbackEl }) {
  const ctx = canvas.getContext('2d');
  const laneEffects = new Map();
  const visualizer = createBackgroundVisualizer({ colors });

  function triggerEffect(lane, rating = 'PRESS') {
    laneEffects.set(lane, { started: performance.now(), rating });
  }

  function clearEffects() {
    laneEffects.clear();
    visualizer.reset();
  }

  function draw({ time, mode, chart, isHeld, feedback, feedbackUntil, scrollSpeed = 1, audioData = null, countdown }) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w < 1 || h < 1) return;

    const speed = PIXELS_PER_SECOND * scrollSpeed;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(w * dpr);
    const pixelHeight = Math.round(h * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const { left, boardWidth, laneWidth, hitY, padTop, padHeight, noteHeight } = getLayout2D(w, h);
    const now = performance.now();

    // Nền 4 cột đàn sáng; chỉ làm nổi cột đang được nhấn.
    for (let lane = 0; lane < 4; lane++) {
      const x = left + lane * laneWidth;
      const held = isHeld(lane);
      ctx.fillStyle = held ? '#dbeafe' : lane % 2 ? '#ffffff' : '#f4f7fc';
      ctx.fillRect(x, 0, laneWidth, h);

      ctx.fillStyle = '#e2e8f0';
      ctx.fillRect(x, 0, 1, h);
    }
    ctx.fillStyle = '#e2e8f0';
    ctx.fillRect(left + boardWidth - 1, 0, 1, h);

    // Trực quan hóa âm thanh nằm ở lớp nền phía sau các nốt nhạc và đồng bộ theo từng cột.
    const laneEnergy = computeLaneEnergy({ chart, time, laneEffects, isHeld, now });
    visualizer.draw(ctx, {
      x: left,
      y: 0,
      w: boardWidth,
      h: hitY,
      audio: audioData,
      laneEnergy,
      now,
      reducedMotion: reducedMotion.matches,
    });

    const holdingLanes = new Set();

    // Các khối nốt rơi thẳng từ trên xuống vạch đánh.
    for (let i = 0; i < chart.length; i++) {
      const note = chart[i];
      if (note.state !== 'pending' && note.state !== 'holding') continue;
      const isHolding = note.state === 'holding';
      if (isHolding) holdingLanes.add(note.lane);

      const bottomY = isHolding ? hitY : hitY - (note.time - time) * speed;
      const remainingHold = note.hold ? (isHolding ? Math.max(0, note.time + note.hold - time) : note.hold) : 0;
      const holdHeight = remainingHold * speed;
      const topY = (isHolding ? hitY : bottomY - noteHeight) - holdHeight;
      if (bottomY < -20 || topY > h + 20) continue;

      const x = left + note.lane * laneWidth + 3;
      const noteW = laneWidth - 6;
      const color = colors[note.lane];

      if (note.hold && holdHeight > 2) {
        const tailBottomY = isHolding ? padTop + 6 : bottomY - noteHeight + 8;
        if (tailBottomY > topY) {
          ctx.save();
          ctx.globalAlpha = 0.42;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.roundRect(x + noteW * 0.18, topY, noteW * 0.64, tailBottomY - topY, 8);
          ctx.fill();
          ctx.restore();
        }
      }

      if (!isHolding) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(x, bottomY - noteHeight, noteW, noteHeight, 10);
        ctx.fill();
      }
    }

    // Vạch đánh ngang.
    ctx.fillStyle = '#007aff';
    ctx.fillRect(left, hitY - 2, boardWidth, 4);

    // Bốn phím chạm phía dưới vạch đánh.
    for (let lane = 0; lane < 4; lane++) {
      const x = left + lane * laneWidth + 6;
      const padW = laneWidth - 12;
      const held = isHeld(lane);
      const padY = padTop + (held ? 2 : 0);

      ctx.fillStyle = held ? colors[lane] : '#ffffff';
      ctx.strokeStyle = held ? colors[lane] : '#cbd5e1';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(x, padY, padW, padHeight, 12);
      ctx.fill();
      ctx.stroke();

      if (holdingLanes.has(lane)) {
        ctx.save();
        ctx.fillStyle = colors[lane];
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.roundRect(x + 4, padY + 4, padW - 8, padHeight - 8, 9);
        ctx.fill();
        ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }

    // Hiệu ứng gợn sáng khi chạm cột.
    for (const [lane, effect] of laneEffects) {
      const progress = (now - effect.started) / 360;
      if (progress >= 1) { laneEffects.delete(lane); continue; }
      const color = effect.rating === 'MISS' ? '#ff3b30' : colors[lane];
      const x = left + lane * laneWidth;
      ctx.save();
      ctx.globalAlpha = (1 - progress) * 0.32;
      ctx.fillStyle = color;
      ctx.fillRect(x, hitY - 28, laneWidth, 32);
      if (!reducedMotion.matches && !['MISS', 'PRESS'].includes(effect.rating)) {
        ctx.globalAlpha = (1 - progress) * 0.65;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(x + laneWidth / 2, hitY, 12 + progress * 34, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    if (countdownEl) {
      const text = countdown ?? (mode === 'playing' && time < 0 ? String(Math.min(2, Math.ceil(-time))) : '');
      countdownEl.hidden = !text;
      if (text) countdownEl.textContent = text;
    }
    if (feedbackEl) {
      const showFeedback = now < feedbackUntil;
      feedbackEl.hidden = !showFeedback;
      if (showFeedback) {
        feedbackEl.textContent = feedback;
        feedbackEl.dataset.miss = String(['MISS', 'Ô TRỐNG'].includes(feedback));
      }
    }
  }

  return { triggerEffect, clearEffects, draw };
}
