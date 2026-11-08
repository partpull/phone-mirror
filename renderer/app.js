const api = window.phoneAPI;

const state = {
  devices: [],
  selected: null,
  running: false,
  runningSerial: null,
  settings: {},
  toolsReady: false,
  scrcpyVersion: '',
  busy: false,
  logs: [],
  hintKey: '',
  hintDismissed: '',
  toastTimer: null,
  pollTimer: null,
};

const $ = (id) => document.getElementById(id);

const PHONE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2.5" width="10" height="19" rx="2.4"></rect><path d="M10.5 18.5h3"></path></svg>';

const STATE_TEXT = {
  device: '在线',
  unauthorized: '未授权',
  offline: '离线',
};

function toast(message, isError) {
  const box = $('toast');
  box.textContent = message;
  box.classList.toggle('error', Boolean(isError));
  box.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => box.classList.remove('show'), 3600);
}

function showHint(text, key) {
  if (!text) return;
  const hintKey = key || text;
  if (state.hintDismissed === hintKey) return;
  state.hintKey = hintKey;
  $('hintText').textContent = text;
  $('hintBox').classList.remove('hidden');
}

function clearHint(key) {
  if (key && state.hintKey !== key) return;
  state.hintKey = '';
  $('hintBox').classList.add('hidden');
  $('hintText').textContent = '';
}

function appendLog(payload) {
  const line = payload && payload.line;
  if (!line) return;
  state.logs.push(line);
  if (state.logs.length > 300) state.logs.shift();
  const box = $('logBox');
  box.textContent = state.logs.join('\n');
  box.scrollTop = box.scrollHeight;
  if (payload.hint) showHint(payload.hint, 'log:' + payload.hint);
}

function setEngineStatus() {
  const chip = $('engineChip');
  chip.classList.toggle('ready', state.toolsReady);
  chip.classList.toggle('error', !state.toolsReady);
  $('engineText').textContent = state.toolsReady
    ? '内核就绪' + (state.scrcpyVersion ? ' · scrcpy ' + state.scrcpyVersion : '')
    : '未找到 scrcpy 内核';
}

function renderDevices() {
  const list = $('deviceList');
  const empty = $('deviceEmpty');
  list.replaceChildren();
  $('deviceCount').textContent = String(state.devices.length);
  empty.classList.toggle('hidden', state.devices.length > 0);

  for (const device of state.devices) {
    const item = document.createElement('div');
    const locked = state.running && device.serial !== state.runningSerial;
    item.className = 'device-item' + (device.serial === state.selected ? ' active' : '') + (locked ? ' locked' : '');
    item.title = locked ? '投屏中，请先停止当前投屏' : device.serial + ' · 双击开始投屏';

    const icon = document.createElement('span');
    icon.className = 'device-icon';
    icon.innerHTML = PHONE_ICON;

    const main = document.createElement('div');
    main.className = 'device-main';

    const name = document.createElement('div');
    name.className = 'device-name';
    name.textContent = device.marketName || device.model || (device.wireless ? '无线设备' : 'Android 设备');

    const meta = document.createElement('div');
    meta.className = 'device-meta';
    const conn = document.createElement('span');
    conn.className = 'tag ' + (device.wireless ? 'wifi' : 'usb');
    conn.textContent = device.wireless ? '无线' : 'USB';
    const serial = document.createElement('span');
    serial.textContent = device.serial + (device.android ? ' · Android ' + device.android : '');
    meta.append(conn, serial);
    main.append(name, meta);

    const badge = document.createElement('span');
    const stateKey = STATE_TEXT[device.state] ? device.state : 'offline';
    badge.className = 'state ' + stateKey;
    badge.textContent = STATE_TEXT[stateKey];

    item.append(icon, main, badge);

    if (!locked) {
      item.addEventListener('click', () => {
        if (state.running && device.serial !== state.runningSerial) return;
        if (state.hintKey !== 'no-tools') clearHint();
        state.hintDismissed = '';
        state.selected = device.serial;
        renderDevices();
        renderSelection();
      });
      item.addEventListener('dblclick', () => {
        if (state.running) return;
        state.selected = device.serial;
        renderDevices();
        renderSelection();
        startMirror();
      });
    }

    list.append(item);
  }
}

