"""
MiniPet 自检 —— 从连拍截图里判断虫子是否在正常移动、有没有闪烁。

先连拍，再分析：

    powershell -ExecutionPolicy Bypass -File tools\\burst.ps1 -Prefix D:\\MiniPet\\.tmp_burst -Count 6 -GapMs 700
    python tools\\verify.py D:\\MiniPet\\.tmp_burst

输出三样东西：

  1. 逐帧虫体包围盒 —— 位置应该连续变化，方向要跟朝向一致
  2. 实测速度 —— 应该接近 config.json 里的 speed
  3. 帧间变化率 —— 单帧画面变化量占虫体面积的比例。
     平滑移动时只有边缘一圈在变（几个百分点）；一旦出现闪烁，整只虫子都在变，会接近 100%

用法提示：分析前先把会动的窗口（聊天、视频）挪开或最小化，否则运动检测会先抓到它们。
必要时用 --roi x0,y0,x1,y1 手动圈定虫子所在的区域。
"""

import argparse
import glob
import os
import sys

import cv2
import numpy as np


def load_frames(prefix):
    files = sorted(glob.glob(prefix + "*.png"))
    frames = []
    for f in files:
        img = cv2.imread(f)
        if img is not None:
            frames.append((os.path.basename(f), img))
    return frames


def pet_boxes(frames, roi, thresh=8):
    """用中位数当背景：虫子一直在动，中位数会把虫子抹掉，剩下静态背景。"""
    stack = np.stack([cv2.cvtColor(f[1], cv2.COLOR_BGR2GRAY) for f in frames])
    bg = np.median(stack, axis=0).astype(np.uint8)

    x0, y0, x1, y1 = roi
    boxes = []
    masks = []
    for name, img in frames:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        diff = cv2.absdiff(gray, bg)
        m = np.zeros_like(diff)
        m[y0:y1, x0:x1] = diff[y0:y1, x0:x1]
        _, m = cv2.threshold(m, thresh, 255, cv2.THRESH_BINARY)
        # 不要在这里做开运算：虫身是白的、压在浅色界面上时差异很微弱，
        # 开运算会把整个虫身抹掉，只剩一圈描边。直接闭运算把虫身和影子连成一块，
        # 噪声交给"取最大连通域 + min-area"过滤。
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((25, 25), np.uint8))
        masks.append(m)

        n, labels, stats, _ = cv2.connectedComponentsWithStats(m)
        if n <= 1:
            boxes.append(None)
            continue
        idx = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        bx, by, bw, bh, area = stats[idx]
        boxes.append((bx, by, bw, bh, area))
    return boxes, masks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("prefix", help="连拍文件前缀，例如 D:\\MiniPet\\.tmp_burst")
    ap.add_argument("--roi", default=None, help="分析区域 x0,y0,x1,y1；默认整屏")
    ap.add_argument("--gap-ms", type=int, default=700, help="连拍间隔（毫秒），用来换算速度")
    ap.add_argument("--min-area", type=int, default=200, help="小于这个面积的连通域忽略")
    ap.add_argument(
        "--thresh",
        type=int,
        default=8,
        help="判定「和背景不同」的灰度差阈值。虫子是白色的，压在浅色界面上时对比度很低，"
        "阈值调太高会把虫身漏掉、只剩一圈描边。",
    )
    args = ap.parse_args()

    frames = load_frames(args.prefix)
    if len(frames) < 2:
        print("至少需要 2 帧。先跑 tools/burst.ps1 连拍。")
        return 1

    h, w = frames[0][1].shape[:2]
    if args.roi:
        roi = tuple(int(v) for v in args.roi.split(","))
    else:
        roi = (0, 0, w, h)

    print(f"帧数 {len(frames)}  画面 {w}x{h}  ROI {roi}")
    print(f"帧间隔 {args.gap_ms} ms\n")

    boxes, masks = pet_boxes(frames, roi, args.thresh)
    good = [(i, b) for i, b in enumerate(boxes) if b and b[4] >= args.min_area]

    if not good:
        print("没找到足够大的运动目标。")
        print("· 确认虫子没被别的大窗口挡住（它是置顶的，但全屏应用可能压住它）")
        print("· 确认它没有处于暂停状态（右键菜单 / 控制台底部）")
        print("· 试试用 --roi 圈定它所在的区域")
        return 2

    print("逐帧虫体包围盒：")
    for i, b in good:
        bx, by, bw, bh, area = b
        print(f"  #{i}  box=({bx},{by})-({bx + bw},{by + bh})  {bw}x{bh}  area={area}")

    # ---- 速度 ----
    pts = [(i, b[0] + b[2] / 2, b[1] + b[3] / 2) for i, b in good]
    step_px = []
    for (i0, x0, y0), (i1, x1, y1) in zip(pts, pts[1:]):
        d = ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5
        step_px.append(d / max(1, i1 - i0))
    if step_px:
        px_per_step = sum(step_px) / len(step_px)
        px_per_s = px_per_step * 1000.0 / args.gap_ms
        print(f"\n实测位移：{px_per_step:.1f} px / 帧间隔  →  {px_per_s:.0f} px/s")
        print("（跟 config.json 里的 speed 对一下；平滑加减速会让它略低）")

    # ---- 闪烁 ----
    print("\n帧间变化率（占虫体面积）：")
    ratios = []
    for (i0, b0), (i1, b1) in zip(good, good[1:]):
        if i1 != i0 + 1:
            continue
        m0, m1 = masks[i0], masks[i1]
        g0 = cv2.cvtColor(frames[i0][1], cv2.COLOR_BGR2GRAY)
        g1 = cv2.cvtColor(frames[i1][1], cv2.COLOR_BGR2GRAY)
        # 只统计虫体区域（两帧包围盒的并集）
        x0 = min(b0[0], b1[0]); y0 = min(b0[1], b1[1])
        x1 = max(b0[0] + b0[2], b1[0] + b1[2])
        y1 = max(b0[1] + b0[3], b1[1] + b1[3])
        area = max(1, (x1 - x0) * (y1 - y0))
        d = cv2.absdiff(g0[y0:y1, x0:x1], g1[y0:y1, x0:x1])
        changed = int((d > 30).sum())
        r = changed / area
        ratios.append(r)
        print(f"  #{i0}→#{i1}  {r * 100:5.1f}%   ({changed}/{area} px)")

    if ratios:
        avg = sum(ratios) / len(ratios)
        print(f"\n平均 {avg * 100:.1f}%")
        if avg < 0.15:
            print("→ 正常。只有边缘在变，是平滑移动。")
        elif avg < 0.5:
            print("→ 偏高。虫子可能正在大幅转向或改变姿态，也可能有轻微重绘。")
        else:
            print("→ 异常。整只虫子都在变，典型的重绘/闪烁特征。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
