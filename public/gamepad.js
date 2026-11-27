// Gắn bảng cấu hình với tay cầm đầu tiên trình duyệt nhận và giữ thiết lập theo mẫu tay cầm.
export function setupGamepad(panel, laneLabels, onPress) {
  const controls = panel.querySelector('fieldset');
  const buttons = [...panel.querySelectorAll('[data-lane]')];
  const message = panel.querySelector('[role="status"]');
  const clear = panel.querySelector('[data-clear]');
  const cancel = panel.querySelector('[data-cancel]');
  let device = null;
  let bindings = [];
  let pressed = [];
  let targetLane = null;
  let locked = false;
  let supported = typeof navigator.getGamepads === 'function';

  // Tạo khóa lưu trữ theo thiết bị để các mẫu tay cầm không dùng nhầm bản gán.
  function storageKey() {
    return 'orbit-gamepad-v1:' + device.id + ':' + device.mapping;
  }

  // Đọc nút đã lưu và bỏ mục lỗi, trùng lặp hoặc nằm ngoài số nút hiện có.
  function loadBindings(buttonCount) {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(storageKey())); } catch {}
    const used = new Set();
    return laneLabels.map((_, lane) => {
      const button = saved?.[lane];
      if (!Number.isInteger(button) || button < 0 || button >= buttonCount || used.has(button)) return null;
      used.add(button);
      return button;
    });
  }

  // Lưu ngay sau khi đổi nút và báo rõ nếu trình duyệt từ chối lưu.
  function saveBindings() {
    try {
      localStorage.setItem(storageKey(), JSON.stringify(bindings));
      return true;
    } catch {
      return false;
    }
  }

  // Cập nhật nhãn và trạng thái điều khiển theo kết nối, lượt chơi và cột đang gán.
  function render(notice) {
    controls.disabled = locked || !device;
    buttons.forEach((button, lane) => {
      const assigned = bindings[lane];
      button.textContent = `${laneLabels[lane]} · ${assigned == null ? 'Chưa gán' : 'Nút ' + (assigned + 1)}`;
      button.setAttribute('aria-pressed', String(targetLane === lane));
    });
    cancel.hidden = targetLane === null;
    clear.disabled = !bindings.some(button => button != null);
    if (notice) message.textContent = notice;
    else if (!supported) message.textContent = 'Trình duyệt chưa cho phép dùng tay cầm. Hãy mở game trực tiếp qua HTTPS hoặc localhost.';
    else if (!device) message.textContent = 'Kết nối qua USB hoặc Bluetooth rồi bấm một nút để trình duyệt nhận tay cầm.';
    else if (locked) message.textContent = 'Dừng lượt để đổi nút tay cầm.';
    else message.textContent = 'Đã nhận tay cầm. Chọn cột rồi bấm nút muốn gán.';
  }

  // Chọn cột chờ nút mới; các nút đã giữ từ trước sẽ không được ghi nhận.
  buttons.forEach((button, lane) => {
    button.addEventListener('click', () => {
      targetLane = lane;
      render(`Bấm nút trên tay cầm để gán cho cột ${laneLabels[lane]}.`);
    });
  });

  // Thoát chế độ gán và giữ bản gán hiện tại.
  cancel.addEventListener('click', () => {
    targetLane = null;
    render();
  });

  // Bỏ các nút đã gán cho tay cầm hiện tại.
  clear.addEventListener('click', () => {
    bindings = laneLabels.map(() => null);
    targetLane = null;
    render(saveBindings() ? 'Đã xóa cấu hình tay cầm này.' : 'Đã xóa cấu hình trong phiên hiện tại.');
  });

  // Đọc trạng thái mỗi khung hình và chỉ phát lệnh khi một nút vừa được nhấn.
  function poll() {
    if (!supported) return;
    let pads;
    try { pads = [...navigator.getGamepads()].filter(pad => pad?.connected); }
    catch {
      supported = false;
      device = null;
      bindings = [];
      pressed = [];
      targetLane = null;
      render();
      return;
    }
    const pad = pads.find(item => item.index === device?.index && item.id === device.id) || pads[0];
    if (pad?.index !== device?.index || pad?.id !== device?.id) {
      device = pad || null;
      bindings = pad ? loadBindings(pad.buttons.length) : [];
      pressed = pad ? Array.from(pad.buttons, button => button.pressed) : [];
      targetLane = null;
      render();
      return;
    }
    if (!pad) return;

    const before = pressed;
    pressed = Array.from(pad.buttons, button => button.pressed);
    if (targetLane !== null) {
      const button = pressed.findIndex((down, index) => down && !before[index]);
      if (button < 0) return;
      const lane = targetLane;
      const previousLane = bindings.indexOf(button);
      if (previousLane !== -1) bindings[previousLane] = bindings[lane];
      bindings[lane] = button;
      targetLane = null;
      let notice = `Đã gán nút ${button + 1} cho cột ${laneLabels[lane]}.`;
      if (previousLane !== -1 && previousLane !== lane) {
        notice += bindings[previousLane] == null
          ? ` Cột ${laneLabels[previousLane]} chưa được gán nút.`
          : ` Cột ${laneLabels[previousLane]} chuyển sang nút ${bindings[previousLane] + 1}.`;
      }
      render(saveBindings() ? notice : notice + ' Trình duyệt chỉ giữ cấu hình trong phiên này.');
      return;
    }
    for (const [lane, button] of bindings.entries()) {
      if (button != null && pressed[button] && !before[button]) onPress(lane);
    }
  }

  // Cho vòng chơi kiểm tra nốt dài khi nút tay cầm vẫn được giữ.
  function isHeld(lane) {
    return bindings[lane] != null && Boolean(pressed[bindings[lane]]);
  }

  // Khóa cấu hình khi bắt đầu lượt và hủy yêu cầu gán đang chờ.
  function setLocked(value) {
    if (locked === value) return;
    locked = value;
    if (locked) targetLane = null;
    render();
  }

  render();
  return { poll, isHeld, setLocked };
}
