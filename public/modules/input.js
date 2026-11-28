import { createView, laneAt } from '../stage3d.js';
import { laneAt2D } from './renderer2d.js';

/** Gắn sự kiện bàn phím, chuột và cảm ứng đa điểm vào cùng bộ điều khiển cột cho 2D và 3D. */
export function setupInputs({ stage, laneKeys, getRenderMode, isBlocked, onStrike, onPause }) {
  const keys = new Set();
  const pointers = new Map();

  function clear() {
    keys.clear();
    pointers.clear();
  }

  function isLaneHeld(lane) {
    return keys.has(laneKeys[lane]) || [...pointers.values()].includes(lane);
  }

  stage.addEventListener('pointerdown', event => {
    if (isBlocked() || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const rect = stage.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    const lane = getRenderMode() === '3d'
      ? laneAt(createView(w, h), x, y)
      : laneAt2D(w, h, x, y);
    if (lane < 0) return;
    event.preventDefault();
    stage.focus();
    const alreadyHeld = isLaneHeld(lane);
    pointers.set(event.pointerId, lane);
    stage.setPointerCapture(event.pointerId);
    if (!alreadyHeld) onStrike(lane);
  });

  function releasePointer(event) {
    pointers.delete(event.pointerId);
  }

  stage.addEventListener('pointerup', releasePointer);
  stage.addEventListener('pointercancel', releasePointer);
  stage.addEventListener('lostpointercapture', releasePointer);

  document.addEventListener('keydown', event => {
    if (event.target.closest('input,select,textarea,button')) return;
    if (event.code === 'Escape') {
      event.preventDefault();
      onPause();
      return;
    }
    if (laneKeys.includes(event.code)) {
      event.preventDefault();
      if (event.repeat) return;
      const lane = laneKeys.indexOf(event.code);
      const alreadyHeld = isLaneHeld(lane);
      keys.add(event.code);
      if (!alreadyHeld) onStrike(lane);
    }
  });

  document.addEventListener('keyup', event => {
    keys.delete(event.code);
  });

  // Tắt chọn chữ, menu chuột phải/nhấn giữ và copy/paste trong game (trừ ô nhập link).
  for (const type of ['copy', 'cut', 'paste', 'selectstart', 'contextmenu']) {
    document.addEventListener(type, event => {
      if (!event.target.closest('input, textarea')) {
        event.preventDefault();
      }
    });
  }

  return { clear, isLaneHeld };
}
