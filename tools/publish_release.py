#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""创建 GitHub Release 并上传便携版 zip 资源。

用法:
    python tools/publish_release.py <token>

读 build/release-notes.md 作为 Release 正文, 上传 build/MiniPet-v<ver>-win-x64.zip。
沙箱代理偶发 502, 所有请求都带重试。
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

OWNER = 'jianshenghuang2922'
REPO = 'MiniPet'
TAG = 'v1.0.0'
RELEASE_NAME = 'MiniPet v1.0.0 — 一只在桌面上蠕动的小虫子'

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NOTES = os.path.join(ROOT, 'build', 'release-notes.md')
ASSET = os.path.join(ROOT, 'build', 'MiniPet-v1.0.0-win-x64.zip')

API = 'https://api.github.com'
MAX_TRY = 8


def req(url, method='GET', data=None, headers=None, timeout=120):
    h = {
        'Authorization': 'token ' + TOKEN,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'MiniPet-release-bot',
    }
    if headers:
        h.update(headers)
    r = urllib.request.Request(url, data=data, headers=h, method=method)
    return urllib.request.urlopen(r, timeout=timeout)


def with_retry(desc, fn):
    last = None
    for i in range(1, MAX_TRY + 1):
        try:
            out = fn()
            print('[OK] %s (第 %d 次)' % (desc, i))
            return out
        except urllib.error.HTTPError as e:
            body = ''
            try:
                body = e.read().decode('utf-8', 'replace')[:400]
            except Exception:
                pass
            # 4xx (除了 429/502) 是真实错误, 不重试
            if 400 <= e.code < 500 and e.code not in (408, 429):
                print('[FAIL] %s HTTP %d %s' % (desc, e.code, body))
                raise
            last = 'HTTP %d %s' % (e.code, body)
        except Exception as e:
            last = '%s: %s' % (type(e).__name__, e)
        print('[retry %d/%d] %s -> %s' % (i, MAX_TRY, desc, last))
        time.sleep(3)
    raise RuntimeError('%s 重试 %d 次仍失败: %s' % (desc, MAX_TRY, last))


def cred_from_git():
    """没传 token 时, 从 git 凭据管理器里取。"""
    import subprocess
    try:
        out = subprocess.run(
            ['git', '-c', 'credential.helper=manager', 'credential', 'fill'],
            input='protocol=https\nhost=github.com\n\n',
            capture_output=True, text=True, timeout=60,
        ).stdout
    except Exception as e:
        sys.exit('读取 git 凭据失败: %s' % e)
    for line in out.splitlines():
        if line.startswith('password='):
            return line[len('password='):].strip()
    sys.exit('git 凭据里没有 password (先 git push 一次让凭据管理器存下来)')


TOKEN = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('GH_TOKEN', '')
if not TOKEN:
    TOKEN = cred_from_git()
    print('未传 token, 已从 git 凭据管理器读取')
if not TOKEN:
    sys.exit('缺少 token')

with open(NOTES, 'r', encoding='utf-8') as f:
    body = f.read()
size = os.path.getsize(ASSET)
print('资源: %s (%.1f MB)' % (os.path.basename(ASSET), size / 1048576.0))
print('正文: %d 字符' % len(body))

# ---------- 1. 查已有 release ----------
def get_existing():
    try:
        with req('%s/repos/%s/%s/releases/tags/%s' % (API, OWNER, REPO, TAG)) as r:
            return json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise

existing = with_retry('查询 release', get_existing)

payload = json.dumps({
    'tag_name': TAG,
    'name': RELEASE_NAME,
    'body': body,
    'draft': False,
    'prerelease': False,
}).encode('utf-8')

if existing:
    print('已存在 release id=%s, 改为更新' % existing['id'])
    rid = existing['id']

    def do_update():
        with req('%s/repos/%s/%s/releases/%s' % (API, OWNER, REPO, rid),
                 method='PATCH', data=payload,
                 headers={'Content-Type': 'application/json'}) as r:
            return json.loads(r.read().decode('utf-8'))

    rel = with_retry('更新 release', do_update)
else:
    def do_create():
        with req('%s/repos/%s/%s/releases' % (API, OWNER, REPO),
                 method='POST', data=payload,
                 headers={'Content-Type': 'application/json'}) as r:
            return json.loads(r.read().decode('utf-8'))

    rel = with_retry('创建 release', do_create)

print('release: id=%s url=%s' % (rel['id'], rel['html_url']))
upload_url = rel['upload_url'].split('{')[0]
assets = {a['name']: a for a in rel.get('assets', [])}

# ---------- 2. 上传资源 ----------
name = os.path.basename(ASSET)
if name in assets:
    print('资源已存在 id=%s, 先删除' % assets[name]['id'])

    def do_del():
        with req('%s/repos/%s/%s/releases/assets/%s' % (API, OWNER, REPO, assets[name]['id']),
                 method='DELETE') as r:
            r.read()
            return True

    with_retry('删除旧资源', do_del)

with open(ASSET, 'rb') as f:
    blob = f.read()
print('已读入 %d 字节, 开始上传...' % len(blob))


def do_upload():
    url = '%s?name=%s' % (upload_url, urllib.parse.quote(name))
    with req(url, method='POST', data=blob,
             headers={'Content-Type': 'application/zip'},
             timeout=600) as r:
        return json.loads(r.read().decode('utf-8'))


asset = with_retry('上传资源', do_upload)
print('资源上传完成: %s (%.1f MB)' % (asset['name'], asset['size'] / 1048576.0))
print('下载地址: %s' % asset['browser_download_url'])
print('Release 页面: %s' % rel['html_url'])
