const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile, execFileSync } = require('child_process');
const pkg = require('./package.json');

// 程序名格式：手机投屏vX.X.X By CAIJIAXING（完整版本号，自动跟随 package.json）
const APP_TITLE = '手机投屏v' + pkg.version + ' By CAIJIAXING';
const SETTINGS_FILE = 'settings.json';

const DEFAULT_SETTINGS = {
  maxSize: '1920',
  bitrate: '8M',
  maxFps: '60',
  audio: false,
  stayAwake: true,
  turnScreenOff: false,
  alwaysOnTop: false,
  fullscreen: false,
  lastWirelessIp: '',
};

let mainWindow = null;
let mirrorProc = null;
let mirrorSerial = null;
let mirrorTitle = '';
let scrcpyVersion = '';
let toolsCache = null;
let lastErrorHint = '';
let stoppingPromise = null;
let quitAfterStop = false;
const logBuffer = [];
const deviceMetaCache = new Map();

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function appendLogFile(entry) {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const name = 'mirror-' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '.log';
    fs.appendFileSync(path.join(dir, name), entry + '\r\n', 'utf8');
  } catch (e) {
    // 日志写入失败不影响投屏
  }
}

function pushLog(line) {
  const text = String(line || '').trimEnd();
  if (!text) return '';
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const entry = '[' + time + '] ' + text;
  logBuffer.push(entry);
  if (logBuffer.length > 300) logBuffer.shift();
  appendLogFile(entry);
  const hint = explainError(text);
  if (hint) lastErrorHint = hint;
  sendToRenderer('mirror:log', { line: entry, hint });
  return hint;
}

// 按换行符切分日志，避免 scrcpy 的输出被 Buffer 截断导致错误提示漏判
function attachLogStream(stream, onLine) {
  let buffer = '';
  const handle = (text) => {
    const line = text.replace(/\r$/, '').trimEnd();
    if (!line) return;
    pushLog(line);
    if (onLine) onLine(line);
  };
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      handle(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
    if (buffer.length > 8192) {
      handle(buffer);
      buffer = '';
    }
  });
  stream.on('end', () => {
    if (buffer) handle(buffer);
    buffer = '';
  });
}

// 把 scrcpy / adb 的英文报错翻译成可操作的中文提示
function explainError(text) {
  if (/INJECT_EVENTS/i.test(text)) {
    return '小米手机需要开启「USB 调试（安全设置）」：设置 → 更多设置 → 开发者选项 → 打开该开关后重启手机。';
  }
  if (/unauthorized/i.test(text)) {
    return '手机未授权：请在手机弹出的「允许 USB 调试吗？」窗口中点击允许，并勾选「一律允许」。';
  }
  if (/device offline/i.test(text)) {
    return '设备离线：请重新插拔数据线，或在手机上关闭再打开 USB 调试。';
  }
  if (/Could not find any ADB device|no devices\/emulators found|Could not find any device/i.test(text)) {
    return '未找到设备：请检查数据线是否支持数据传输、手机是否已开启 USB 调试。';
  }
  if (/Connection refused|failed to connect/i.test(text)) {
    return '连接被拒绝：请确认手机与电脑在同一 Wi-Fi，且无线调试端口填写正确。';
  }
  if (/failed to authenticate|wrong password/i.test(text)) {
    return '配对失败：配对码错误或已过期，请在手机「无线调试」页面重新获取。';
  }
  if (/Address already in use/i.test(text)) {
    return 'ADB 端口被占用：请关闭其他手机助手类软件后重试。';
  }
  return '';
}