function renderSelection() {
  const device = state.devices.find((d) => d.serial === state.selected);
  const nameEl = $('selectedName');
  const metaEl = $('selectedMeta');
  const badge = $('mirrorBadge');

  if (!device) {
    nameEl.textContent = '未选择设备';
    metaEl.textContent = '从左侧列表选择一台设备后开始投屏';
  } else {
    nameEl.textContent = device.marketName || device.model || 'Android 设备';
    const conn = device.wireless ? '无线连接' : 'USB 连接';
    const stateText = STATE_TEXT[device.state] || '离线';
    metaEl.textContent = device.serial + ' · ' + conn + (device.android ? ' · Android ' + device.android : '') + ' · ' + stateText;
    if (device.state === 'unauthorized') {
      showHint('设备未授权：请在手机弹出的「允许 USB 调试吗？」窗口点击允许，并勾选「一律允许」。', 'unauthorized');
    }
  }

  if (!device || device.state !== 'unauthorized') {
    if (state.hintDismissed === 'unauthorized') state.hintDismissed = '';
    if (state.hintKey === 'unauthorized') clearHint('unauthorized');
  }

  const runningHere = state.running && state.runningSerial === state.selected;
  badge.classList.toggle('hidden', !runningHere);

  const canStart = Boolean(device) && device.state === 'device' && !state.running && !state.busy && state.toolsReady;
  $('startBtn').disabled = !canStart;
  $('startBtn').textContent = runningHere ? '投屏中' : '开始投屏';
  $('stopBtn').disabled = !state.running;
  $('usbToWifiBtn').disabled = !device || device.wireless || device.state !== 'device' || state.running;
}

async function refreshDevices(silent) {
  const btn = $('refreshBtn');
  if (!silent) btn.classList.add('spinning');
  try {
    const result = await api.listDevices();
    state.toolsReady = Boolean(result.toolsReady);
    if (result.scrcpyVersion) {
      state.scrcpyVersion = result.scrcpyVersion;
    }
    state.devices = Array.isArray(result.devices) ? result.devices : [];

    const previousSelected = state.selected;
    if (state.selected && !state.devices.some((d) => d.serial === state.selected)) {
      state.selected = null;
    }
    if (!state.selected && state.devices.length) {
      const first = state.devices.find((d) => d.state === 'device') || state.devices[0];
      state.selected = first.serial;
    }
    if (previousSelected !== state.selected) {
      if (state.hintKey !== 'no-tools') clearHint();
      state.hintDismissed = '';
    }
    if (result.error && !silent) toast(result.error, true);
    setEngineStatus();
    renderDevices();
    renderSelection();
  } catch (e) {
    if (!silent) toast('读取设备失败：' + e.message, true);
  } finally {
    if (!silent) setTimeout(() => btn.classList.remove('spinning'), 450);
  }
}

function collectSettings() {
  return {
    maxSize: $('maxSize').value,
    bitrate: $('bitrate').value,
    maxFps: $('maxFps').value,
    audio: $('audio').checked,
    stayAwake: $('stayAwake').checked,
    turnScreenOff: $('turnScreenOff').checked,
    alwaysOnTop: $('alwaysOnTop').checked,
    fullscreen: $('fullscreen').checked,
    lastWirelessIp: state.settings.lastWirelessIp || '',
  };
}

function applySettings(settings) {
  $('maxSize').value = settings.maxSize || '1920';
  $('bitrate').value = settings.bitrate || '8M';
  $('maxFps').value = settings.maxFps || '60';
  $('audio').checked = Boolean(settings.audio);
  $('stayAwake').checked = Boolean(settings.stayAwake);
  $('turnScreenOff').checked = Boolean(settings.turnScreenOff);
  $('alwaysOnTop').checked = Boolean(settings.alwaysOnTop);
  $('fullscreen').checked = Boolean(settings.fullscreen);
  if (settings.lastWirelessIp) $('wifiIp').value = settings.lastWirelessIp;
}

async function saveSettings() {
  state.settings = collectSettings();
  try {
    await api.saveSettings(state.settings);
  } catch (e) {
    // 设置保存失败不打断操作
  }
}

async function startMirror() {
  if (!state.selected || state.running || state.busy) return;
  clearHint();
  state.hintDismissed = '';
  state.busy = true;
  renderSelection();
  try {
    const result = await api.startMirror({ serial: state.selected, options: state.settings });
    if (!result.ok) toast(result.message, true);
    else toast(result.message);
  } catch (e) {
    toast('启动失败：' + e.message, true);
  } finally {
    state.busy = false;
    renderSelection();
  }
}

