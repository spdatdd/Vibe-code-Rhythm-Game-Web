const DEFAULT_COLORS = ['#007aff', '#af52de', '#ff9500', '#10b981'];

function createParticles(count) {
  return Array.from({ length: count }, (_, i) => ({
    x: ((i % 4) + 0.5) / 4 + (((i * 17) % 10) - 5) * 0.015,
    y: ((i * 53) % 100) / 100,
    vx: (((i % 7) - 3) * 0.012),
    vy: -(0.05 + (i % 5) * 0.02),
    r: 0.015 + (i % 4) * 0.008,
    colorIdx: i % 4,
    phase: i * 0.7,
  }));
}

/** Tính mức năng lượng đồng bộ theo từng cột dựa trên nốt sắp rơi, nốt giữ và cú chạm. */
export function computeLaneEnergy({ chart, time, laneEffects, isHeld, now = performance.now() }) {
  const energy = [0, 0, 0, 0];
  for (let lane = 0; lane < 4; lane++) {
    if (isHeld?.(lane)) energy[lane] = Math.max(energy[lane], 0.45);
    const effect = laneEffects?.get(lane);
    if (effect && effect.rating !== 'MISS') {
      const p = Math.max(0, 1 - (now - effect.started) / 360);
      const boost = effect.rating === 'HOLD' ? 0.85 : 1.0;
      energy[lane] = Math.max(energy[lane], p * boost);
    }
  }
  if (chart) {
    for (let i = 0; i < chart.length; i++) {
      const note = chart[i];
      if (note.state === 'holding') {
        energy[note.lane] = Math.max(energy[note.lane], 0.88);
      } else if (note.state === 'pending') {
        const dt = note.time - time;
        if (dt >= -0.08 && dt <= 0.32) {
          const proximity = 1 - Math.abs(dt) / 0.32;
          energy[note.lane] = Math.max(energy[note.lane], proximity * 0.65);
        } else if (dt > 0.32) {
          break;
        }
      }
    }
  }
  return energy;
}

/** Tạo bộ vẽ trực quan hóa âm thanh Hạt / Beat đồng bộ theo nốt cho cả nền 2D và mặt sân 3D. */
export function createBackgroundVisualizer({ colors = DEFAULT_COLORS } = {}) {
  const particles = createParticles(36);
  const pulseRings = [];
  const prevLaneEnergy = [0, 0, 0, 0];
  let smoothedBass = 0;
  let lastRingAt = 0;
  let lastFrameAt = 0;

  function reset() {
    pulseRings.length = 0;
    prevLaneEnergy.fill(0);
    smoothedBass = 0;
    lastRingAt = 0;
  }

  function drawLaneBeams(ctx, x, y, w, h, laneEnergy) {
    const laneW = w / 4;
    for (let lane = 0; lane < 4; lane++) {
      const e = laneEnergy[lane] || 0;
      if (e <= 0.03) continue;
      const lx = x + lane * laneW;
      const grad = ctx.createLinearGradient(lx, y + h, lx, y);
      grad.addColorStop(0, colors[lane]);
      grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.save();
      ctx.globalAlpha = e * 0.24;
      ctx.fillStyle = grad;
      ctx.fillRect(lx + 1, y, laneW - 2, h);
      ctx.restore();
    }
  }

  function drawParticles(ctx, x, y, w, h, audio, laneEnergy, now, reducedMotion) {
    const dt = lastFrameAt ? Math.min(0.05, (now - lastFrameAt) / 1000) : 0.016;
    const maxLane = Math.max(...laneEnergy);
    const speedBoost = reducedMotion ? 0.35 : 1 + audio.bass * 2.8 + maxLane * 2.2;

    drawLaneBeams(ctx, x, y, w, h, laneEnergy);

    // Tạo vòng xung nhịp trực tiếp tại cột khi có nốt vừa chạm hoặc bass dâng cao.
    for (let lane = 0; lane < 4; lane++) {
      const cur = laneEnergy[lane] || 0;
      const delta = cur - prevLaneEnergy[lane];
      prevLaneEnergy[lane] = cur;
      if (!reducedMotion && delta > 0.35 && cur > 0.55) {
        pulseRings.push({
          cx: (lane + 0.5) / 4,
          cy: 0.92,
          progress: 0,
          color: colors[lane],
        });
      }
    }

    const bassDelta = audio.bass - smoothedBass;
    smoothedBass = smoothedBass * 0.84 + audio.bass * 0.16;
    if (!reducedMotion && bassDelta > 0.08 && audio.bass > 0.3 && now - lastRingAt > 200) {
      lastRingAt = now;
      pulseRings.push({
        cx: 0.5,
        cy: 0.65,
        progress: 0,
        color: colors[pulseRings.length % colors.length],
      });
    }

    ctx.save();
    for (let i = pulseRings.length - 1; i >= 0; i--) {
      const ring = pulseRings[i];
      ring.progress += dt * 1.65;
      if (ring.progress >= 1) {
        pulseRings.splice(i, 1);
        continue;
      }
      ctx.globalAlpha = (1 - ring.progress) * 0.42;
      ctx.strokeStyle = ring.color;
      ctx.lineWidth = Math.max(2, w * 0.008);
      ctx.beginPath();
      ctx.arc(x + ring.cx * w, y + ring.cy * h, (0.05 + ring.progress * 0.36) * Math.min(w, h), 0, Math.PI * 2);
      ctx.stroke();
    }

    const scale = Math.min(w, h);
    for (const p of particles) {
      const laneBoost = laneEnergy[p.colorIdx] || 0;
      p.x += p.vx * dt * speedBoost;
      p.y += p.vy * dt * (speedBoost + laneBoost * 1.5);
      if (p.y < -0.05) p.y = 1.05;
      if (p.x < -0.05) p.x = 1.05;
      if (p.x > 1.05) p.x = -0.05;

      const pulse = 1 + audio.bass * 0.6 + laneBoost * 0.9 + Math.sin(now * 0.003 + p.phase) * 0.15;
      const radius = p.r * scale * pulse;
      ctx.globalAlpha = 0.2 + audio.energy * 0.25 + laneBoost * 0.42;
      ctx.fillStyle = colors[p.colorIdx];
      ctx.beginPath();
      ctx.arc(x + p.x * w, y + p.y * h, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Vẽ hiệu ứng trực quan hóa vào vùng nền (x, y, w, h) phía sau các nốt. */
  function draw(ctx, { x, y, w, h, audio, laneEnergy = [0, 0, 0, 0], now = performance.now(), reducedMotion = false }) {
    if (!audio) {
      lastFrameAt = now;
      return;
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();

    drawParticles(ctx, x, y, w, h, audio, laneEnergy, now, reducedMotion);

    ctx.restore();
    lastFrameAt = now;
  }

  return { draw, reset };
}
