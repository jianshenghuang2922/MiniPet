'use strict';

/**
 * MiniPet —— 桌面宠物主进程
 *
 * 架构说明 (重要):
 *   早期版本用的是"一个小窗口在桌面上不停 setPosition"的做法, 在 Windows 上
 *   透明窗口每移动一次就要重新合成一次, 会明显闪烁。现在改成:
 *
 *     - 一个覆盖整个工作区、位置永不改变的透明窗口
 *     - 窗口里放一块只有虫子那么大的 canvas, 用 CSS transform 移动它
 *
 *   窗口不动 -> 不会闪烁; transform 走 GPU 合成 -> 移动丝滑。
 *   副作用是物理模拟和拖拽全部可以放在渲染进程里做, 没有 IPC 延迟。
 *
 *   主进程只负责: 窗口 / 托盘 / 右键菜单 / 配置读写。
 */

const { app, BrowserWindow, ipcMain, Menu, Tray, screen, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const META_PATH = path.join(ROOT, 'assets', 'pet.json');

const DEFAULT_CONFIG = {
  petWidth: 150,        // 虫子显示宽度 (px)
  speed: 55,            // 爬行速度 (px/s)
  wander: true,         // 是否自动随机漫步
  alwaysOnTop: true,    // 始终置顶
  shadow: true,         // 投影, 保证浅色壁纸上也看得清
  shadowBlur: 12,
  clickThrough: true,   // 只有虫子实体区域接收鼠标, 其余区域穿透
  focusable: false,     // 点虫子不抢走当前应用的焦点
  idleMin: 2.0,         // 发呆时长下限 (秒)
  idleMax: 7.0,         // 发呆时长上限 (秒)
  opacity: 1,
  autoStart: false,     // 开机自启动
  remindAt: null,       // 定时提醒的触发时刻 (epoch ms), null = 未设置
  remindText: '时间到了！', // 到点时虫子在头顶喊出来的那句话
  // 显卡驱动有问题 / Chromium 沙箱起不来时可以打开, 强制走软件渲染
  disableGpu: false
};

// ---------------------------------------------------------------- 崩溃自愈

/**
 * 有些机器上 Chromium 的 GPU 进程在沙箱里会直接崩 (exit_code 0xC0000005),
 * 然后整个应用 FATAL: "GPU process isn't usable. Goodbye." —— 用户只会看到
 * 什么都没发生。
 *
 * 这里只负责"发现异常并让位": 以 99 退出, 由 tools/launch.js 带 --no-sandbox
 * 重新拉起一次。不在应用内 app.relaunch 是因为新进程会和旧进程的单实例锁抢时序,
 * 结果是被顶掉、什么都不剩。
 */
const CRASH_EXIT_CODE = 99;
const NOSANDBOX_FLAG = '--minipet-nosandbox';
const alreadyFellBack = process.argv.includes(NOSANDBOX_FLAG);
let crashing = false;

// 定时提醒预设。第一个是 10 秒 —— 用户要的快速档, 点完就能盯着看气泡,
// 不用等 5 分钟。菜单和控制选项共用同一份清单。
const REMIND_PRESETS = [
  { label: '10 秒后', ms: 10 * 1000 },
  { label: '5 分钟后', ms: 5 * 60000 },
  { label: '15 分钟后', ms: 15 * 60000 },
  { label: '25 分钟后', ms: 25 * 60000 },
  { label: '45 分钟后', ms: 45 * 60000 },
  { label: '1 小时后', ms: 60 * 60000 }
];

function crashExit(reason) {
  if (crashing || alreadyFellBack) return;
  crashing = true;
  console.error('[MiniPet] ' + reason + '，交给启动器重试');
  app.exit(CRASH_EXIT_CODE);
}

app.on('child-process-gone', (_e, details) => {
  if (details.type === 'GPU' && details.reason !== 'clean-exit') {
    crashExit('GPU 进程异常退出');
  }
});

app.on('render-process-gone', (_e, _wc, details) => {
  if (details.reason !== 'clean-exit') crashExit('渲染进程崩溃');
});

// ---------------------------------------------------------------- 配置

function loadConfig() {
  const cfg = Object.assign({}, DEFAULT_CONFIG);
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      Object.assign(cfg, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
    } else {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
    }
  } catch (err) {
    console.error('读取 config.json 失败, 使用默认配置:', err.message);
  }
  return cfg;
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (err) {
    console.error('写入 config.json 失败:', err.message);
  }
}

