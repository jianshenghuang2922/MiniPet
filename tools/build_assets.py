# -*- coding: utf-8 -*-
"""
从原始视频中抠出虫子主体，生成带 alpha 通道的精灵图 (sprite sheet)。

用法:
    python tools/build_assets.py [源视频路径] [输出目录]

抠图思路 (源素材是黑白线稿风格, 虫子 = 亮色身体 + 深色描边, 背景 = 密集手绘排线):
  1. 亮度阈值 + 形态学开运算 -> 滤掉背景细排线, 只留下虫子这块最大连通域。
  2. 形态学闭运算 + 外轮廓填充 -> 把描边内部的暗部 (眼睛、皱纹、阴影) 补回来。
     闭运算是关键: 描边本身有细小缺口, 不闭一下外部背景会"漏"进眼睛区域。
  3. 以填充后的轮廓为基准向外生长, 但只允许长进"暗色像素"里 -> 把虫子
     自己的黑色描边吃进来, 同时不会蔓延到亮色的背景排线上。
  4. 最后按 30 帧的并集包围盒统一裁剪 (所有帧共用同一个裁剪框, 保证动画不抖)。
"""

import json
import os
import sys

import cv2
import numpy as np

# ---------------- 可调参数 ----------------
SRC_VIDEO = r"D:\视频素材\蠕动.mp4"

LOOP_START = 0     # 循环起始帧
LOOP_COUNT = 30    # 循环帧数 (视频运动周期正好 30 帧 @30fps = 1 秒)

BRIGHT_THRESH = 190   # 亮度阈值: 高于此值视为"虫子身体"
OPEN_KERNEL = 13      # 开运算核: 滤掉背景细排线
CLOSE_KERNEL = 31     # 闭运算核: 封住描边缺口, 才能正确补内部暗部
DARK_THRESH = 150     # 暗色阈值: 低于此值视为"墨线"
GROW_RADIUS = 13      # 向外生长半径 (把描边吃进来)
SPECKLE_KERNEL = 5    # 生长结果的去噪开运算核
FINAL_CLOSE = 7       # 最终平滑闭运算核
CROP_PAD = 6          # 裁剪外扩像素

OUT_W = 480           # 输出单帧宽度
COLS = 6              # 精灵图列数
FPS = 30
# -----------------------------------------


