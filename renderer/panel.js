'use strict';

/**
 * MiniPet 控制台
 *
 * 面板上所有控件都是"即时生效"的: 拖动滑杆 -> 立刻推给主进程 -> 主进程写 config
 * 并广播给宠物窗口。下面的预览区用 assets/preview-bg.mp4 当背景, 实时按当前
 * 大小和速度把虫子放进去走一遍, 所见即所得。
 */

const $ = (id) => document.getElementById(id);

const canvas = $('preview');
const ctx = canvas.getContext('2d');
const stage = $('stage');
const video = $('bgvideo');

let state = { cfg: null, meta: null, paused: false };
let sheet = null;
let ready = false;
let dpr = 1;

// 预览里虫子的位置/朝向
const walk = { x: 0, dir: 1, flip: false, clockStart: 0 };

const ASPECT_FALLBACK = 480 / 211;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ---------------------------------------------------------------- 启动

async function boot() {
  state = await window.petAPI.panelInit();

  sheet = new Image();
  sheet.src = '../assets/pet-sheet.png';
  await sheet.decode();

  ready = true;
  bindAll();
  applyState(state);
  resizeCanvas();
  walk.clockStart = performance.now();
  requestAnimationFrame(loop);
}

window.petAPI.onPanelSync((s) => {
  state = s;
  if (!ready) return;
  applyState(s);
});

// ---------------------------------------------------------------- 控件绑定

function setPct(el) {
  const min = Number(el.min);
  const max = Number(el.max);
  const v = Number(el.value);
  el.style.setProperty('--pct', (((v - min) / (max - min)) * 100).toFixed(2) + '%');
}

/**
 * 把一个 range 绑定到配置键上。
 * @param {string} key       config 键名
 * @param {Function} format  值 -> 显示文本
 */
function bindRange(id, outId, key, format, after) {
  const el = $(id);
  const out = $(outId);

  el.addEventListener('input', () => {
    const v = Number(el.value);
    setPct(el);
    out.textContent = format(v);
    state.cfg[key] = v;
    const patch = { [key]: v };
    if (key === 'idleMin' && state.cfg.idleMax < v) {
      state.cfg.idleMax = v;
      const other = $('s-idlemax');
      other.value = v;
      setPct(other);
      patch.idleMax = v;
    }
    if (key === 'idleMax' && state.cfg.idleMin > v) {
      state.cfg.idleMin = v;
      const other = $('s-idlemin');
      other.value = v;
      setPct(other);
      patch.idleMin = v;
    }
    refreshIdleOut();
    syncChips();
    window.petAPI.panelSet(patch);
    if (after) after(v);
  });

  el.__format = format;
  el.__out = out;
  return el;
}

function bindToggle(id, key) {
  const el = $(id);
  el.addEventListener('change', () => {
    state.cfg[key] = el.checked;
    window.petAPI.panelSet({ [key]: el.checked });
  });
  return el;
}

const SIZE_PRESETS = [90, 150, 220, 320, 440];
const SPEED_PRESETS = [22, 55, 110, 220];

function syncChips() {
  document.querySelectorAll('.chip').forEach((chip) => {
    const target = chip.closest('.chips').dataset.target;
    if (!target) return;   // 互动区的分钟 chips 不驱动滑杆, 跳过
    const v = Number(chip.dataset.value);
    const cur = target === 's-size' ? state.cfg.petWidth : state.cfg.speed;
    chip.classList.toggle('on', Math.abs(cur - v) < 0.5);
  });
}

function refreshIdleOut() {
  $('o-idle').textContent =
    state.cfg.idleMin.toFixed(1) + ' ~ ' + state.cfg.idleMax.toFixed(1) + ' 秒';
}

