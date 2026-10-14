'use strict';

/**
 * MiniPet —— 渲染进程
 *
 * 整屏透明窗口里只有一块"虫子大小"的 canvas, 靠 CSS transform 移动它。
 * 这里同时负责:
 *   - 30fps 循环播放精灵图 (虫子原地蠕动)
 *   - 左右方向变化时把画面水平镜像 —— 这就是"翻转素材"表现左右移动
 *   - 60Hz 的漫步物理: 随机挑目标点 -> 平滑爬过去 -> 发呆 -> 再挑
 *   - 拖拽 / 单击 / 右键
 *   - 命中测试: 只有光标真的压在虫子身上, 才让窗口接管鼠标
 */

const canvas = document.getElementById('pet');
const ctx = canvas.getContext('2d', { alpha: true });

let meta = null;
let sheet = null;
let ready = false;
let pendingEnv = null;

const cfg = {
  petWidth: 150,
  speed: 55,
  wander: true,
  shadow: true,
  shadowBlur: 12,
  idleMin: 2.0,
  idleMax: 7.0,
  opacity: 1
};

// box = 虫子 + 投影留白。pet.x / pet.y 指的是这个 box 左上角在窗口里的坐标
let box = { spriteW: 150, spriteH: 66, pad: 9, boxW: 168, boxH: 84 };
let dpr = 1;
let flip = false;
let placed = false;
let clockStart = 0;
let drawnIdx = -1;
let drawnFlip = null;
let drawnBubble = false;

const pet = {
  x: 0, y: 0,
  vx: 0, vy: 0,
  tx: 0, ty: 0,
  mode: 'idle',      // idle | walk | drag
  idleUntil: 0,
  paused: false
};

let hitW = 0;
let hitH = 0;
let hitData = null;

// 右键菜单开着的时候, 主进程把整个窗口临时设成了不穿透(让点在菜单外的
// 点击能被菜单的模态循环收到、从而关掉菜单)。这期间 hover 逻辑不能插手
// 穿透开关, 否则会把窗口又设回穿透, 菜单又关不掉了。
let menuOpen = false;

let ignoring = true;
let hovering = false;
const cursor = { x: -99999, y: -99999 };

let dragging = false;
let moved = false;
let activePointer = null;
const down = { x: 0, y: 0 };
const grab = { x: 0, y: 0 };

const EDGE = 4;                                   // 离屏幕边缘留的余量
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const rand = (a, b) => a + Math.random() * (b - a);
const maxX = () => Math.max(EDGE, window.innerWidth - box.boxW - EDGE);
const maxY = () => Math.max(EDGE, window.innerHeight - box.boxH - EDGE);

// ---------------------------------------------------------------- 初始化

async function boot() {
  meta = await window.petAPI.getMeta();

  sheet = new Image();
  sheet.src = '../assets/pet-sheet.png';
  await sheet.decode();

  ready = true;
  applyEnv(pendingEnv || {});
  pendingEnv = null;

  clockStart = performance.now();
  requestAnimationFrame(frame);
  window.petAPI.ready();
}

window.petAPI.onEnv((s) => applyEnv(s));

window.petAPI.onCmd((cmd) => {
  if (!ready) return;
  if (cmd.type === 'pause') {
    pet.paused = true;
  } else if (cmd.type === 'resume') {
    pet.paused = false;
    goIdle(0.6);
  } else if (cmd.type === 'recenter') {
    pet.vx = pet.vy = 0;
    pet.x = (window.innerWidth - box.boxW) / 2;
    pet.y = (window.innerHeight - box.boxH) / 2;
    goIdle(0.8);
  } else if (cmd.type === 'click-through-changed') {
    // 主进程刚改过穿透开关(面板勾选, 或者右键菜单刚关掉、状态恢复),
    // 把本地状态对齐, 免得两边打架
    menuOpen = false;
    ignoring = !!cmd.value;
    hovering = false;
    setIgnore(ignoring);
  } else if (cmd.type === 'say') {
    // 主进程转发过来的台词(目前只用于定时提醒)
    say(cmd.text, cmd.holdMs);
  }
});

function applyEnv(s) {
  if (!ready) {
    pendingEnv = Object.assign(pendingEnv || {}, s);
    return;
  }
  if (s.meta) meta = s.meta;

  const prevSpriteW = box.spriteW;
  ['petWidth', 'speed', 'wander', 'shadow', 'shadowBlur', 'idleMin', 'idleMax', 'opacity']
    .forEach((k) => { if (s[k] !== undefined) cfg[k] = s[k]; });

  box = computeBox();
  document.body.style.opacity = String(cfg.opacity == null ? 1 : cfg.opacity);

  resizeCanvas();
  rebuildHitMap();

  if (!placed) {
    placed = true;
    pet.x = (window.innerWidth - box.boxW) / 2;
    pet.y = window.innerHeight - box.boxH - Math.round(window.innerHeight * 0.08);
    goIdle(1.0);
  } else if (prevSpriteW !== box.spriteW) {
    clampPet();
  }
}

