#!/usr/bin/env node
/**
 * dsh-answer-timing — 安装器
 *
 * 把本仓库注册成 DSH desktop profile 的一个 bundle：
 *   1. <profile>/.<name>-source        -> 本仓库（junction / symlink）
 *   2. <profile>/node_modules/<name>   -> 本仓库（junction / symlink）
 *   3. profile/package.json  dependencies.<name> = "link:.<name>-source"
 *   4. profile/package.json  dsh.profile.bundles 追加 <name>
 *
 * 为什么不用 npm install：DSH 的 desktop profile 由插件自己管依赖，
 * bundle 必须是本地可解析的包，所以走 link: 协议 + 目录链接。
 *
 * 用法：
 *   node install.mjs                  # 安装（默认 profile = desktop）
 *   node install.mjs --dry-run        # 只打印计划，不写文件
 *   node install.mjs --profile web    # 指定其它 profile
 *   node install.mjs --dsh-home D:\x  # 指定 DSH_HOME（默认 ~/.dsh 或 $DSH_HOME）
 *   node install.mjs --force          # 目标位置是真实目录时，改名备份后继续
 *   node install.mjs --uninstall      # 卸载（摘掉 bundles / 依赖 / 两个链接）
 *
 * 装完必须 **完全退出并重启 DSH** 才会生效。
 */

import {
  existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync,
  readdirSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url));
const IS_WIN = platform() === 'win32';

/* ──────────────────────────── 终端输出 ──────────────────────────── */

const C = {
  reset: '\u001b[0m', dim: '\u001b[2m', bold: '\u001b[1m',
  red: '\u001b[31m', green: '\u001b[32m', yellow: '\u001b[33m', cyan: '\u001b[36m',
};
const paint = (code, s) => (process.stdout.isTTY ? code + s + C.reset : s);
const ok = (s) => console.log(paint(C.green, '  \u2714 ') + s);
const info = (s) => console.log(paint(C.dim, '  \u00b7 ') + s);
const warn = (s) => console.log(paint(C.yellow, '  ! ') + s);
const step = (s) => console.log('\n' + paint(C.bold + C.cyan, s));
const die = (msg) => { console.error('\n' + paint(C.red, '\u2716 ') + msg + '\n'); process.exit(1); };
const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

/* ──────────────────────────── 参数 ──────────────────────────── */

const argv = process.argv.slice(2);
const has = (n) => argv.includes('--' + n);
const opt = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const O = {
  uninstall: has('uninstall'),
  dryRun: has('dry-run'),
  force: has('force'),
  help: has('help') || has('h'),
  profile: opt('profile', 'desktop'),
  dshHome: resolve(opt('dsh-home', process.env.DSH_HOME || join(homedir(), '.dsh'))),
};

if (O.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''));
  process.exit(0);
}

/* ──────────────────────────── 定位 ──────────────────────────── */

const pkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'));
const NAME = pkg.name;
if (!NAME) die('插件的 package.json 缺少 name 字段。');
if (!pkg.dsh?.bundle?.patch) {
  die('插件的 package.json 缺少 dsh.bundle.patch。\n  没有这个字段，DSH 启动时会打印 "declares no dsh.bundle" 并跳过本插件。');
}
if (!existsSync(join(PLUGIN_ROOT, pkg.main || 'index.js'))) {
  die(`找不到入口文件：${join(PLUGIN_ROOT, pkg.main || 'index.js')}`);
}

const PROFILE_DIR = join(O.dshHome, 'profiles', O.profile);
const PROFILE_PKG = join(PROFILE_DIR, 'package.json');
const LINK_DIR = join(PROFILE_DIR, 'node_modules', NAME);
const SOURCE_LINK = join(PROFILE_DIR, `.${NAME}-source`);
const DEP_VALUE = `link:.${NAME}-source`;

if (!existsSync(PROFILE_PKG)) {
  const profilesRoot = join(O.dshHome, 'profiles');
  const found = existsSync(profilesRoot)
    ? readdirSync(profilesRoot).filter((n) => {
        try { return statSync(join(profilesRoot, n)).isDirectory(); } catch { return false; }
      })
    : [];
  die(
    `找不到 DSH profile：\n  ${PROFILE_DIR}\n\n` +
    `  已发现的 profile：${found.length ? found.join(', ') : '（无）'}\n` +
    `  用 --profile <名字> 或 --dsh-home <DSH 目录> 指定。`
  );
}