let cfg = loadConfig();
if (cfg.disableGpu) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
}

let win = null;
let panel = null;
let tray = null;
let paused = false;
let meta = { frameWidth: 480, frameHeight: 211, columns: 6, rows: 5, frameCount: 30, fps: 30 };

// ---------------------------------------------------------------- 工具

function readMeta() {
  try {
    Object.assign(meta, JSON.parse(fs.readFileSync(META_PATH, 'utf8')));
  } catch (err) {
    console.error('读取 assets/pet.json 失败, 使用默认值:', err.message);
  }
  return meta;
}

function primaryWorkArea() {
  return screen.getPrimaryDisplay().workArea;
}

// 命令队列。渲染进程还没起来时 webContents.send 会被静默丢掉 —— 定时提醒
// 恰好会在开机后 1 秒内触发, 窗口八成还没加载完, 所以先攒着, 等 sendEnv 时补发。
const pendingCmds = [];

function sendCmd(type, extra) {
  if (!win || win.isDestroyed()) return;
  const msg = Object.assign({ type }, extra || {});
  if (win.webContents.isLoading()) { pendingCmds.push(msg); return; }
  win.webContents.send('pet:cmd', msg);
}

function flushCmds() {
  if (!win || win.isDestroyed()) return;
  while (pendingCmds.length) win.webContents.send('pet:cmd', pendingCmds.shift());
}

function sendEnv() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('pet:env', Object.assign({ meta }, cfg));
  flushCmds();
}

function syncPanel() {
  if (!panel || panel.isDestroyed()) return;
  panel.webContents.send('panel:sync', { cfg, meta, paused });
}

// ---------------------------------------------------------------- 配置写入

// 控制台和右键菜单都走这里, 保证两边的数值永远一致
const RANGE = {
  petWidth: [60, 480],
  speed: [0, 400],
  opacity: [0.2, 1],
  shadowBlur: [0, 40],
  idleMin: [0, 20],
  idleMax: [0, 30]
};
const BOOLEANS = ['wander', 'shadow', 'alwaysOnTop', 'clickThrough', 'autoStart'];

/**
 * 开机自启动。走 Electron 官方的 setLoginItemSettings —— Windows 上它写的
 * 就是 HKCU\Software\Microsoft\Windows\CurrentVersion\Run 这个键。
 *
 * 注意开发态: process.execPath 是 electron.exe, 不带项目根目录的话开机只会
 * 拉起一个空壳, 所以在未打包时把根目录显式塞回去。打包版不需要, 反而可能是
 * 多余的参数, 所以用 isPackaged 分开处理。
 */
function setAutoStart(on) {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!on,
      args: on && !app.isPackaged ? [__dirname] : []
    });
  } catch (err) {
    console.error('设置开机自启动失败:', err.message);
  }
}

// ---------------------------------------------------------------- 定时提醒

/**
 * 提醒的触发时刻存在 config 里(绝对时间戳), 而不是存"还剩多少秒"。
 * 这样中途崩溃重启、甚至关机再开, 时间都还对得上 —— 存相对秒数的话,
 * 每次重启都会偷偷把截止时间往后推。
 */
let remindTimer = null;

/**
 * 菜单/托盘里只显示**绝对触发时刻**, 不显示"还剩多少秒"。
 *
 * Windows 的原生菜单打开之后就是一张快照: 托盘菜单是资源管理器弹的,
 * 右键菜单是 popup 出来的原生窗口, 都没有任何办法在开着的时候往里刷标签。
 * "剩余 X 分 XX 秒"这种会跳字的文案放进去, 用户盯着它一秒秒不动, 只会
 * 觉得坏了。绝对时刻是永不过期的正确答案, 要看实时倒计时去控制选项。
 */
