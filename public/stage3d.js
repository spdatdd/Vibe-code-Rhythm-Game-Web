import * as THREE from './vendor/three.module.js';

export const LANE_WIDTH = 1.2;
export const RUNWAY_HALF_WIDTH = LANE_WIDTH * 2;
export const SPEED_Z = 10.5;
export const FAR_Z = -24;
export const NEAR_Z = 1.25;
export const PAD_FRONT_Z = 1.05;
export const PAD_BACK_Z = 0.08;
export const PAD_HEIGHT = 0.12;

const FLOOR_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const PAD_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), -PAD_HEIGHT);
const raycaster = new THREE.Raycaster();
const ndcPointer = new THREE.Vector2();
const hitPoint = new THREE.Vector3();

/** Tạo camera phối cảnh Three.js khớp với kích thước khung hình Canvas hiện tại. */
export function createView(width, height) {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const camera = new THREE.PerspectiveCamera(48, safeWidth / safeHeight, 0.1, 80);
  camera.position.set(0, 3.8, 5.4);
  camera.lookAt(0, 0, -4.4);
  camera.updateMatrixWorld(true);
  return { width: safeWidth, height: safeHeight, halfWidth: RUNWAY_HALF_WIDTH, camera };
}

/** Chiếu tọa độ không gian 3D sang tọa độ pixel 2D trên Canvas. */
export function project(view, x, y, z) {
  const projected = new THREE.Vector3(x, y, z).project(view.camera);
  return {
    x: (projected.x + 1) * 0.5 * view.width,
    y: (1 - projected.y) * 0.5 * view.height,
  };
}

/** Giải ngược tia chiếu Three.js để xác định đúng cột khi nhấp hoặc chạm trên sân chơi. */
export function laneAt(view, x, y) {
  ndcPointer.set((x / view.width) * 2 - 1, -(y / view.height) * 2 + 1);
  raycaster.setFromCamera(ndcPointer, view.camera);

  // Ưu tiên mặt trên của bốn phím đệm trước mặt sàn đường băng.
  if (raycaster.ray.intersectPlane(PAD_PLANE, hitPoint)) {
    if (hitPoint.z >= PAD_BACK_Z && hitPoint.z <= PAD_FRONT_Z &&
        hitPoint.x >= -RUNWAY_HALF_WIDTH && hitPoint.x < RUNWAY_HALF_WIDTH) {
      const lane = Math.floor((hitPoint.x + RUNWAY_HALF_WIDTH) / LANE_WIDTH);
      const laneLeft = -RUNWAY_HALF_WIDTH + lane * LANE_WIDTH + 0.08;
      const laneRight = laneLeft + LANE_WIDTH - 0.16;
      if (hitPoint.x >= laneLeft && hitPoint.x <= laneRight) return lane;
    }
  }

  if (raycaster.ray.intersectPlane(FLOOR_PLANE, hitPoint)) {
    if (hitPoint.z >= FAR_Z && hitPoint.z <= NEAR_Z + 0.35 &&
        hitPoint.x >= -RUNWAY_HALF_WIDTH && hitPoint.x < RUNWAY_HALF_WIDTH) {
      return Math.floor((hitPoint.x + RUNWAY_HALF_WIDTH) / LANE_WIDTH);
    }
  }
  return -1;
}