/* ──────────────────────────── 文件工具 ──────────────────────────── */

const pathState = (p) => {
  if (!existsSync(p)) return 'missing';
  try { return lstatSync(p).isSymbolicLink() ? 'link' : 'dir'; } catch { return 'unknown'; }
};
const readLink = (p) => { try { return readlinkSync(p); } catch { return ''; } };

function ensureLink(linkPath, target) {
  const state = pathState(linkPath);

  if (state === 'link') {
    const current = resolve(dirname(linkPath), readLink(linkPath));
    if (current === resolve(target)) { info(`已就绪 ${linkPath}`); return 'unchanged'; }
    if (O.dryRun) { info(`将重建（当前指向 ${current}）${linkPath}`); return 'would-replace'; }
    try {
      unlinkSync(linkPath);
    } catch (e) {
      die(
        `重建链接失败：${linkPath}\n  ${e.code}\n` +
        `  DSH 正在运行并占用着它时无法替换 —— 请完全退出 DSH 后重试。`
      );
    }
    info(`已重建（原指向 ${current}）`);
  } else if (state === 'dir') {
    if (!O.force) {
      die(
        `${linkPath}\n  这是一个真实目录，不是链接。\n` +
        `  为了不误删你的文件，请先手动移走它，或者加 --force 让我改名备份。`
      );
    }
    const bak = `${linkPath}.bak-${stamp()}`;
    if (O.dryRun) { info(`将把真实目录改名为 ${bak}`); } else { renameSync(linkPath, bak); warn(`原目录已备份为 ${bak}`); }
  }

  if (O.dryRun) { info(`将创建链接 ${linkPath} -> ${target}`); return 'would-create'; }
  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(resolve(target), linkPath, IS_WIN ? 'junction' : 'dir');
  ok(`链接 ${linkPath} -> ${target}`);
  return 'created';
}

function dropLink(linkPath) {
  const state = pathState(linkPath);
  if (state === 'missing') { info(`不存在，跳过 ${linkPath}`); return true; }
  if (state !== 'link') { warn(`不是链接，未删除（请手动处理）：${linkPath}`); return true; }
  if (O.dryRun) { info(`将删除链接 ${linkPath}`); return true; }
  try {
    unlinkSync(linkPath);
    ok(`已删除 ${linkPath}`);
    return true;
  } catch (e) {
    warn(`删不掉 ${linkPath}（${e.code}）\u2014\u2014 DSH 多半还在运行并占用着它`);
    return false;
  }
}

/* ──────────────────────────── 主流程 ──────────────────────────── */

const profile = JSON.parse(readFileSync(PROFILE_PKG, 'utf8'));
const before = JSON.stringify(profile);

profile.dependencies ??= {};
profile.dsh ??= {};
profile.dsh.profile ??= {};
profile.dsh.profile.bundles ??= [];

const leftoverLinks = [];

console.log(paint(C.bold, `\n${NAME}@${pkg.version}  ${O.uninstall ? '卸载' : '安装'}`));
info(`插件目录 ${PLUGIN_ROOT}`);
info(`DSH 目录 ${O.dshHome}`);
info(`Profile  ${O.profile}  (${PROFILE_DIR})`);
if (O.dryRun) warn('dry-run：只打印计划，不写任何文件');
if (process.versions.node.split('.')[0] < 24) warn(`Node 版本 ${process.versions.node} 低于 engines 要求的 24`);