function bindAll() {
  bindRange('s-size', 'o-size', 'petWidth', (v) => Math.round(v) + ' px');
  bindRange('s-opacity', 'o-opacity', 'opacity', (v) => Math.round(v * 100) + '%');
  bindRange('s-shadow', 'o-shadow', 'shadowBlur', (v) => Math.round(v));
  bindRange('s-speed', 'o-speed', 'speed', (v) => Math.round(v) + ' px/s');
  bindRange('s-idlemin', 'o-idle', 'idleMin', (v) => v.toFixed(1));
  bindRange('s-idlemax', 'o-idle', 'idleMax', (v) => v.toFixed(1));

  bindToggle('c-shadow', 'shadow');
  bindToggle('c-wander', 'wander');
  bindToggle('c-ontop', 'alwaysOnTop');
  bindToggle('c-through', 'clickThrough');
  bindToggle('c-autostart', 'autoStart');

  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const target = chip.closest('.chips').dataset.target;
      if (!target) return;      // 分钟 chips 有自己的处理器
      const v = Number(chip.dataset.value);
      const slider = $(target);
      slider.value = v;
      slider.dispatchEvent(new Event('input'));
    });
  });

  $('btn-close').addEventListener('click', () => window.petAPI.panelClose());
  $('btn-recenter').addEventListener('click', () => window.petAPI.panelAction('recenter'));
  $('btn-reset').addEventListener('click', () => window.petAPI.panelAction('reset'));
  $('btn-pause').addEventListener('click', () => window.petAPI.panelAction('togglePause'));

  $('btn-bg').addEventListener('click', () => {
    stage.classList.toggle('no-bg');
    const off = stage.classList.contains('no-bg');
    if (off) video.pause(); else video.play().catch(() => { /* 自动播放被拒就算了 */ });
  });

  // 投影关掉时, 强度滑杆变灰
  $('c-shadow').addEventListener('change', () => {
    $('s-shadow').classList.toggle('dim', !$('c-shadow').checked);
  });

  bindReminder();

  window.addEventListener('resize', resizeCanvas);
}

// ---------------------------------------------------------------- 互动：定时提醒

// 用户选中的分钟数只是"待发射"的值, 真正生效的是 config 里的 remindAt 绝对时间戳
let remindMinutes = 15;

function syncRemindChips() {
  document.querySelectorAll('#remind-chips .chip').forEach((chip) => {
    chip.classList.toggle('on', Number(chip.dataset.min) === remindMinutes);
  });
}

/** 每秒刷新一次顶部状态条。时间判断全看 config 里的 remindAt, 面板只是读 */
function tickRemind() {
  const cfg = (state && state.cfg) || {};
  const at = cfg.remindAt;
  const badge = $('remind-badge');
  const text = $('remind-strip-text');
  const cancelBtn = $('btn-remind-cancel');
  const startBtn = $('btn-remind-start');
  if (!badge) return;

  if (at && at > Date.now()) {
    const left = Math.max(0, at - Date.now());
    const s = Math.round(left / 1000);
    const m = Math.floor(s / 60);
    const mm = (m > 0 ? m + ' 分 ' : '') + String(s % 60).padStart(2, '0') + ' 秒';
    badge.textContent = '⏱';
    text.textContent = '剩余 ' + mm + ' · ' + (cfg.remindText || '时间到了！');
    cancelBtn.hidden = false;
    startBtn.textContent = '重新计时';
  } else {
    badge.textContent = '互动';
    text.textContent = '定时提醒，到点虫子会喊出来';
    cancelBtn.hidden = true;
    startBtn.textContent = '开始计时';
  }
}

function bindReminder() {
  document.querySelectorAll('#remind-chips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      remindMinutes = Number(chip.dataset.min);
      $('o-remind-min').textContent = remindMinutes + ' 分钟';
      syncRemindChips();
    });
  });

  $('i-remind-text').addEventListener('change', () => {
    const v = $('i-remind-text').value.trim() || '时间到了！';
    state.cfg.remindText = v;
    window.petAPI.panelSet({ remindText: v });
  });

  $('btn-remind-start').addEventListener('click', () => {
    const v = $('i-remind-text').value.trim() || '时间到了！';
    state.cfg.remindText = v;
    window.petAPI.panelSet({
      remindAt: Date.now() + remindMinutes * 60000,
      remindText: v
    });
  });

  $('btn-remind-cancel').addEventListener('click', () => {
    window.petAPI.panelSet({ remindAt: null });
  });

  setInterval(tickRemind, 1000);
}

// ---------------------------------------------------------------- 状态回填