function fmtRemindAt(at) {
  const d = new Date(at);
  const now = new Date();
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return '今天 ' + hm;
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (d.getFullYear() === tomorrow.getFullYear() &&
      d.getMonth() === tomorrow.getMonth() &&
      d.getDate() === tomorrow.getDate()) return '明天 ' + hm;
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
}

function fireRemind() {
  const text = cfg.remindText || '时间到了！';
  cfg.remindAt = null;
  saveConfig();
  // 提醒要比闲聊的台词挂得久一些, 不然一晃就没了
  sendCmd('say', { text: text, holdMs: 8000 });
  refreshTray();
  syncPanel();
}

function startRemindTimer() {
  if (remindTimer) clearInterval(remindTimer);
  remindTimer = setInterval(() => {
    if (!cfg.remindAt) return;
    if (Date.now() >= cfg.remindAt) { fireRemind(); return; }
    // 不再每秒重建菜单: 菜单标签是绝对触发时刻, 打开后本来也不需要动;
    // 每秒 setContextMenu 纯属浪费, 菜单开着的时候重建还可能捣乱。
    // 状态变化(设置/取消/触发)各自都会调 refreshTray, 菜单不会过期。
  }, 1000);
}

function clampCfg(cfgObj) {
  for (const k of Object.keys(RANGE)) {
    const n = Number(cfgObj[k]);
    if (!isFinite(n)) continue;
    cfgObj[k] = Math.min(RANGE[k][1], Math.max(RANGE[k][0], n));
  }
  if (cfgObj.idleMax < cfgObj.idleMin) cfgObj.idleMax = cfgObj.idleMin;
}

/**
 * 应用一批配置改动。
 * @param {object} patch  只包含要改的键
 * @param {'panel'|'menu'|'system'} source  改动来源, 用来决定要不要回推给控制台
 */
function applyConfig(patch, source) {
  if (!patch || typeof patch !== 'object') return;

  const before = {
    alwaysOnTop: cfg.alwaysOnTop,
    clickThrough: cfg.clickThrough,
    autoStart: cfg.autoStart
  };

  let touched = false;
  for (const k of Object.keys(patch)) {
    if (!(k in DEFAULT_CONFIG)) continue;         // 白名单, 防止写入奇怪的东西
    if (k === 'disableGpu' || k === 'focusable') continue;  // 这两个要重启才生效
    const v = BOOLEANS.includes(k) ? !!patch[k] : patch[k];
    if (cfg[k] === v) continue;
    cfg[k] = v;
    touched = true;
  }
  if (!touched) {
    if (source !== 'panel') syncPanel();
    return;
  }

  clampCfg(cfg);

  // 需要立刻作用到窗口上的两项
  if (win && !win.isDestroyed()) {
    if (before.alwaysOnTop !== cfg.alwaysOnTop) {
      win.setAlwaysOnTop(cfg.alwaysOnTop !== false, 'screen-saver');
    }
    if (before.clickThrough !== cfg.clickThrough) {
      win.setIgnoreMouseEvents(cfg.clickThrough !== false, { forward: true });
      sendCmd('click-through-changed', { value: cfg.clickThrough !== false });
    }
  }

  // 自启动不进窗口, 直接动系统登录项
  if (before.autoStart !== cfg.autoStart) {
    setAutoStart(cfg.autoStart !== false);
  }

  saveConfig();
  sendEnv();
  refreshTray();
  if (source !== 'panel') syncPanel();
}