async function stopMirror() {
  try {
    const result = await api.stopMirror();
    if (!result.ok) toast(result.message, true);
    else toast(result.message);
  } catch (e) {
    toast('停止失败：' + e.message, true);
  }
}

async function connectWireless() {
  const ip = $('wifiIp').value.trim();
  const port = Number($('wifiPort').value.trim() || 5555);
  if (!ip) {
    toast('请输入手机 IP 地址', true);
    return;
  }
  state.settings.lastWirelessIp = ip;
  await saveSettings();
  try {
    const result = await api.connectDevice({ ip, port });
    toast(result.message, !result.ok);
    if (result.ok) await refreshDevices(true);
  } catch (e) {
    toast('连接失败：' + e.message, true);
  }
}

async function pairWireless() {
  const ip = $('wifiIp').value.trim();
  const port = Number($('pairPort').value.trim());
  const code = $('pairCode').value.trim();
  if (!ip) {
    toast('请先填写手机 IP 地址', true);
    return;
  }
  if (!port) {
    toast('请填写手机上显示的配对端口', true);
    return;
  }
  try {
    const result = await api.pairDevice({ ip, port, code });
    toast(result.message, !result.ok);
  } catch (e) {
    toast('配对失败：' + e.message, true);
  }
}

async function enableWifi() {
  if (!state.selected) return;
  const btn = $('usbToWifiBtn');
  btn.disabled = true;
  btn.textContent = '正在切换…';
  try {
    const result = await api.enableWifi(state.selected);
    toast(result.message, !result.ok);
    if (result.ok && result.address) {
      $('wifiIp').value = result.address.split(':')[0];
      state.settings.lastWirelessIp = $('wifiIp').value;
      await saveSettings();
      await refreshDevices(true);
    }
  } catch (e) {
    toast('切换失败：' + e.message, true);
  } finally {
    btn.textContent = 'USB 一键转无线';
    renderSelection();
  }
}

async function init() {
  // 事件先挂载，避免错过启动阶段的日志
  api.onLog(appendLog);
  api.onMirrorState((payload) => {
    state.running = Boolean(payload && payload.running);
    state.runningSerial = payload ? payload.serial : null;
    if (!state.running) {
      state.busy = false;
    } else {
      clearHint();
      state.hintDismissed = '';
    }
    renderDevices();
    renderSelection();
  });

  try {
    const info = await api.getAppInfo();
    document.title = info.title;
    $('versionChip').textContent = 'v' + info.version;
    state.toolsReady = Boolean(info.toolsReady);
    state.scrcpyVersion = info.scrcpyVersion || '';
    setEngineStatus();
    if (!info.toolsReady) {
      showHint('未找到 scrcpy 内核（scrcpy.exe / adb.exe），请重新安装或检查 vendor/scrcpy 目录。', 'no-tools');
    }
  } catch (e) {
    toast('初始化失败：' + e.message, true);
  }

  try {
    state.settings = await api.getSettings();
    applySettings(state.settings);
  } catch (e) {
    state.settings = {};
  }

  document.querySelectorAll('.setting-grid select, .switch-grid input').forEach((el) => {
    el.addEventListener('change', saveSettings);
  });

  $('refreshBtn').addEventListener('click', () => refreshDevices(false));
  $('startBtn').addEventListener('click', startMirror);
  $('stopBtn').addEventListener('click', stopMirror);
  $('clearLogBtn').addEventListener('click', () => {
    state.logs = [];
    $('logBox').textContent = '';
  });
  $('hintCloseBtn').addEventListener('click', () => {
    state.hintDismissed = state.hintKey;
    clearHint();
  });
  $('connectWifiBtn').addEventListener('click', connectWireless);
  $('pairBtn').addEventListener('click', pairWireless);
  $('usbToWifiBtn').addEventListener('click', enableWifi);
  $('wifiIp').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') connectWireless();
  });
  $('pairCode').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') pairWireless();
  });

  try {
    const logs = await api.getLogs();
    logs.forEach((line) => appendLog({ line }));
  } catch (e) {
    // 忽略：日志读取失败不影响主流程
  }

  await refreshDevices(true);
  state.pollTimer = setInterval(() => refreshDevices(true), 5000);
}

window.addEventListener('DOMContentLoaded', init);