function applyState(s) {
  state = s;
  const cfg = s.cfg;

  const pairs = [
    ['s-size', 'o-size', 'petWidth', (v) => Math.round(v) + ' px'],
    ['s-opacity', 'o-opacity', 'opacity', (v) => Math.round(v * 100) + '%'],
    ['s-shadow', 'o-shadow', 'shadowBlur', (v) => Math.round(v)],
    ['s-speed', 'o-speed', 'speed', (v) => Math.round(v) + ' px/s'],
    ['s-idlemin', null, 'idleMin', (v) => v.toFixed(1)],
    ['s-idlemax', null, 'idleMax', (v) => v.toFixed(1)]
  ];

  for (const [id, outId, key, fmt] of pairs) {
    const el = $(id);
    el.value = cfg[key];
    setPct(el);
    if (outId) $(outId).textContent = fmt(cfg[key]);
  }
  refreshIdleOut();

  $('c-shadow').checked = cfg.shadow !== false;
  $('c-wander').checked = cfg.wander !== false;
  $('c-ontop').checked = cfg.alwaysOnTop !== false;
  $('c-through').checked = cfg.clickThrough !== false;
  $('c-autostart').checked = cfg.autoStart === true;
  $('s-shadow').classList.toggle('dim', !$('c-shadow').checked);

  $('i-remind-text').value = cfg.remindText || '时间到了！';

  $('btn-pause').textContent = s.paused ? '继续活动' : '暂停活动';
  $('btn-pause').classList.toggle('primary', !!s.paused);

  syncChips();
  syncRemindChips();
  tickRemind();
}

// ---------------------------------------------------------------- 预览

function resizeCanvas() {
  dpr = Math.max(1, window.devicePixelRatio || 1);
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
}

function metrics() {
  const aspect = state.meta ? state.meta.frameWidth / state.meta.frameHeight : ASPECT_FALLBACK;
  const petW = Math.max(20, state.cfg.petWidth);
  const stageW = stage.clientWidth;
  const scale = Math.min(1, (stageW - 56) / petW);
  const w = petW * scale;
  const h = w / aspect;
  const pad = Math.max(2, Math.round(w * 0.07));
  return { scale, w, h, pad, stageW };
}

function loop(now) {
  requestAnimationFrame(loop);
  if (!ready || !sheet) return;

  let dt = (now - (loop.last || now)) / 1000;
  loop.last = now;
  if (!(dt > 0)) dt = 1 / 60;
  if (dt > 0.1) dt = 0.1;

  const m = metrics();

  // 虫子沿地面左右走, 走到头就掉头 —— 顺便演示左右翻转
  walk.x += walk.dir * state.cfg.speed * m.scale * dt;
  const leftLimit = 12;
  const rightLimit = Math.max(leftLimit + 1, m.stageW - m.w - 12);
  if (walk.x <= leftLimit) { walk.x = leftLimit; walk.dir = 1; }
  if (walk.x >= rightLimit) { walk.x = rightLimit; walk.dir = -1; }
  walk.flip = walk.dir > 0;      // 素材头朝左, 往右走就镜像

  // 缩放提示
  const tag = $('stage-tag');
  const label = m.scale >= 0.999 ? '1:1' : '缩放 ' + Math.round(m.scale * 100) + '%';
  if (tag.textContent !== label) tag.textContent = label;

  draw(m, now);
}

function draw(m, now) {
  const meta = state.meta;
  const cfg = state.cfg;

  const total = meta ? meta.frameCount : 30;
  const fps = meta ? meta.fps : 30;
  const idx = ((Math.floor((now - walk.clockStart) / 1000 * fps) % total) + total) % total;
  const cols = meta ? meta.columns : 6;
  const fw = meta ? meta.frameWidth : 480;
  const fh = meta ? meta.frameHeight : 211;
  const col = idx % cols;
  const row = Math.floor(idx / cols);

  const groundY = canvas.height / dpr - m.h - Math.round(canvas.height / dpr * 0.16);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = cfg.opacity == null ? 1 : cfg.opacity;

  ctx.save();
  if (walk.flip) {
    ctx.translate(walk.x + m.w / 2, 0);
    ctx.scale(-1, 1);
    ctx.translate(-(walk.x + m.w / 2), 0);
  }
  if (cfg.shadow) {
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
    ctx.shadowBlur = (cfg.shadowBlur || 12) * m.scale;
    ctx.shadowOffsetY = 3 * m.scale;
  }
  ctx.drawImage(sheet, col * fw, row * fh, fw, fh,
    walk.x, groundY, m.w, m.h);
  ctx.restore();

  ctx.globalAlpha = 1;
}

boot().catch((err) => console.error('控制台初始化失败:', err));
