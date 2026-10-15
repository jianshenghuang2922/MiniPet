'use strict';
// 用 rcedit 给 exe 写入图标和版本信息。由 build_release.py 调用。
// 用法: node tools/rcedit_set.js <exe路径> <ico路径> <版本号>

const { rcedit } = require('rcedit');

const [, , exe, icon, version] = process.argv;
if (!exe || !icon || !version) {
  console.error('用法: node tools/rcedit_set.js <exe> <ico> <version>');
  process.exit(1);
}

rcedit(exe, {
  icon,
  'version-string': {
    CompanyName: 'MiniPet',
    FileDescription: 'MiniPet —— 桌面宠物',
    ProductName: 'MiniPet',
    LegalCopyright: 'MIT License'
  },
  'file-version': version,
  'product-version': version
}).then(() => {
  console.log('rcedit 完成: ' + exe);
}).catch((err) => {
  console.error('rcedit 失败:', err.message);
  process.exit(1);
});