if (!O.uninstall) {
  step('\u2460 建立目录链接');
  ensureLink(SOURCE_LINK, PLUGIN_ROOT);
  ensureLink(LINK_DIR, PLUGIN_ROOT);

  step('\u2461 注册依赖');
  if (profile.dependencies[NAME] === DEP_VALUE) {
    info(`已就绪 dependencies["${NAME}"] = "${DEP_VALUE}"`);
  } else if (O.dryRun) {
    info(`将写入 dependencies["${NAME}"] = "${DEP_VALUE}"（原值 ${profile.dependencies[NAME] ?? '无'}）`);
  } else {
    profile.dependencies[NAME] = DEP_VALUE;
    ok(`dependencies["${NAME}"] = "${DEP_VALUE}"`);
  }

  step('\u2462 加入 profile.bundles');
  if (profile.dsh.profile.bundles.includes(NAME)) {
    info(`已就绪 bundles 已包含 ${NAME}（共 ${profile.dsh.profile.bundles.length} 项）`);
  } else if (O.dryRun) {
    info(`将在 bundles 末尾追加 ${NAME}`);
  } else {
    profile.dsh.profile.bundles.push(NAME);
    ok(`bundles += ${NAME}（共 ${profile.dsh.profile.bundles.length} 项）`);
  }
} else {
  step('\u2460 从 profile.bundles 摘除');
  if (profile.dsh.profile.bundles.includes(NAME)) {
    if (O.dryRun) info(`将从 bundles 移除 ${NAME}`);
    else {
      profile.dsh.profile.bundles = profile.dsh.profile.bundles.filter((x) => x !== NAME);
      ok(`bundles -= ${NAME}`);
    }
  } else info('bundles 里本来就没有');

  step('\u2461 移除依赖');
  if (Object.hasOwn(profile.dependencies, NAME)) {
    if (O.dryRun) info(`将删除 dependencies["${NAME}"]`);
    else { delete profile.dependencies[NAME]; ok(`dependencies -= ${NAME}`); }
  } else info('dependencies 里本来就没有');

  step('\u2462 删除目录链接');
  for (const p of [LINK_DIR, SOURCE_LINK]) {
    if (!dropLink(p)) leftoverLinks.push(p);
  }
}

/* 写回 */
step('\u2463 写回 profile/package.json');
const after = JSON.stringify(profile);
if (after === before) {
  info('内容无变化，跳过写入（幂等）');
} else if (O.dryRun) {
  info('dry-run：未写入');
} else {
  const bak = `${PROFILE_PKG}.bak-${stamp()}`;
  writeFileSync(bak, readFileSync(PROFILE_PKG));
  ok(`备份 ${bak}`);
  writeFileSync(PROFILE_PKG, JSON.stringify(profile, null, 2) + '\n');
  ok(`写入 ${PROFILE_PKG}`);
}

/* 收尾 */
if (!O.dryRun) {
  console.log('\n' + paint(C.bold + C.green, O.uninstall ? '卸载完成' : '安装完成') + '\n');
  if (leftoverLinks.length) {
    console.log(paint(C.yellow, `  \u26a0 有 ${leftoverLinks.length} 个链接没能删除（DSH 正在运行）：`));
    for (const p of leftoverLinks) console.log(paint(C.dim, `      ${p}`));
    console.log(paint(C.dim, '    注册信息已经从 package.json 里摘掉了，不影响下一次安装；'));
    console.log(paint(C.dim, '    要彻底清干净，完全退出 DSH 后再跑一次 node install.mjs --uninstall。\n'));
  }
  if (O.uninstall) {
    console.log('  重启 DSH 后插件即不再加载。\n');
  } else {
    console.log('  下一步：');
    console.log(paint(C.bold, '    \u2460 完全退出 DSH（托盘图标也要退），再重新打开'));
    console.log('    \u2461 开一个新对话，随便问一句');
    console.log('    \u2462 回答末尾应出现一行：');
    console.log(paint(C.cyan, '       \u26a1 本次 1m23s \uff1d 模型 58s（首字 1.2s · 生成 41s）\uff0b 工具 19s（pwsh 12s）\uff0b 其它 6s'));
    console.log('\n  没出现？先看启动日志里有没有类似：');
    console.log(paint(C.dim, `     dsh: skipping profile bundle "${NAME}"`));
    console.log(paint(C.dim, '  有的话说明注册没生效或插件报错，把那一行贴出来。\n'));
    console.log(paint(C.dim, `  明细账本：${join(O.dshHome, 'timing', 'turns.jsonl')}\n`));
  }
} else {
  console.log('\n' + paint(C.yellow, 'dry-run 结束，什么都没改。去掉 --dry-run 才会真的写。') + '\n');
}
