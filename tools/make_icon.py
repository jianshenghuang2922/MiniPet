"""生成应用图标 MiniPet.ico —— 白色小虫放在圆角深色底上，多尺寸。"""
from PIL import Image, ImageDraw

SIZE = 256
PET_SRC = 'assets/pet-sheet.png'
FRAME = (0, 0, 480, 211)   # 第一帧

# --- 底: 圆角深色方块 ---
base = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(base)
d.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=52, fill=(43, 42, 36, 255))

# --- 虫: 取一帧, 等比缩放居中 ---
sheet = Image.open(PET_SRC).convert('RGBA')
pet = sheet.crop(FRAME)
target_w = 208
ratio = target_w / pet.width
pet = pet.resize((target_w, max(1, int(pet.height * ratio))), Image.LANCZOS)
px = (SIZE - pet.width) // 2
py = (SIZE - pet.height) // 2 + 6
base.alpha_composite(pet, (px, py))

base.save('.tmp_icon_256.png')

# --- 导出多尺寸 .ico ---
sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
base.save('build/MiniPet.ico', format='ICO', sizes=sizes)
print('生成 build/MiniPet.ico, 尺寸:', sizes)