// 定位 scrcpy 内核目录：打包后在 resources/scrcpy，开发时在 vendor/scrcpy
function resolveScrcpyDir() {
  if (toolsCache) return toolsCache;
  const candidates = [];
  if (app.isPackaged) candidates.push(path.join(process.resourcesPath, 'scrcpy'));
  candidates.push(path.join(__dirname, 'vendor', 'scrcpy'));

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'scrcpy.exe')) && fs.existsSync(path.join(dir, 'adb.exe'))) {
      toolsCache = {
        dir,
        scrcpy: path.join(dir, 'scrcpy.exe'),
        adb: path.join(dir, 'adb.exe'),
      };
      return toolsCache;
    }
  }

  // 兜底：使用系统 PATH 中已安装的 scrcpy / adb
  try {
    const out = execFileSync('where', ['scrcpy.exe'], { encoding: 'utf8', windowsHide: true });
    const exe = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (exe && fs.existsSync(exe)) {
      const dir = path.dirname(exe);
      const adb = fs.existsSync(path.join(dir, 'adb.exe'))
        ? path.join(dir, 'adb.exe')
        : execFileSync('where', ['adb.exe'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      toolsCache = { dir, scrcpy: exe, adb };
      return toolsCache;
    }
  } catch (e) {
    // 忽略：下面统一返回 null
  }
  return null;
}

function childEnv(dir) {
  const env = { ...process.env };
  if (dir) env.PATH = dir + path.delimiter + (env.PATH || '');
  return env;
}

function runAdb(args, options = {}) {
  const tools = resolveScrcpyDir();
  if (!tools) {
    return Promise.resolve({ ok: false, stdout: '', stderr: '', error: '未找到 adb.exe，请确认 scrcpy 内核完整' });
  }
  const fullArgs = options.serial ? ['-s', options.serial, ...args] : args;
  return new Promise((resolve) => {
    execFile(
      tools.adb,
      fullArgs,
      {
        windowsHide: true,
        timeout: options.timeout || 20000,
        maxBuffer: 8 * 1024 * 1024,
        env: childEnv(tools.dir),
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: err ? String(err.message || err) : '',
        });
      }
    );
  });
}

async function readScrcpyVersion() {
  if (scrcpyVersion) return scrcpyVersion;
  const tools = resolveScrcpyDir();
  if (!tools) return '';
  return new Promise((resolve) => {
    execFile(tools.scrcpy, ['--version'], { windowsHide: true, timeout: 10000, env: childEnv(tools.dir) }, (err, stdout, stderr) => {
      const text = String(stdout || stderr || '');
      const m = text.match(/scrcpy\s+([\d.]+)/i);
      scrcpyVersion = m ? m[1] : '';
      resolve(scrcpyVersion);
    });
  });
}

async function listDevices() {
  const result = await runAdb(['devices', '-l']);
  const devices = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith('List of devices') || text.startsWith('*')) continue;
    const parts = text.split(/\s+/);
    const serial = parts[0];
    const state = parts[1] || 'unknown';
    const props = {};
    for (const item of parts.slice(2)) {
      const idx = item.indexOf(':');
      if (idx > 0) props[item.slice(0, idx)] = item.slice(idx + 1);
    }
    devices.push({
      serial,
      state,
      model: (props.model || '').replace(/_/g, ' '),
      device: props.device || '',
      product: props.product || '',
      wireless: /:\d+$/.test(serial),
    });
  }

  // 补全市场名称（如 Xiaomi 15 Pro）和 Android 版本，同一设备只查询一次
  const enriched = await Promise.all(devices.map(async (device) => {
    if (device.state !== 'device') return device;
    const cached = deviceMetaCache.get(device.serial);
    if (cached) return { ...device, ...cached };
    const info = await runAdb(
      ['shell', 'getprop ro.product.marketname; getprop ro.vendor.oplus.market.name; getprop ro.build.version.release'],
      { serial: device.serial, timeout: 6000 }
    );
    // 不能过滤空行：某些机型 marketname 为空，过滤后会把 Android 版本误当成设备名
    const rawLines = info.stdout.split(/\r?\n/).map((s) => s.trim());
    const meta = {
      marketName: rawLines[0] || rawLines[1] || '',
      android: rawLines[2] || '',
    };
    deviceMetaCache.set(device.serial, meta);
    return { ...device, ...meta };
  }));

  return { devices: enriched, error: result.ok ? '' : (result.stderr || result.error || 'adb 执行失败') };
}

function normalizeAddress(ip, port) {
  const value = String(ip || '').trim();
  if (!value) throw new Error('请输入手机 IP 地址');
  if (/:\d+$/.test(value)) return value;
  const p = Number(port || 5555);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('端口号不合法（1-65535）');
  return value + ':' + p;
}

