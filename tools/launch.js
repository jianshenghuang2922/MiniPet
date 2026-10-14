'use strict';

/**
 * 启动器。
 *
 * 干三件事:
 *
 * 1. 绕开 ELECTRON_RUN_AS_NODE。
 *    有些环境里存在 ELECTRON_RUN_AS_NODE=1, Electron 会退化成纯 Node 运行,
 *    报 "Cannot read properties of undefined (reading 'commandLine')"。
 *    这里清掉它, 并且直接从 node_modules 解析出可执行文件, 不依赖 PATH。
 *
 * 2. 崩溃自愈。
 *    部分机器上 Chromium 的 GPU 进程在沙箱里会直接崩 (exit_code 0xC0000005),
 *    然后 FATAL: "GPU process isn't usable. Goodbye.", 用户只看到什么都没发生。
 *    主进程检测到这种崩溃会以 99 退出, 这里等它彻底退出后再带 --no-sandbox
 *    重新拉起一次。只重试一次。
 *    (不在应用内用 app.relaunch 是因为会和单实例锁抢时序, 新进程会被旧进程的锁顶掉)
 *
 * 3. 把命令行参数透传给 Electron。
 */

const { spawn } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');   // 纯 Node 下 require 返回可执行文件路径

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;

const passthrough = process.argv.slice(2);
const CRASH_EXIT_CODE = 99;
const NOSANDBOX_FLAG = '--minipet-nosandbox';

let attempt = 0;

function run(extraArgs) {
  attempt += 1;

  const args = [root].concat(passthrough).concat(extraArgs);
  const child = spawn(electronBin, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    windowsHide: false
  });

  child.on('error', (err) => {
    console.error('[MiniPet] 启动 Electron 失败:', err.message);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    const crashed = code === CRASH_EXIT_CODE;
    const abnormal = code !== 0 && code !== null;

    if (crashed && attempt === 1) {
      console.log('[MiniPet] 检测到 GPU/渲染进程崩溃，改用 --no-sandbox 重新启动…');
      run(['--no-sandbox', NOSANDBOX_FLAG]);
      return;
    }
    if (abnormal && attempt === 1 && !extraArgs.includes(NOSANDBOX_FLAG)) {
      console.log('[MiniPet] 上次异常退出 (code=' + code + ')，改用 --no-sandbox 重试一次…');
      run(['--no-sandbox', NOSANDBOX_FLAG]);
      return;
    }

    process.exit(code == null ? (signal ? 1 : 0) : code);
  });
}

run([]);
