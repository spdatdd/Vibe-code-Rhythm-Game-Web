/** Quản lý Web Audio: đồng hồ đầu ra, phát AudioBuffer và nhạc tổng hợp demo. */
export function createAudioEngine({ onBufferEnded }) {
  let context = null;
  let musicSource = null;
  let activeSounds = [];
  let lastBeat = -1;

  async function ensureRunning() {
    context ||= new AudioContext();
    if (context.state !== 'running') await context.resume();
    return context;
  }

  function currentTime() {
    return context ? context.currentTime : 0;
  }

  /** Lấy mốc thời gian âm thanh thực tế đi ra thiết bị phát hiện tại. */
  function outputClock() {
    if (!context) return 0;
    const stamp = context.getOutputTimestamp?.();
    if (stamp?.contextTime > 0 && stamp.performanceTime > 0) {
      return Math.min(
        context.currentTime,
        stamp.contextTime + Math.max(0, performance.now() - stamp.performanceTime) / 1000,
      );
    }
    return context.currentTime - (context.outputLatency || context.baseLatency || 0);
  }

  async function decode(bytes) {
    const audio = await ensureRunning();
    return audio.decodeAudioData(bytes);
  }

  function stopBuffer() {
    if (!musicSource) return;
    musicSource.onended = null;
    try { musicSource.stop(); } catch {}
    musicSource.disconnect();
    musicSource = null;
  }

  function playBuffer(buffer, position) {
    stopBuffer();
    const delay = .08 + Math.max(0, -position);
    const offset = Math.max(0, position);
    const anchor = context.currentTime + delay - offset;
    musicSource = context.createBufferSource();
    musicSource.buffer = buffer;
    musicSource.connect(context.destination);
    // Hoàn tất lượt khi chính nguồn âm thanh kết thúc, không dựa vào timer JavaScript.
    musicSource.onended = () => onBufferEnded?.();
    musicSource.start(context.currentTime + delay, offset);
    return anchor;
  }

  function tone(frequency, at, length, type, volume) {
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, at);
    gain.gain.setValueAtTime(.001, at);
    gain.gain.exponentialRampToValueAtTime(volume, at + .01);
    gain.gain.exponentialRampToValueAtTime(.001, at + length);
    osc.connect(gain).connect(context.destination);
    osc.start(at);
    osc.stop(at + length);
    activeSounds.push(osc);
    // Gỡ âm đã kết thúc khỏi danh sách để không tích lũy bộ nhớ.
    osc.onended = () => {
      activeSounds = activeSounds.filter(item => item !== osc);
      osc.disconnect();
      gain.disconnect();
    };
  }

  function stopSynth() {
    for (const osc of activeSounds) {
      try { osc.stop(); } catch {}
    }
    activeSounds = [];
  }

  function resetDemoBeat(beat = -1) {
    lastBeat = beat;
  }

  /** Lên lịch vòng nhạc demo bằng đồng hồ âm thanh thay vì bộ đếm JavaScript. */
  function scheduleDemo(t, anchor, demo) {
    const beat = 60 / demo.bpm;
    const phase = demo.offset % beat;
    const target = Math.floor((t - phase + .12) / beat);
    const melody = demo.melody || [261.63, 329.63, 392, 493.88, 440, 392, 329.63, 293.66];
    const bass = demo.bass || [65.4, 82.4];
    while (lastBeat < target) {
      lastBeat++;
      const at = anchor + phase + lastBeat * beat;
      if (at < context.currentTime || phase + lastBeat * beat >= demo.duration) continue;
      tone(lastBeat % 4 === 0 ? bass[0] : bass[1], at, .22, 'triangle', .23);
      tone(melody[lastBeat % melody.length], at, .18, 'sine', .10);
      tone(lastBeat % 2 ? 1800 : 90, at, .05, 'triangle', .07);
    }
  }

  return {
    ensureRunning,
    currentTime,
    outputClock,
    decode,
    playBuffer,
    stopBuffer,
    stopSynth,
    resetDemoBeat,
    scheduleDemo,
  };
}