function loadSettings() {
  const file = path.join(app.getPath('userData'), SETTINGS_FILE);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch (e) {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  const file = path.join(app.getPath('userData'), SETTINGS_FILE);
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(merged, null, 2), 'utf8');
  } catch (e) {
    // 设置保存失败不影响投屏
  }
  return merged;
}

// USB 设备开启 tcpip 后，读出手机在 Wi-Fi 下的 IP
async function getDeviceIp(serial) {
  const commands = [
    ['shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0'],
    ['shell', 'ip', 'route'],
  ];
  for (const args of commands) {
    const result = await runAdb(args, { serial, timeout: 8000 });
    const text = result.stdout || '';
    const m = text.match(/inet\s+(\d{1,3}(?:\.\d{1,3}){3})/) || text.match(/src\s+(\d{1,3}(?:\.\d{1,3}){3})/);
    if (m) return m[1];
  }
  return '';
}

function mirrorWindowTitle(device, serial) {
  return '手机投屏 - ' + ((device && (device.marketName || device.model)) || serial);
}

function buildMirrorArgs(serial, device, settings) {
  const title = mirrorWindowTitle(device, serial);
  const args = ['-s', serial, '--window-title=' + title];
  if (settings.maxSize && settings.maxSize !== 'native') args.push('--max-size=' + settings.maxSize);
  if (settings.bitrate) args.push('--video-bit-rate=' + settings.bitrate);
  if (settings.maxFps && settings.maxFps !== 'auto') args.push('--max-fps=' + settings.maxFps);
  if (!settings.audio) args.push('--no-audio');
  if (settings.stayAwake) args.push('--stay-awake');
  if (settings.turnScreenOff) args.push('--turn-screen-off');
  if (settings.alwaysOnTop) args.push('--always-on-top');
  if (settings.fullscreen) args.push('--fullscreen');
  return args;
}

function emitMirrorState() {
  sendToRenderer('mirror:state', {
    running: Boolean(mirrorProc),
    serial: mirrorSerial,
  });
}

// 通过一个轻量辅助程序发送窗口关闭消息；从 Electron 启动 PowerShell 会明显阻塞主进程
function resolveCloseHelper() {
  const candidates = [];
  if (app.isPackaged) candidates.push(path.join(process.resourcesPath, 'tools', 'CloseWindow.exe'));
  candidates.push(path.join(__dirname, 'vendor', 'tools', 'CloseWindow.exe'));
  return candidates.find((file) => fs.existsSync(file)) || '';
}

function requestWindowClose(pid, title) {
  return new Promise((resolve) => {
    const helper = resolveCloseHelper();
    if (!helper) return resolve(false);
    const args = [String(pid)];
    if (title) args.push(title);
    execFile(helper, args, { windowsHide: true, timeout: 3000 }, (err) => {
      resolve(!err);
    });
  });
}

function stopMirror() {
  if (stoppingPromise) return stoppingPromise;
  const proc = mirrorProc;
  if (!proc) return Promise.resolve({ ok: true, message: '当前没有正在运行的投屏' });

  pushLog('正在关闭投屏进程…');
  stoppingPromise = new Promise((resolve) => {
    let finished = false;
    let forceTimer = null;
    let giveUpTimer = null;

    const finish = (message) => {
      if (finished) return;
      finished = true;
      clearTimeout(forceTimer);
      clearTimeout(giveUpTimer);
      stoppingPromise = null;
      resolve({ ok: true, message });
    };

    proc.once('exit', () => finish('已停止投屏'));

    // 先发送 WM_CLOSE，让 scrcpy 自己清理 server 与 adb 转发
    requestWindowClose(proc.pid, mirrorTitle);

    forceTimer = setTimeout(() => {
      if (proc.exitCode === null) {
        pushLog('投屏进程未响应关闭请求，正在强制结束');
        try {
          execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
            windowsHide: true,
            timeout: 6000,
            stdio: 'ignore',
          });
        } catch (e) {
          // 进程可能已退出
        }
      }
    }, 1500);

    giveUpTimer = setTimeout(() => {
      if (mirrorProc === proc) {
        mirrorProc = null;
        mirrorSerial = null;
        mirrorTitle = '';
        emitMirrorState();
      }
      finish('已停止投屏');
    }, 4500);
  });
  return stoppingPromise;
}

