"""
MiniPet 截屏工具（DPI 感知）。

为什么不用 PowerShell 的 CopyFromScreen：PowerShell 进程是 DPI 不敏感的，
在缩放显示器上 Windows 会把屏幕尺寸按 96DPI 虚拟化报小
（本机物理 2560x1600 会报成 1707x1067），截出来只有左上角 2/3 的画面，
跑到屏幕右侧或下方的虫子会被整个漏掉。

这里在**任何 GUI 调用之前**声明 DPI 感知，再用 GetDeviceCaps(DESKTOPHORZRES)
拿真实物理分辨率，所以整屏都在。

用法：

    # 单张
    python tools\\capture.py -o D:\\MiniPet\\.tmp_shot.png

    # 连拍（给 verify.py 用）
    python tools\\capture.py -o D:\\MiniPet\\.tmp_burst -n 6 -g 700
"""

import argparse
import ctypes
import sys
import time

# ---- 必须在导入/初始化任何 GUI 之前做 ----
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)      # PER_MONITOR_AWARE_V2
except Exception:
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

from PIL import ImageGrab  # noqa: E402

DESKTOPHORZRES = 118
DESKTOPVERTRES = 117


def physical_size():
    """返回主显示器的真实物理分辨率。"""
    user32, gdi32 = ctypes.windll.user32, ctypes.windll.gdi32
    hdc = user32.GetDC(0)
    try:
        w = gdi32.GetDeviceCaps(hdc, DESKTOPHORZRES)
        h = gdi32.GetDeviceCaps(hdc, DESKTOPVERTRES)
    finally:
        user32.ReleaseDC(0, hdc)
    return w, h


def keep_awake():
    """阻止息屏/休眠，否则会拍到冻结的旧画面。"""
    ES_CONTINUOUS, ES_SYSTEM_REQUIRED, ES_DISPLAY_REQUIRED = 0x80000000, 0x1, 0x2
    ctypes.windll.kernel32.SetThreadExecutionState(
        ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED
    )


def grab(out, box=None):
    img = ImageGrab.grab(bbox=box, all_screens=False)
    img.save(out)
    return img.size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--out", required=True, help="单张时的输出文件；连拍时的前缀")
    ap.add_argument("-n", "--count", type=int, default=1, help="连拍张数，默认 1")
    ap.add_argument("-g", "--gap", type=int, default=700, help="连拍间隔（毫秒），默认 700")
    ap.add_argument("--box", default=None, help="只截某块区域 x0,y0,x1,y1（物理像素）")
    args = ap.parse_args()

    keep_awake()
    w, h = physical_size()
    box = None
    if args.box:
        box = tuple(int(v) for v in args.box.split(","))
        size = (box[2] - box[0], box[3] - box[1])
    else:
        size = (w, h)
    print(f"物理分辨率 {w}x{h}  截取 {size[0]}x{size[1]}")

    for i in range(args.count):
        if args.count == 1:
            out = args.out
        else:
            root = args.out[:-4] if args.out.lower().endswith(".png") else args.out
            out = f"{root}_{i}.png"
        t0 = time.time()
        grab(out, box)
        print(f"  {out}  ({time.time() - t0:.2f}s)")
        if i < args.count - 1:
            time.sleep(args.gap / 1000.0)
    return 0


if __name__ == "__main__":
    sys.exit(main())