function runAction(action) {
  switch (action) {
    case 'recenter':
      sendCmd('recenter');
      break;
    case 'togglePause':
      paused = !paused;
      sendCmd(paused ? 'pause' : 'resume');
      syncPanel();
      refreshTray();
      break;
    case 'toggleVisible':
      if (!win || win.isDestroyed()) break;
      if (win.isVisible()) {
        win.hide();
      } else {
        win.showInactive();
        if (cfg.clickThrough !== false) win.setIgnoreMouseEvents(true, { forward: true });
        sendEnv();
      }
      refreshTray();   // 菜单里"隐藏它/显示它"的标签要跟着变
      break;
    case 'reset': {
      // 这两个要重启才生效, 恢复默认时不该被抹掉
      const keep = { disableGpu: cfg.disableGpu, focusable: cfg.focusable };
      Object.assign(cfg, DEFAULT_CONFIG, keep);
      // autoStart 默认 false, 得顺手把系统登录项也撤掉, 否则配置和系统对不上
      setAutoStart(cfg.autoStart === true);
      if (win && !win.isDestroyed()) {
        win.setAlwaysOnTop(cfg.alwaysOnTop !== false, 'screen-saver');
        win.setIgnoreMouseEvents(cfg.clickThrough !== false, { forward: true });
        sendCmd('click-through-changed', { value: cfg.clickThrough !== false });
      }
      saveConfig();
      sendEnv();
      syncPanel();
      refreshTray();
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------- 控制台窗口

function openPanel() {
  if (panel && !panel.isDestroyed()) {
    panel.show();
    panel.focus();
    syncPanel();
    return;
  }

  // 内容实测要 1165px 才完全不滚, 但工作区只有 1019 —— 所以 body 仍会滚一点。
  // 这里尽量给高(留 40px 余量), 滚动条交给 .body 自己扛, 底部按钮是 flex:none 永远看得见。
  const wa = primaryWorkArea();
  const panelH = Math.min(950, Math.max(480, wa.height - 40));
  const panelW = 420;

  panel = new BrowserWindow({
    width: panelW,
    height: panelH,
    minWidth: 380,
    minHeight: 420,
    frame: false,
    transparent: false,
    backgroundColor: '#f5f3ee',
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    title: 'MiniPet 控制选项',
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  // 显式居中。不给 x/y 时 Electron 会自己居中, 但被夹高/夹矮后最好再算一次, 免得贴边
  panel.setBounds({
    x: Math.round(wa.x + (wa.width - panelW) / 2),
    y: Math.round(wa.y + (wa.height - panelH) / 2),
    width: panelW,
    height: panelH
  });

  panel.setMenu(null);
  panel.loadFile(path.join(ROOT, 'renderer', 'panel.html'));
  panel.once('ready-to-show', () => { panel.show(); panel.focus(); });
  panel.on('closed', () => { panel = null; });
}

// ---------------------------------------------------------------- 窗口

function createWindow() {
  const wa = primaryWorkArea();

  win = new BrowserWindow({
    x: wa.x,
    y: wa.y,
    width: wa.width,
    height: wa.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: cfg.focusable !== false,
    alwaysOnTop: cfg.alwaysOnTop !== false,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  win.setAlwaysOnTop(cfg.alwaysOnTop !== false, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(ROOT, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    win.showInactive();
    // 整个窗口默认鼠标穿透, 只有光标压在虫子身上时才接管
    if (cfg.clickThrough !== false) win.setIgnoreMouseEvents(true, { forward: true });
    sendEnv();
  });

  win.webContents.on('did-finish-load', sendEnv);
  win.on('closed', () => { win = null; });
}

function fitToWorkArea() {
  if (!win || win.isDestroyed()) return;
  const wa = primaryWorkArea();
  win.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: wa.height });
  sendEnv();
}

// ---------------------------------------------------------------- 菜单

function buildMenuTemplate() {
  // 面板滑杆的 5 档大小和这里保持一致, 免得右键菜单和控制窗口给出同样的值却显示不同的名字
  const sizeLabel = (w) => (w <= 100 ? '很小' : w <= 150 ? '小' : w <= 220 ? '中' : w <= 440 ? '大' : '巨大');
  const SIZES = [90, 150, 220, 320, 440];
  const SPEEDS = [
    { label: '慢吞吞', v: 22 },
    { label: '正常', v: 55 },
    { label: '挺快', v: 110 },
    { label: '起飞', v: 220 }
  ];
  return [
    { label: '打开控制选项…', click: openPanel },
    {
      label: paused ? '继续活动' : '虫子暂时停止',
      click: () => runAction('togglePause')
    },
    { type: 'separator' },
    ...(cfg.remindAt && cfg.remindAt > Date.now()
      ? [{ label: '⏱ ' + fmtRemindAt(cfg.remindAt) + ' 触发', enabled: false }, { type: 'separator' }]
      : []),
    {
      label: '大小',
      submenu: SIZES.map((w) => ({
        label: sizeLabel(w) + '（' + w + ' px）',
        type: 'radio',
        checked: cfg.petWidth === w,
        click: () => applyConfig({ petWidth: w }, 'menu')
      }))
    },
    {
      label: '速度',
      submenu: SPEEDS.map((o) => ({
        label: o.label + '（' + o.v + ' px/s）',
        type: 'radio',
        checked: cfg.speed === o.v,
        click: () => applyConfig({ speed: o.v }, 'menu')
      }))
    },
    {
      label: '不透明度',
      submenu: [0.2, 0.4, 0.6, 0.8, 1].map((v) => ({
        label: Math.round(v * 100) + '%',
        type: 'radio',
        checked: Math.abs((cfg.opacity == null ? 1 : cfg.opacity) - v) < 0.01,
        click: () => applyConfig({ opacity: v }, 'menu')
      }))
    },
    { type: 'separator' },
    {
      label: '开机自启动',
      type: 'checkbox',
      checked: cfg.autoStart === true,
      click: (item) => applyConfig({ autoStart: item.checked }, 'menu')
    },
    {
      // 互动栏的定时提醒: 和控制选项里同一套预设。第一个是 10 秒, 专门用来
      // 快速验证"到点冒气泡"整条链路; 提醒语沿用控制选项里设的那句。
      label: '定时提醒',
      submenu: [
        ...REMIND_PRESETS.map((p) => ({
          label: p.label,
          click: () => applyConfig({
            remindAt: Date.now() + p.ms,
            remindText: cfg.remindText || '时间到了！'
          }, 'menu')
        })),
        ...(cfg.remindAt && cfg.remindAt > Date.now()
          ? [
              { type: 'separator' },
              { label: '取消提醒', click: () => applyConfig({ remindAt: null }, 'menu') }
            ]
          : [])
      ]
    },
    { type: 'separator' },
    {
      label: '自动漫步',
      type: 'checkbox',
      checked: cfg.wander !== false,
      click: (item) => applyConfig({ wander: item.checked }, 'menu')
    },
    {
      label: '投影',
      type: 'checkbox',
      checked: cfg.shadow !== false,
      click: (item) => applyConfig({ shadow: item.checked }, 'menu')
    },
    {
      label: '始终置顶',
      type: 'checkbox',
      checked: cfg.alwaysOnTop !== false,
      click: (item) => applyConfig({ alwaysOnTop: item.checked }, 'menu')
    },
    {
      label: '空白处鼠标穿透',
      type: 'checkbox',
      checked: cfg.clickThrough !== false,
      click: (item) => applyConfig({ clickThrough: item.checked }, 'menu')
    },
    { type: 'separator' },
    { label: '叫它回到屏幕中间', click: () => runAction('recenter') },
    { label: win && win.isVisible() ? '隐藏它' : '显示它', click: () => runAction('toggleVisible') },
    { label: '打开配置文件', click: () => shell.openPath(CONFIG_PATH) },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } }
  ];
}

function popupMenu() {
  if (!win || win.isDestroyed()) return;
  // 菜单开着期间临时关掉鼠标穿透 —— 这是"点哪儿都能关菜单"的关键。
  // 背景: 虫窗除了虫身那一小块, 其余全是鼠标穿透的。点在菜单以外的地方,
  // 点击会被"转发"给下面的窗口, 菜单的模态循环根本收不到这次点击, 于是
  // 菜单永远不关, 用户只能点回虫身(唯一把点击交给本窗口的区域)才关得掉。
  // 整块窗口都收点击之后, 点在菜单外的点击才会被模态循环当成"取消"。
  // 菜单项照样点得动: popup 的 window 参数让菜单成为本窗口的 owned 窗口,
  // owned 窗口在 z 序上恒在 owner 之上, 菜单区域里的点击先命中菜单自己。
  // 副作用(可接受): 菜单开着的时候点击不会穿透到别的应用 —— 这正是模态菜单
  // 该有的行为, 和系统里任何右键菜单一样。
  const restoreThrough = cfg.clickThrough !== false;
  if (restoreThrough) win.setIgnoreMouseEvents(false);

  const finish = () => {
    if (restoreThrough && win && !win.isDestroyed()) {
      win.setIgnoreMouseEvents(true, { forward: true });
      // 渲染进程缓存了 ignoring/hovering, 这条命令让它重新对齐
      sendCmd('click-through-changed', { value: true });
    }
  };

  try {
    Menu.buildFromTemplate(buildMenuTemplate()).popup({
      window: win,
      callback: finish   // 菜单关闭时恢复穿透(sync / async 两种模式都走这里)
    });
  } catch (err) {
    console.error('弹出右键菜单失败:', err.message);
    finish();   // 别把窗口留在不穿透的状态
  }
}

/** 配置变了以后刷新托盘菜单, 让勾选状态跟着走 */
function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  // 悬停托盘图标就能看到提醒状态, 不用开菜单 —— 工具提示是可以实时刷新的
  const active = cfg.remindAt && cfg.remindAt > Date.now();
  tray.setToolTip('MiniPet —— 一只在桌面上蠕动的小虫子' +
    (active ? '，⏱ ' + fmtRemindAt(cfg.remindAt) + ' 触发' : ''));
  tray.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate()));
}