async function startMirror(payload) {
  if (mirrorProc) return { ok: false, message: '已有投屏正在运行，请先停止' };
  const serial = payload && payload.serial;
  if (!serial) return { ok: false, message: '请先选择一台设备' };

  const tools = resolveScrcpyDir();
  if (!tools) return { ok: false, message: '未找到 scrcpy 内核，请重新安装程序' };

  const settings = saveSettings(payload.options || {});
  const list = await listDevices();
  const device = list.devices.find((d) => d.serial === serial);
  if (!device) return { ok: false, message: '设备已断开，请刷新设备列表' };
  if (device.state === 'unauthorized') {
    return { ok: false, message: '设备未授权：请在手机弹窗点击「允许 USB 调试」' };
  }

  if (device.wireless) {
    // 无线设备先确保 adb 真的连上，避免 scrcpy 启动后立即退出
    const conn = await runAdb(['connect', serial], { timeout: 10000 });
    const connText = (conn.stdout + '\n' + conn.stderr).trim();
    if (!/connected to|already connected/i.test(connText)) {
      return { ok: false, message: '无线连接失败：' + (connText || '请重新连接手机') };
    }
  }

  const args = buildMirrorArgs(serial, device, settings);
  lastErrorHint = '';
  pushLog('启动：scrcpy ' + args.join(' '));

  let proc;
  try {
    proc = spawn(tools.scrcpy, args, {
      cwd: tools.dir,
      windowsHide: true,
      env: childEnv(tools.dir),
    });
  } catch (e) {
    return { ok: false, message: '启动 scrcpy 失败：' + e.message };
  }

  mirrorProc = proc;
  mirrorSerial = serial;
  mirrorTitle = mirrorWindowTitle(device, serial);

  let startupDone = false;
  let startupTimer = null;
  let resolveStartup = null;
  const startupPromise = new Promise((resolve) => {
    resolveStartup = resolve;
  });
  const settleStartup = (result) => {
    if (startupDone) return;
    startupDone = true;
    if (startupTimer) clearTimeout(startupTimer);
    resolveStartup(result);
  };
  const checkLine = (line) => {
    if (/INFO:\s+Device:|Device:\s+\[/.test(line)) settleStartup({ ok: true });
  };

  attachLogStream(proc.stdout, checkLine);
  attachLogStream(proc.stderr, checkLine);

  proc.once('error', (err) => {
    pushLog('scrcpy 启动失败：' + err.message);
    settleStartup({ ok: false, message: 'scrcpy 启动失败：' + err.message });
    if (mirrorProc === proc) {
      mirrorProc = null;
      mirrorSerial = null;
      mirrorTitle = '';
      emitMirrorState();
    }
  });

  proc.once('exit', (code) => {
    pushLog('投屏进程已退出（代码 ' + code + '）');
    settleStartup({ ok: false, message: lastErrorHint || 'scrcpy 已退出（代码 ' + code + '）' });
    if (mirrorProc === proc) {
      mirrorProc = null;
      mirrorSerial = null;
      mirrorTitle = '';
      emitMirrorState();
    }
  });

  // 正常情况下 scrcpy 会在 1~2 秒内输出 Device 信息；超时则视为已启动，避免慢设备被误判
  startupTimer = setTimeout(() => settleStartup({ ok: true }), 2500);
  const startup = await startupPromise;

  if (!startup.ok) {
    if (proc.exitCode === null) {
      try {
        proc.kill();
      } catch (e) {
        // 进程可能已退出
      }
    }
    if (mirrorProc === proc) {
      mirrorProc = null;
      mirrorSerial = null;
      mirrorTitle = '';
      emitMirrorState();
    }
    return { ok: false, message: startup.message };
  }

  // 极端情况下 scrcpy 在启动确认后立刻退出，此时不能再报告启动成功
  if (proc.exitCode !== null || mirrorProc !== proc) {
    return { ok: false, message: lastErrorHint || 'scrcpy 已退出，请查看运行日志' };
  }

  emitMirrorState();
  return { ok: true, message: '投屏已启动' };
}

function createWindow() {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1180, Math.max(940, workArea.width - 40));
  const height = Math.min(860, Math.max(620, workArea.height - 60));
  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 940,
    minHeight: 620,
    title: APP_TITLE,
    backgroundColor: '#F5F6F8',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
  ipcMain.handle('app:info', async () => {
    const tools = resolveScrcpyDir();
    return {
      title: APP_TITLE,
      version: pkg.version,
      scrcpyVersion: await readScrcpyVersion(),
      toolsReady: Boolean(tools),
      toolsDir: tools ? tools.dir : '',
    };
  });

  ipcMain.handle('devices:list', async () => {
    const result = await listDevices();
    return {
      ...result,
      toolsReady: Boolean(resolveScrcpyDir()),
      scrcpyVersion: await readScrcpyVersion(),
    };
  });

  ipcMain.handle('device:connect', async (event, payload) => {
    try {
      const address = normalizeAddress(payload && payload.ip, payload && payload.port);
      const result = await runAdb(['connect', address]);
      const text = (result.stdout + '\n' + result.stderr).trim();
      const ok = /connected to|already connected/i.test(text);
      return { ok, message: ok ? '已连接 ' + address : (text || '连接失败') };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  ipcMain.handle('device:pair', async (event, payload) => {
    try {
      const ip = String((payload && payload.ip) || '').trim();
      const port = Number(payload && payload.port);
      const code = String((payload && payload.code) || '').trim();
      if (!ip) return { ok: false, message: '请输入手机 IP 地址' };
      if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, message: '配对端口不合法' };
      if (!/^\d{6}$/.test(code)) return { ok: false, message: '配对码应为手机显示的 6 位数字' };
      const result = await runAdb(['pair', ip + ':' + port, code], { timeout: 30000 });
      const text = (result.stdout + '\n' + result.stderr).trim();
      const ok = /Successfully paired/i.test(text);
      return { ok, message: ok ? '配对成功，请再用上方「连接」按钮连接' : (text || '配对失败') };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  ipcMain.handle('device:disconnect', async (event, serial) => {
    if (!serial) return { ok: false, message: '缺少设备标识' };
    const result = await runAdb(['disconnect', serial]);
    const text = (result.stdout + '\n' + result.stderr).trim();
    return { ok: result.ok, message: text || (result.ok ? '已断开' : '断开失败') };
  });

  ipcMain.handle('device:wifi', async (event, serial) => {
    try {
      if (!serial) return { ok: false, message: '请先插好 USB 数据线并选择设备' };
      const ip = await getDeviceIp(serial);
      if (!ip) return { ok: false, message: '未读取到手机 Wi-Fi 地址，请确认手机已连接 Wi-Fi' };
      const tcpip = await runAdb(['tcpip', '5555'], { serial, timeout: 15000 });
      if (!tcpip.ok && !/restarting in TCP mode/i.test(tcpip.stdout + tcpip.stderr)) {
        return { ok: false, message: (tcpip.stderr || tcpip.error || '开启无线调试失败').trim() };
      }
      await new Promise((r) => setTimeout(r, 1500));
      const address = ip + ':5555';
      const result = await runAdb(['connect', address], { timeout: 15000 });
      const text = (result.stdout + '\n' + result.stderr).trim();
      const ok = /connected to|already connected/i.test(text);
      return { ok, message: ok ? '已切换无线：' + address + '，现在可以拔掉数据线' : (text || '无线连接失败'), address };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  ipcMain.handle('mirror:start', (event, payload) => startMirror(payload));
  ipcMain.handle('mirror:stop', () => stopMirror());
  ipcMain.handle('mirror:state', () => ({ running: Boolean(mirrorProc), serial: mirrorSerial }));
  ipcMain.handle('mirror:logs', () => logBuffer.slice());

  ipcMain.handle('settings:get', () => loadSettings());
  ipcMain.handle('settings:save', (event, settings) => saveSettings(settings));

  ipcMain.handle('app:open-log-folder', async () => {
    const dir = app.getPath('userData');
    const error = await require('electron').shell.openPath(dir);
    return { ok: !error, message: error || dir };
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  });
}

app.on('before-quit', (event) => {
  if (!mirrorProc || quitAfterStop) return;
  event.preventDefault();
  quitAfterStop = true;
  stopMirror().finally(() => app.quit());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