function computeBox() {
  const aspect = meta.frameWidth / meta.frameHeight;
  const spriteW = Math.max(40, Math.round(cfg.petWidth));
  const spriteH = Math.max(16, Math.round(spriteW / aspect));
  const pad = Math.max(3, Math.round(spriteW * 0.07));
  // 顶部常驻一块气泡区。气泡永远画在虫子上方, 预留好空间, 就不用等它出现
  // 再把 canvas 撑大 —— 那样虫子会突然往下跳一格。空间要装得下气泡本体加小尾巴。
  const bubbleSize = Math.max(10, Math.round(spriteW * 0.085));
  const padTop = Math.max(bubbleSize + 24, Math.round(spriteH * 0.5));
  return {
    spriteW: spriteW,
    spriteH: spriteH,
    pad: pad,
    padTop: padTop,
    bubbleSize: bubbleSize,
    boxW: spriteW + pad * 2,
    boxH: spriteH + pad + padTop
  };
}

function resizeCanvas() {
  dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.style.width = box.boxW + 'px';
  canvas.style.height = box.boxH + 'px';
  canvas.width = Math.round(box.boxW * dpr);
  canvas.height = Math.round(box.boxH * dpr);
  drawnIdx = -1;   // 强制重画
}

/** 把第 0 帧按显示尺寸渲染到离屏画布, 取出 alpha 数组做命中测试 */
function rebuildHitMap() {
  const w = Math.max(1, box.spriteW);
  const h = Math.max(1, box.spriteH);
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const octx = off.getContext('2d', { alpha: true, willReadFrequently: true });
  octx.drawImage(sheet, 0, 0, meta.frameWidth, meta.frameHeight, 0, 0, w, h);
  const data = octx.getImageData(0, 0, w, h).data;
  hitData = new Uint8Array(w * h);
  for (let i = 0, p = 3; i < hitData.length; i++, p += 4) hitData[i] = data[p];
  hitW = w;
  hitH = h;
}

function clampPet() {
  pet.x = clamp(pet.x, EDGE, maxX());
  pet.y = clamp(pet.y, EDGE, maxY());
}

// ---------------------------------------------------------------- 行为

function pickTarget() {
  pet.tx = rand(EDGE, maxX());
  pet.ty = rand(EDGE, maxY());
  pet.mode = 'walk';
}

function goIdle(seconds) {
  pet.mode = 'idle';
  pet.idleUntil = performance.now() + seconds * 1000;
}

function poke() {
  const cx = pet.x + box.boxW / 2;
  const cy = pet.y + box.boxH / 2;
  let dx = cx - cursor.x;
  let dy = cy - cursor.y;
  const d = Math.hypot(dx, dy);
  if (d < 3) { dx = -1; dy = -0.4; }
  const n = Math.hypot(dx, dy) || 1;
  const sp = Math.max(60, cfg.speed) * 3.2;
  pet.vx = dx / n * sp;
  pet.vy = dy / n * sp;
  pet.mode = 'idle';
  pet.idleUntil = performance.now() + 900;
}

function update(dt, now) {
  if (pet.paused) return;
  if (pet.mode === 'drag') { pet.vx = pet.vy = 0; return; }

  if (pet.mode === 'idle') {
    // 快速摩擦停下 (时间常数约 0.26s)
    const damp = Math.pow(0.02, dt);
    pet.vx *= damp;
    pet.vy *= damp;
    if (Math.abs(pet.vx) < 2 && Math.abs(pet.vy) < 2) { pet.vx = 0; pet.vy = 0; }
    if (cfg.wander && now >= pet.idleUntil) pickTarget();
  } else if (pet.mode === 'walk') {
    const dx = pet.tx - pet.x;
    const dy = pet.ty - pet.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 8) {
      goIdle(rand(cfg.idleMin, cfg.idleMax));
    } else {
      const sp = Math.max(1, cfg.speed);
      const k = 1 - Math.pow(0.0015, dt);   // 速度平滑, 起步和转向不生硬
      pet.vx += (dx / dist * sp - pet.vx) * k;
      pet.vy += (dy / dist * sp - pet.vy) * k;
    }
  }

  pet.x += pet.vx * dt;
  pet.y += pet.vy * dt;

  // 撞到屏幕边缘: 弹一下并重新挑目标
  if (pet.x <= EDGE || pet.x >= maxX()) {
    pet.x = clamp(pet.x, EDGE, maxX());
    pet.vx = -pet.vx * 0.4;
    if (pet.mode === 'walk') pickTarget();
  }
  if (pet.y <= EDGE || pet.y >= maxY()) {
    pet.y = clamp(pet.y, EDGE, maxY());
    pet.vy = -pet.vy * 0.4;
    if (pet.mode === 'walk') pickTarget();
  }

  // 水平方向决定是否镜像: 素材原始朝向是"头朝左"
  if (pet.vx > 5) flip = true;         // 往右爬 -> 翻转
  else if (pet.vx < -5) flip = false;  // 往左爬 -> 保持原样
}

