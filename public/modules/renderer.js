import * as THREE from '../vendor/three.module.js';
import {
  createView,
  LANE_WIDTH,
  RUNWAY_HALF_WIDTH,
  SPEED_Z,
  FAR_Z,
  NEAR_Z,
  PAD_FRONT_Z,
  PAD_BACK_Z,
  PAD_HEIGHT,
} from '../stage3d.js';

const GRID_STEP_Z = 3.0;
const NOTE_DEPTH = 1.68;
const NOTE_HEIGHT = 0.32;
const HOLD_HEIGHT = 0.15;
const INITIAL_POOL = 96;

/** Dựng sân chơi 3D bằng Three.js WebGL với object pooling để giữ khung hình mượt. */
export function createRenderer(canvas, { colors, reducedMotion, countdownEl, feedbackEl }) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const initialView = createView(canvas.clientWidth || 800, canvas.clientHeight || 490);
  const camera = initialView.camera;

  // Ánh sáng 3D tông sáng cho sân chơi Piano Tiles.
  scene.add(new THREE.AmbientLight(0xffffff, 1.8));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.15);
  keyLight.position.set(2.5, 10, 5);
  scene.add(keyLight);
  const hitGlowLight = new THREE.PointLight(0x007aff, 1.1, 10, 1.6);
  hitGlowLight.position.set(0, 1.2, 0.2);
  scene.add(hitGlowLight);

  // Mặt sàn đường băng tông sáng theo từng cột.
  const runwayLength = NEAR_Z - FAR_Z;
  const runwayCenterZ = (NEAR_Z + FAR_Z) / 2;
  const laneFloorGeom = new THREE.PlaneGeometry(LANE_WIDTH, runwayLength);
  laneFloorGeom.rotateX(-Math.PI / 2);
  const laneFloorMaterials = [];
  for (let lane = 0; lane < 4; lane++) {
    const mat = new THREE.MeshBasicMaterial({
      color: lane % 2 ? 0xf8fafc : 0xeef3fb,
      transparent: true,
      opacity: 0.96,
    });
    laneFloorMaterials.push(mat);
    const mesh = new THREE.Mesh(laneFloorGeom, mat);
    mesh.position.set(-RUNWAY_HALF_WIDTH + (lane + 0.5) * LANE_WIDTH, 0, runwayCenterZ);
    scene.add(mesh);
  }

  // Đường ray ngăn cách cột mảnh, sắc nét.
  const railGeom = new THREE.BoxGeometry(0.028, 0.012, runwayLength);
  for (let i = 0; i <= 4; i++) {
    const color = i < 4 ? colors[i] : '#10b981';
    const rail = new THREE.Mesh(
      railGeom,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35 }),
    );
    rail.position.set(-RUNWAY_HALF_WIDTH + i * LANE_WIDTH, 0.006, runwayCenterZ);
    scene.add(rail);
  }

  // Các vạch nhịp ngang chạy dọc theo trục Z.
  const gridBars = [];
  const gridCount = Math.ceil(runwayLength / GRID_STEP_Z) + 1;
  const gridGeom = new THREE.BoxGeometry(RUNWAY_HALF_WIDTH * 2, 0.006, 0.03);
  const gridMat = new THREE.MeshBasicMaterial({ color: 0xcbd5e1, transparent: true, opacity: 0.55 });
  for (let i = 0; i < gridCount; i++) {
    const bar = new THREE.Mesh(gridGeom, gridMat);
    bar.position.y = 0.003;
    scene.add(bar);
    gridBars.push(bar);
  }

  // Vạch đánh nổi bật tại z = 0.
  const hitLine = new THREE.Mesh(
    new THREE.BoxGeometry(RUNWAY_HALF_WIDTH * 2 + 0.08, 0.024, 0.09),
    new THREE.MeshBasicMaterial({ color: 0x007aff }),
  );
  hitLine.position.set(0, 0.014, 0);
  scene.add(hitLine);
  const hitAura = new THREE.Mesh(
    new THREE.PlaneGeometry(RUNWAY_HALF_WIDTH * 2 + 0.16, 0.34),
    new THREE.MeshBasicMaterial({ color: 0x007aff, transparent: true, opacity: 0.16 }),
  );
  hitAura.rotation.x = -Math.PI / 2;
  hitAura.position.set(0, 0.009, 0);
  scene.add(hitAura);

  // Bốn phím đệm 3D màu trắng ở cuối đường băng.
  const padWidth = LANE_WIDTH - 0.16;
  const padDepth = PAD_FRONT_Z - PAD_BACK_Z;
  const padCenterZ = (PAD_FRONT_Z + PAD_BACK_Z) / 2;
  const padGeom = new THREE.BoxGeometry(padWidth, PAD_HEIGHT, padDepth);

  const pads = [];
  for (let lane = 0; lane < 4; lane++) {
    const x = -RUNWAY_HALF_WIDTH + (lane + 0.5) * LANE_WIDTH;
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.3,
      metalness: 0.05,
      emissive: new THREE.Color(0x000000),
    });
    const mesh = new THREE.Mesh(padGeom, mat);
    mesh.position.set(x, PAD_HEIGHT / 2, padCenterZ);
    scene.add(mesh);

    const flashMat = new THREE.MeshBasicMaterial({
      color: colors[lane],
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const flashMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(padWidth + 0.06, padDepth + 0.06),
      flashMat,
    );
    flashMesh.rotation.x = -Math.PI / 2;
    flashMesh.position.set(x, PAD_HEIGHT + 0.012, padCenterZ);
    scene.add(flashMesh);

    pads.push({ mesh, mat, flashMat, flashMesh, color: new THREE.Color(colors[lane]) });
  }

  // Pool khối nốt và đuôi nốt giữ để không cấp phát bộ nhớ mỗi khung hình.
  const headGeom = new THREE.BoxGeometry(LANE_WIDTH - 0.08, NOTE_HEIGHT, NOTE_DEPTH);
  const tailGeom = new THREE.BoxGeometry(LANE_WIDTH * 0.58, HOLD_HEIGHT, 1);
  const noteColors = colors.map(c => new THREE.Color(c));
  const headPool = [];
  const tailPool = [];

  function acquireHead(index) {
    while (headPool.length <= index) {
      const mat = new THREE.MeshStandardMaterial({ roughness: 0.28, metalness: 0.15 });
      const mesh = new THREE.Mesh(headGeom, mat);
      mesh.visible = false;
      scene.add(mesh);
      headPool.push(mesh);
    }
    return headPool[index];
  }

  function acquireTail(index) {
    while (tailPool.length <= index) {
      const mat = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.1, transparent: true, opacity: 0.85 });
      const mesh = new THREE.Mesh(tailGeom, mat);
      mesh.visible = false;
      scene.add(mesh);
      tailPool.push(mesh);
    }
    return tailPool[index];
  }

  // Hiệu ứng vòng sáng và hạt 3D khi đánh trúng nốt.
  const laneEffects = new Map();
  const ringGeom = new THREE.RingGeometry(0.28, 0.36, 24);
  ringGeom.rotateX(-Math.PI / 2);
  const sparkGeom = new THREE.BoxGeometry(0.08, 0.08, 0.08);
  const effectMeshes = Array.from({ length: 4 }, (_, lane) => {
    const ringMat = new THREE.MeshBasicMaterial({ color: colors[lane], transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false });
    const ring = new THREE.Mesh(ringGeom, ringMat);
    ring.position.set(-RUNWAY_HALF_WIDTH + (lane + 0.5) * LANE_WIDTH, PAD_HEIGHT + 0.02, padCenterZ);
    ring.visible = false;
    scene.add(ring);

    const sparks = Array.from({ length: 6 }, () => {
      const mat = new THREE.MeshBasicMaterial({ color: colors[lane], transparent: true, opacity: 0, depthWrite: false });
      const mesh = new THREE.Mesh(sparkGeom, mat);
      mesh.visible = false;
      scene.add(mesh);
      return { mesh, mat };
    });
    return { ring, ringMat, sparks };
  });

  // Khởi tạo trước một phần pool để tránh khựng khung hình đầu.
  for (let i = 0; i < INITIAL_POOL; i++) acquireHead(i);

  function triggerEffect(lane, rating = 'PRESS') {
    laneEffects.set(lane, { started: performance.now(), rating });
  }

  function clearEffects() {
    laneEffects.clear();
  }

  function updateEffects(now) {
    for (let lane = 0; lane < 4; lane++) {
      const effect = laneEffects.get(lane);
      const group = effectMeshes[lane];
      const pad = pads[lane];
      if (!effect) {
        pad.flashMat.opacity = 0;
        group.ring.visible = false;
        for (const s of group.sparks) s.mesh.visible = false;
        continue;
      }
      const progress = (now - effect.started) / 420;
      if (progress >= 1) {
        laneEffects.delete(lane);
        pad.flashMat.opacity = 0;
        group.ring.visible = false;
        for (const s of group.sparks) s.mesh.visible = false;
        continue;
      }
      const effectColor = effect.rating === 'MISS' ? 0xff7189 : colors[lane];
      pad.flashMat.color.set(effectColor);
      pad.flashMat.opacity = (1 - progress) * 0.45;

      if (!reducedMotion.matches) {
        group.ring.visible = true;
        group.ringMat.color.set(effectColor);
        group.ringMat.opacity = (1 - progress) * 0.78;
        const ringScale = 0.8 + progress * 1.15;
        group.ring.scale.set(ringScale, 1, ringScale);

        const showSparks = !['MISS', 'PRESS'].includes(effect.rating);
        const centerX = -RUNWAY_HALF_WIDTH + (lane + 0.5) * LANE_WIDTH;
        for (let i = 0; i < group.sparks.length; i++) {
          const spark = group.sparks[i];
          spark.mesh.visible = showSparks;
          if (!showSparks) continue;
          const angle = i * (Math.PI / 5);
          const radius = 0.25 + progress * 0.95;
          spark.mesh.position.set(
            centerX + Math.cos(angle) * radius,
            PAD_HEIGHT + 0.15 + Math.sin(progress * Math.PI) * 0.45,
            padCenterZ - Math.sin(angle) * radius * 0.5,
          );
          spark.mat.color.set(effectColor);
          spark.mat.opacity = (1 - progress) * 0.9;
        }
      } else {
        group.ring.visible = false;
        for (const s of group.sparks) s.mesh.visible = false;
      }
    }
  }

  let lastWidth = 0;
  let lastHeight = 0;
  let lastDpr = 0;

  function draw({ time, mode, chart, isHeld, feedback, feedbackUntil, scrollSpeed = 1 }) {
    const speedZ = SPEED_Z * scrollSpeed;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w < 1 || h < 1) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (w !== lastWidth || h !== lastHeight || dpr !== lastDpr) {
      lastWidth = w;
      lastHeight = h;
      lastDpr = dpr;
      renderer.setPixelRatio(dpr);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }

    for (let lane = 0; lane < 4; lane++) {
      const held = isHeld(lane);
      const mat = laneFloorMaterials[lane];
      mat.color.setHex(held ? 0xdbeafe : lane % 2 ? 0xf8fafc : 0xeef3fb);
      mat.opacity = 0.96;

      const pad = pads[lane];
      const pressOffset = held ? -0.035 : 0;
      pad.mesh.position.y = PAD_HEIGHT / 2 + pressOffset;
      pad.flashMesh.position.y = PAD_HEIGHT + 0.012 + pressOffset;
      if (held) {
        pad.mat.color.copy(pad.color);
        pad.mat.emissive.copy(pad.color).multiplyScalar(0.18);
      } else {
        pad.mat.color.setHex(0xffffff);
        pad.mat.emissive.setHex(0x000000);
      }
    }

    // Di chuyển vạch nhịp dọc theo trục Z theo đồng hồ âm thanh.
    const motion = ((time * speedZ) % GRID_STEP_Z + GRID_STEP_Z) % GRID_STEP_Z;
    for (let i = 0; i < gridBars.length; i++) {
      const z = FAR_Z + motion + i * GRID_STEP_Z;
      gridBars[i].visible = z <= NEAR_Z;
      gridBars[i].position.z = z;
    }

    // Cập nhật vị trí các nốt đang hiển thị trong tầm nhìn camera.
    let usedHeads = 0;
    let usedTails = 0;
    for (let i = 0; i < chart.length; i++) {
      const note = chart[i];
      if (note.state !== 'pending' && note.state !== 'holding') continue;
      const frontZ = note.state === 'holding' ? 0 : -(note.time - time) * speedZ;
      if (frontZ < FAR_Z || frontZ > NEAR_Z + NOTE_DEPTH) continue;

      const isHolding = note.state === 'holding';
      const holdHeadDepth = padDepth - 0.08;
      const laneX = -RUNWAY_HALF_WIDTH + (note.lane + 0.5) * LANE_WIDTH;
      const laneColor = noteColors[note.lane];
      const head = acquireHead(usedHeads++);
      head.visible = true;
      head.scale.set(
        isHolding ? (padWidth - 0.06) / (LANE_WIDTH - 0.08) : 1,
        1,
        isHolding ? holdHeadDepth / NOTE_DEPTH : 1,
      );
      head.position.set(laneX, NOTE_HEIGHT / 2, isHolding ? padCenterZ : frontZ - NOTE_DEPTH / 2);
      head.material.color.copy(laneColor);
      head.material.emissive.copy(laneColor).multiplyScalar(0.28);

      if (note.hold) {
        const tailStartZ = isHolding ? padCenterZ - holdHeadDepth / 2 : frontZ;
        const tailEndZ = Math.max(FAR_Z, -(note.time + note.hold - time) * speedZ);
        const tailLength = tailStartZ - tailEndZ;
        if (tailLength > 0.05) {
          const tail = acquireTail(usedTails++);
          tail.visible = true;
          tail.scale.set(1, 1, tailLength);
          tail.position.set(laneX, HOLD_HEIGHT / 2, tailStartZ - tailLength / 2);
          tail.material.color.copy(laneColor);
          tail.material.emissive.copy(laneColor).multiplyScalar(0.2);
        }
      }
    }
    for (let i = usedHeads; i < headPool.length; i++) headPool[i].visible = false;
    for (let i = usedTails; i < tailPool.length; i++) tailPool[i].visible = false;

    const now = performance.now();
    updateEffects(now);
    renderer.render(scene, camera);

    if (countdownEl) {
      const showCountdown = mode === 'playing' && time < 0;
      countdownEl.hidden = !showCountdown;
      if (showCountdown) countdownEl.textContent = String(Math.min(2, Math.ceil(-time)));
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
