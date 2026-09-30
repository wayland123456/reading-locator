#!/usr/bin/env node
/**
 * 一键发布：主文件 → index.html → version.txt → 提交 → 推送 → 复核线上
 *
 *   node publish.js                     发布（默认）
 *   node publish.js "改了什么"           发布并指定提交说明
 *   node publish.js --dry               只算版本号，不写文件不推送
 *   node publish.js --nopush            写文件 + 提交，但不推送
 *   node publish.js --noverify          推送后不等线上复核
 *
 * 版本号 = 主文件内容 hash（APP_VER 自身当占位符参与计算，避免自我引用）。
 * 内容没变 → 版本号不变 → 线上页面不会触发自动刷新。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const SRC = path.resolve(ROOT, '..', '英语阅读讲解器.html');
const DST = path.join(ROOT, 'index.html');
const VERF = path.join(ROOT, 'version.txt');
const LIVE = 'https://wayland123456.github.io/reading-locator/version.txt';
const PROXY = 'http://127.0.0.1:7890';

const flag = (n) => process.argv.includes('--' + n);
const DRY = flag('dry');
const NOPUSH = flag('nopush');
const NOVERIFY = flag('noverify');

const say = (s) => console.log(s);
const die = (s) => { console.error('\n✗ ' + s + '\n'); process.exit(1); };

const RE_VER = /(var APP_VER = ')[^']*(')/;

/* ---------- 1. 算版本号 ---------- */
if (!fs.existsSync(SRC)) die('找不到主文件：' + SRC);
const src = fs.readFileSync(SRC, 'utf8');
if (!RE_VER.test(src)) die('主文件里找不到 APP_VER 标记，请确认版本自检脚本还在');

const ver = crypto
  .createHash('md5')
  .update(src.replace(RE_VER, '$1@VER@$2'), 'utf8')
  .digest('hex')
  .slice(0, 10);

say('主文件 : ' + path.basename(SRC) + '   ' + Buffer.byteLength(src, 'utf8') + ' 字节');
say('版本号 : ' + ver);

if (DRY) { say('\n--dry：不写文件、不提交。\n'); process.exit(0); }

/* ---------- 2. 落盘 ---------- */
const out = src.replace(RE_VER, '$1' + ver + '$2');
fs.writeFileSync(SRC, out, 'utf8');        // 主文件（带上新版本号）
fs.writeFileSync(DST, out, 'utf8');        // 线上副本
fs.writeFileSync(VERF, ver + '\n', 'utf8'); // 版本戳

const md5 = crypto.createHash('md5').update(out, 'utf8').digest('hex');
say('md5    : ' + md5);
say('✔ 已写入主文件 / index.html / version.txt');

/* ---------- 3. git ---------- */
const GITCFG = [
  '-c', 'credential.helper=',
  '-c', 'credential.helper=manager',
  '-c', 'http.proxy=' + PROXY,
  '-c', 'https.proxy=' + PROXY
];
const GITENV = Object.assign({}, process.env, {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GCM_DISABLE_UI: 'true'
});
function git(args) {
  return execFileSync('git', GITCFG.concat(args), {
    cwd: ROOT, encoding: 'utf8', env: GITENV, stdio: ['ignore', 'pipe', 'pipe']
  });
}

let dirty = '';
try { dirty = git(['status', '--porcelain']).trim(); }
catch (e) { die('git 不可用：' + (e.stderr || e.message)); }

if (dirty) {
  say('\n--- 待提交 ---\n' + dirty);
  const msgArg = process.argv.slice(2).filter((a) => a.indexOf('--') !== 0)[0];
  const msg = msgArg || ('chore: 发布 ' + ver);
  git(['add', '-A']);
  git(['commit', '-m', msg]);
  say('✔ 已提交：' + msg);
} else {
  say('\n内容没有变化，无需提交。');
}

if (NOPUSH) { say('\n--nopush：不推送。\n'); process.exit(0); }

say('\n推送中…');
try {
  const r = git(['push', 'origin', 'HEAD']);
  if (r.trim()) say(r.trim());
  say('✔ 已推送');
} catch (e) {
  die('推送失败（先确认 Clash 在 7890 端口开着）：\n' + (e.stderr || e.stdout || e.message));
}

/* ---------- 4. 复核线上 ---------- */
if (NOVERIFY) { say('\n--noverify：跳过线上复核。\n'); process.exit(0); }

const HOME = 'https://wayland123456.github.io/reading-locator/';

function curl(url) {
  return execFileSync('curl', ['-s', '-x', PROXY, url], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024
  });
}
function nap(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

say('\n等待 GitHub Pages 部署（最多 150 秒）…');
const t0 = Date.now();
let ok = false;
while (Date.now() - t0 < 150000) {
  let v = null;
  try { v = curl(LIVE + '?t=' + Date.now()).trim(); } catch (e) { /* 网络抖一下，继续等 */ }
  if (v === ver) { ok = true; break; }
  nap(8000);
}

if (!ok) {
  say('\n线上 version.txt 还没变成 ' + ver + '（Pages 有时要等一两分钟）。');
  say('不影响使用，稍后再打开页面就会自动更新。\n');
  process.exit(0);
}

let size = 0, hasVer = false;
try {
  const home = curl(HOME + '?v=' + Date.now());
  size = Buffer.byteLength(home, 'utf8');
  hasVer = home.indexOf("'" + ver + "'") >= 0;
} catch (e) { /* 首页取不到不影响结论 */ }

say('✔ 线上已是 ' + ver + '　·　首页 ' + size + ' 字节　·　版本号' + (hasVer ? '已命中' : '未命中（缓存中，稍等）'));
say('\n线上地址：' + HOME + '\n');
