"""把 MiniPet 打成 Windows 便携版 zip。

思路: 不做安装包, 直接复用 node_modules 里的 Electron 运行时——
复制 dist -> 把 electron.exe 改名成 MiniPet.exe -> 写入图标和版本信息 ->
把应用代码塞进 resources/app -> 删掉 Electron 自带的 default_app.asar -> 压缩。

用户解压后双击 MiniPet.exe 就能用, 不需要装 Node.js 或 Electron。
"""
import json
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NAME = 'MiniPet'

# 打进 resources/app 的东西 (启动器 tools/ 不需要, main.js 只在注释里提到它)
APP_FILES = ['main.js', 'preload.js', 'renderer', 'assets', 'package.json', 'README.md', 'LICENSE']


def main():
    pkg = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
    version = pkg['version']

    out = ROOT / 'build' / 'release'
    app_dir = out / NAME
    res_app = app_dir / 'resources' / 'app'

    print('[1/6] 清理', out)
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    print('[2/6] 复制 Electron 运行时 (368MB, 稍等)')
    shutil.copytree(ROOT / 'node_modules' / 'electron' / 'dist', app_dir)

    print('[3/6] 重命名 electron.exe -> %s.exe' % NAME)
    (app_dir / 'electron.exe').rename(app_dir / (NAME + '.exe'))

    print('[4/6] 写入图标和版本信息')
    icon = ROOT / 'build' / (NAME + '.ico')
    if not icon.exists():
        print('  图标不存在, 先跑 tools/make_icon.py')
        sys.exit(1)
    node = shutil.which('node') or 'node'
    r = subprocess.run([node, str(ROOT / 'tools' / 'rcedit_set.js'),
                        str(app_dir / (NAME + '.exe')), str(icon), version],
                       capture_output=True, text=True)
    print('  ' + (r.stdout.strip() or r.stderr.strip()))
    if r.returncode != 0:
        sys.exit('rcedit 失败')

    print('[5/6] 写入应用代码 -> resources/app')
    res_app.mkdir(parents=True, exist_ok=True)
    for item in APP_FILES:
        src = ROOT / item
        if not src.exists():
            print('  跳过(不存在):', item)
            continue
        dst = res_app / item
        if src.is_dir():
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)
    # Electron 自带的示例应用, 留着会干扰
    default_app = app_dir / 'resources' / 'default_app.asar'
    if default_app.exists():
        default_app.unlink()

    print('[6/6] 压缩')
    zip_path = ROOT / 'build' / ('%s-v%s-win-x64.zip' % (NAME, version))
    if zip_path.exists():
        zip_path.unlink()
    count = 0
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for root, _dirs, files in os.walk(out):
            for f in files:
                fp = Path(root) / f
                z.write(fp, fp.relative_to(out))
                count += 1
    size_mb = zip_path.stat().st_size / 1024 / 1024
    print('\n完成: %s' % zip_path)
    print('  文件数 %d, 压缩后 %.1f MB' % (count, size_mb))


if __name__ == '__main__':
    main()