function createTray() {
  const iconPath = path.join(ROOT, 'assets', 'tray.png');
  let img = nativeImage.createFromPath(iconPath);
  if (img.isEmpty()) img = nativeImage.createEmpty();
  tray = new Tray(img.resize({ width: 16, height: 16 }));
  tray.setToolTip('MiniPet —— 一只在桌面上蠕动的小虫子');
  refreshTray();
  tray.on('click', () => runAction('toggleVisible'));
  tray.on('double-click', openPanel);
}

// ---------------------------------------------------------------- IPC

function setupIpc() {
  ipcMain.handle('pet:meta', () => meta);
  ipcMain.on('pet:ready', sendEnv);
  ipcMain.on('pet:menu', popupMenu);

  // ---- 控制台 ----
  ipcMain.handle('panel:init', () => ({ cfg, meta, paused }));
  ipcMain.on('panel:set', (_e, patch) => applyConfig(patch, 'panel'));
  ipcMain.on('panel:action', (_e, action) => runAction(action));
  ipcMain.on('panel:close', () => { if (panel && !panel.isDestroyed()) panel.close(); });

  // 只有鼠标真的压在虫子实体上时才接管鼠标, 其余时候让点击穿透到桌面
  ipcMain.on('pet:set-ignore-mouse', (_e, ignore) => {
    if (!win || win.isDestroyed()) return;
    if (cfg.clickThrough === false) return;
    win.setIgnoreMouseEvents(!!ignore, { forward: true });
  });
}

// ---------------------------------------------------------------- 生命周期

app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (win && !win.isDestroyed()) {
      win.showInactive();
      if (cfg.clickThrough !== false) win.setIgnoreMouseEvents(true, { forward: true });
      sendEnv();
    }
    // 已经有一个实例在跑时, `minipet --panel` 就当作"打开控制台"
    if (argv.includes('--panel')) openPanel();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    readMeta();
    setupIpc();
    createWindow();
    createTray();
    if (process.argv.includes('--panel')) openPanel();
    // 上次开着自启动退出的, 这次把系统登录项对齐一下, 防止有人手动清了注册表
    if (cfg.autoStart !== false) setAutoStart(true);
    startRemindTimer();

    screen.on('display-metrics-changed', fitToWorkArea);
    screen.on('display-added', fitToWorkArea);
    screen.on('display-removed', fitToWorkArea);
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    app.isQuitting = true;
    if (remindTimer) clearInterval(remindTimer);
  });
}