// ---------------------------------------------------------------- 气泡

// 画在同一块 canvas 上而不是单独一个 div: canvas 反正已经在跟着虫子移动了,
// 多画一个圆角矩形就完事; 而且天然不接鼠标事件, 不会破坏现在的点击穿透。
const bubble = { text: '', born: 0, until: 0 };

/** 在虫子头顶冒出一句话。holdMs 是停留时长, 提醒这类重要信息给久一点 */
function say(text, holdMs) {
  bubble.text = String(text == null ? '' : text).slice(0, 40);
  bubble.born = performance.now();
  bubble.until = bubble.born + (Number(holdMs) || 2200);
}

function drawBubble(now) {
  if (!bubble.text) return;

  const FADE_IN = 140;
  const FADE_OUT = 240;
  let alpha = 1;
  if (now - bubble.born < FADE_IN) alpha = (now - bubble.born) / FADE_IN;
  if (now >= bubble.until) alpha = 0;
  else if (now > bubble.until - FADE_OUT) {
    alpha = Math.min(alpha, (bubble.until - now) / FADE_OUT);
  }
  if (alpha <= 0) { bubble.text = ''; return; }

  const size = box.bubbleSize;
  const pad = 5;
  const maxTextW = box.boxW - pad * 2 - 10;
  ctx.font = '600 ' + size + 'px "Segoe UI", "Microsoft YaHei", sans-serif';

  // 放不下就先砍字, 保证不超出 canvas —— 超出去会被直接裁掉
  let text = bubble.text;
  if (ctx.measureText(text).width > maxTextW) {
    while (text.length > 1 && ctx.measureText(text + '…').width > maxTextW) {
      text = text.slice(0, -1);
    }
    text += '…';
  }

  const w = ctx.measureText(text).width;
  const bw = Math.min(box.boxW - pad * 2, w + 14);
  const bh = size + 11;
  const cx = box.boxW / 2;
  const bx = Math.max(pad, Math.min(box.boxW - pad - bw, cx - bw / 2));
  const by = 2;
  const r = Math.min(6, bh / 2);
  const tail = 5;

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));

  // 深色底白字。虫子是白身体, 气泡用浅色会和它糊在一起, 而且浅色底在深色
  // 壁纸上会看不见 —— 反过来就没有这个问题。
  ctx.beginPath();
  ctx.moveTo(bx + r, by);
  ctx.lineTo(bx + bw - r, by);
  ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + r);
  ctx.lineTo(bx + bw, by + bh - r);
  ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - r, by + bh);
  ctx.lineTo(cx + tail, by + bh);          // 朝下的小尾巴, 指向虫子
  ctx.lineTo(cx, by + bh + tail);
  ctx.lineTo(cx - tail, by + bh);
  ctx.lineTo(bx + r, by + bh);
  ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - r);
  ctx.lineTo(bx, by + r);
  ctx.quadraticCurveTo(bx, by, bx + r, by);
  ctx.closePath();
  ctx.fillStyle = '#17160f';
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, bx + bw / 2, by + bh / 2 + 0.5);
  ctx.restore();
}

// ---------------------------------------------------------------- 绘制

function frame(now) {
  requestAnimationFrame(frame);
  if (!ready) return;

  let dt = (now - (frame.last || now)) / 1000;
  frame.last = now;
  if (!(dt > 0)) dt = 1 / 60;
  if (dt > 0.1) dt = 0.1;

  update(dt, now);

  const total = meta.frameCount;
  const idx = ((Math.floor((now - clockStart) / 1000 * meta.fps) % total) + total) % total;
  // 有气泡时要每帧重画 —— 淡入淡出是连续变化的。气泡是瞬时状态, 不常驻, 所以
  // 平时该省还是省: 没气泡时仍然只按动画帧和翻转来重画。
  const bubbleOn = !!bubble.text;
  if (idx !== drawnIdx || flip !== drawnFlip || bubbleOn || drawnBubble) {
    draw(idx, flip, now);
    drawnIdx = idx;
    drawnFlip = flip;
    drawnBubble = bubbleOn;
  }

  const px = Math.round(pet.x * dpr) / dpr;
  const py = Math.round(pet.y * dpr) / dpr;
  if (px !== placedAt.x || py !== placedAt.y) {
    placedAt.x = px;
    placedAt.y = py;
    canvas.style.transform = 'translate3d(' + px + 'px, ' + py + 'px, 0)';
  }

  updateHover();
}