def build_mask(bgr):
    """返回虫子主体的二值掩膜 (0/255), 含自身描边, 不含背景。"""
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    _, bright = cv2.threshold(gray, BRIGHT_THRESH, 255, cv2.THRESH_BINARY)

    # 1. 开运算滤掉背景细排线
    opened = cv2.morphologyEx(
        bright, cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (OPEN_KERNEL, OPEN_KERNEL)))

    n, labels, stats, _ = cv2.connectedComponentsWithStats(opened)
    if n <= 1:
        return np.zeros(gray.shape, np.uint8)
    body = (labels == 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))).astype(np.uint8) * 255

    # 2. 闭运算封住描边缺口, 再用外轮廓整体填充
    closed = cv2.morphologyEx(
        body, cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (CLOSE_KERNEL, CLOSE_KERNEL)))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(closed)
    closed = (labels == 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))).astype(np.uint8) * 255
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    silhouette = np.zeros_like(closed)
    cv2.drawContours(silhouette, contours, -1, 255, -1)

    # 3. 向外生长进暗色区域 -> 吃掉描边, 但不越界到亮色背景
    dark = (gray < DARK_THRESH).astype(np.uint8) * 255
    reach = cv2.dilate(silhouette, cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (GROW_RADIUS * 2 + 1, GROW_RADIUS * 2 + 1)))
    outline = cv2.bitwise_and(dark, reach)
    outline = cv2.morphologyEx(outline, cv2.MORPH_OPEN, cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (SPECKLE_KERNEL, SPECKLE_KERNEL)))

    mask = cv2.bitwise_or(silhouette, outline)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (FINAL_CLOSE, FINAL_CLOSE)))

    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask)
    return (labels == 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))).astype(np.uint8) * 255


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else SRC_VIDEO
    out_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")

    if not os.path.isfile(src):
        sys.exit("找不到源视频: %s" % src)

    cap = cv2.VideoCapture(src)
    frames = []
    while True:
        ok, fr = cap.read()
        if not ok:
            break
        frames.append(fr)
    cap.release()
    print("读入 %d 帧, 分辨率 %dx%d" % (len(frames), frames[0].shape[1], frames[0].shape[0]))

    need = LOOP_START + LOOP_COUNT
    if len(frames) < need:
        sys.exit("视频帧数不足: 需要 %d 帧, 实际 %d 帧" % (need, len(frames)))

    loop = frames[LOOP_START:need]
    masks = [build_mask(f) for f in loop]

    # 所有帧共用一个裁剪框
    xs0 = min(int(np.nonzero(m)[1].min()) for m in masks)
    ys0 = min(int(np.nonzero(m)[0].min()) for m in masks)
    xs1 = max(int(np.nonzero(m)[1].max()) for m in masks)
    ys1 = max(int(np.nonzero(m)[0].max()) for m in masks)
    H, W = masks[0].shape
    x0 = max(0, xs0 - CROP_PAD)
    y0 = max(0, ys0 - CROP_PAD)
    x1 = min(W, xs1 + 1 + CROP_PAD)
    y1 = min(H, ys1 + 1 + CROP_PAD)
    cw, ch = x1 - x0, y1 - y0
    print("裁剪框 (%d,%d)-(%d,%d)  尺寸 %dx%d" % (x0, y0, x1, y1, cw, ch))

    fw = OUT_W
    fh = int(round(OUT_W * ch / cw))
    rows = int(np.ceil(LOOP_COUNT / COLS))
    sheet = np.zeros((rows * fh, COLS * fw, 4), np.uint8)

    for i, (fr, mask) in enumerate(zip(loop, masks)):
        alpha = cv2.GaussianBlur(mask, (0, 0), 1.0)
        rgba = np.dstack([fr, alpha]).astype(np.float32)[y0:y1, x0:x1]

        # 预乘 alpha -> 缩放 -> 反预乘, 避免缩放时把背景色混进边缘
        a = rgba[:, :, 3:4] / 255.0
        small = cv2.resize(np.dstack([rgba[:, :, :3] * a, a * 255.0]), (fw, fh),
                           interpolation=cv2.INTER_AREA)
        sa = small[:, :, 3:4] / 255.0
        rgb = np.where(sa > 1e-4, small[:, :, :3] / np.maximum(sa, 1e-4), 0.0)
        out = np.dstack([np.clip(rgb, 0, 255), small[:, :, 3]]).astype(np.uint8)

        r, c = divmod(i, COLS)
        sheet[r * fh:(r + 1) * fh, c * fw:(c + 1) * fw] = out

    os.makedirs(out_dir, exist_ok=True)
    sheet_path = os.path.join(out_dir, "pet-sheet.png")
    cv2.imwrite(sheet_path, sheet, [cv2.IMWRITE_PNG_COMPRESSION, 9])

    meta = {
        "frameWidth": fw,
        "frameHeight": fh,
        "columns": COLS,
        "rows": rows,
        "frameCount": LOOP_COUNT,
        "fps": FPS,
        "source": os.path.basename(src),
    }
    with open(os.path.join(out_dir, "pet.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    print("精灵图: %s" % sheet_path)
    print("  布局 %d 列 x %d 行, 单帧 %dx%d, 共 %d 帧" % (COLS, rows, fw, fh, LOOP_COUNT))
    print("  文件大小 %.2f MB" % (os.path.getsize(sheet_path) / 1048576.0))

    build_tray_icon(sheet[0:fh, 0:fw], os.path.join(out_dir, "tray.png"))


def build_tray_icon(frame, out_path, size=64):
    """把第一帧缩成托盘图标 (虫子很扁, 所以留出上下留白居中摆放)。"""
    fh, fw = frame.shape[:2]
    inner_w = size - 8
    inner_h = max(1, int(round(inner_w * fh / fw)))
    small = cv2.resize(frame, (inner_w, inner_h), interpolation=cv2.INTER_AREA)

    canvas = np.zeros((size, size, 4), np.uint8)
    y = (size - inner_h) // 2
    x = (size - inner_w) // 2
    canvas[y:y + inner_h, x:x + inner_w] = small
    cv2.imwrite(out_path, canvas)
    print("托盘图标: %s" % out_path)


if __name__ == "__main__":
    main()