const placedAt = { x: NaN, y: NaN };

function draw(idx, mirrored, now) {
  const fw = meta.frameWidth;
  const fh = meta.frameHeight;
  const col = idx % meta.columns;
  const row = Math.floor(idx / meta.columns);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.save();
  if (mirrored) {
    // 以 box 中线为轴水平镜像 —— 虫子的头从朝左变成朝右
    ctx.translate(box.boxW / 2, 0);
    ctx.scale(-1, 1);
    ctx.translate(-box.boxW / 2, 0);
  }
  if (cfg.shadow) {
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = cfg.shadowBlur || 12;
    ctx.shadowOffsetY = 3;
  }
  ctx.drawImage(sheet, col * fw, row * fh, fw, fh,
    box.pad, box.padTop, box.spriteW, box.spriteH);
  ctx.restore();

  // 气泡在 restore 之后画, 不跟着镜像 —— 文字被翻过来就没法读了
  drawBubble(now);
}

// ---------------------------------------------------------------- 命中 / 穿透

function hitTest(cx, cy) {
  if (!hitData) return false;
  let x = Math.round(cx - pet.x - box.pad);
  let y = Math.round(cy - pet.y - box.padTop);
  if (x < 0 || y < 0 || x >= hitW || y >= hitH) return false;
  if (flip) x = hitW - 1 - x;
  return hitData[y * hitW + x] > 90;
}

function setIgnore(next) {
  if (next === ignoring) return;
  ignoring = next;
  window.petAPI.setIgnoreMouse(next);
}

function updateHover() {
  if (dragging || menuOpen) return;
  // 光标不动但虫子爬过来时, 这里也能把状态纠正过来
  const over = hitTest(cursor.x, cursor.y);
  if (over === hovering) return;
  hovering = over;
  document.body.style.cursor = over ? 'grab' : 'default';
  setIgnore(!over);
}

// ---------------------------------------------------------------- 鼠标

window.addEventListener('mousemove', (e) => {
  cursor.x = e.clientX;
  cursor.y = e.clientY;
});

window.addEventListener('mouseleave', () => {
  cursor.x = cursor.y = -99999;
});

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  // 菜单开着: 这次点击是用来关菜单的, 别顺手把虫子拎走(也不会触发戳一下)
  if (menuOpen) return;
  if (!hitTest(e.clientX, e.clientY)) return;
  dragging = true;
  moved = false;
  activePointer = e.pointerId;
  down.x = e.clientX;
  down.y = e.clientY;
  grab.x = e.clientX - pet.x;
  grab.y = e.clientY - pet.y;
  pet.mode = 'drag';
  pet.vx = pet.vy = 0;
  canvas.classList.add('grabbing');
  try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  e.preventDefault();
});

canvas.addEventListener('pointermove', (e) => {
  cursor.x = e.clientX;
  cursor.y = e.clientY;
  if (!dragging || e.pointerId !== activePointer) return;
  if (Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) > 4) moved = true;
  pet.x = clamp(e.clientX - grab.x, EDGE, maxX());
  pet.y = clamp(e.clientY - grab.y, EDGE, maxY());
});

function endDrag(e) {
  if (!dragging) return;
  if (e && activePointer !== null && e.pointerId !== activePointer) return;
  const id = activePointer;
  dragging = false;
  activePointer = null;
  canvas.classList.remove('grabbing');
  if (id !== null) {
    try { canvas.releasePointerCapture(id); } catch (_) { /* ignore */ }
  }
  if (moved) {
    goIdle(1.5);
  } else {
    poke();
  }
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
window.addEventListener('blur', () => { if (dragging) endDrag(null); });

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  // 主进程随即把窗口临时设为不穿透; 恢复时会发 click-through-changed 清掉这个标记
  menuOpen = true;
  window.petAPI.openMenu();
});

canvas.addEventListener('dragstart', (e) => e.preventDefault());

window.addEventListener('resize', () => {
  if (!ready) return;
  resizeCanvas();
  clampPet();
});

boot().catch((err) => console.error('MiniPet 初始化失败:', err));

