'use strict';

const fs = require('fs');
const path = require('path');
const {
  resolveHomeDir,
  shouldForceCopy,
  removePathSafe,
  linkOrCopyDir,
  resolveNodeBinary,
  quoteCommandBinary,
} = require('./shared');

const PLUGIN_NAME = 'agy-tokless';
const ROOT_FILES = ['plugin.json', 'hooks.json', 'package.json', 'index.js', 'README.md', 'LICENSE'];
const LINK_DIRS = ['rules', 'skills', 'agents', 'scripts', 'tools', 'lib', 'sidecars'];

/**
 * 将已安装 sidecars 目录下各 sidecar.json 中的 `"command": "node"` 替换为当前绝对 node 路径
 * — 为什么这么写 —
 * Antigravity 拉起 sidecar 子进程时在 Windows/GUI 环境下可能缺少用户 PATH 中的 node，
 * 写入绝对路径（不加 shell 引号，因 sidecar 使用 execFile/spawn 直接启动可执行文件）可确保 100% 拉起成功。
 */
function patchInstalledSidecarsNodeBinary(sidecarsDir) {
  if (!fs.existsSync(sidecarsDir)) return;
  const nodeBin = resolveNodeBinary();
  for (const entry of fs.readdirSync(sidecarsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cfgPath = path.join(sidecarsDir, entry.name, 'sidecar.json');
    if (!fs.existsSync(cfgPath)) continue;
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (cfg && cfg.command === 'node') {
        cfg.command = nodeBin;
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      }
    } catch (_) {
      // 忽略异常，保留原文件
    }
  }
}

function installHooksJson(srcFile, destFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(srcFile, 'utf8'));
    const quotedNode = quoteCommandBinary(resolveNodeBinary());
    for (const hookCfg of Object.values(parsed)) {
      if (!hookCfg || typeof hookCfg !== 'object') continue;
      for (const groups of Object.values(hookCfg)) {
        if (!Array.isArray(groups)) continue;
        for (const group of groups) {
          const handlers = Array.isArray(group && group.hooks) ? group.hooks : [group];
          for (const handler of handlers) {
            if (handler && typeof handler.command === 'string' && /^node\s+/.test(handler.command)) {
              handler.command = handler.command.replace(/^node(?=\s+)/, quotedNode);
            }
          }
        }
      }
    }
    fs.writeFileSync(destFile, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  } catch (_) {
    fs.copyFileSync(srcFile, destFile);
  }
}

function detect(options = {}) {
  const homeDir = resolveHomeDir(options);
  return (
    fs.existsSync(path.join(homeDir, '.gemini')) ||
    fs.existsSync(path.join(homeDir, '.gemini', 'config'))
  );
}

function install(options = {}) {
  const sourceDir = options.sourceDir || path.resolve(__dirname, '..');
  const homeDir = resolveHomeDir(options);
  const forceCopy = shouldForceCopy(sourceDir, options.copy);
  const manifestPath = path.join(sourceDir, 'plugin.json');

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`[${PLUGIN_NAME}] 未在源目录找到 plugin.json：${sourceDir}`);
  }

  const pluginsBaseDir = path.join(homeDir, '.gemini', 'config', 'plugins');
  const targetDir = path.join(pluginsBaseDir, PLUGIN_NAME);
  fs.mkdirSync(pluginsBaseDir, { recursive: true });

  // 陷阱: Windows 下正在运行的 sidecar 进程会锁定 sidecars/<id> 目录导致 rmdir 报 EBUSY；
  // 遇到占用时自动降级为就地覆写更新，避免中断安装留下残缺目录。
  try {
    removePathSafe(targetDir);
  } catch (err) {
    if (!err || (err.code !== 'EBUSY' && err.code !== 'EPERM')) {
      throw err;
    }
  }
  // 陷阱: Antigravity Go 插件扫描器 os.ReadDir 会跳过根目录软链/Junction，根级必须用真实目录
  fs.mkdirSync(targetDir, { recursive: true });

  const copiedFiles = [];
  for (const fileName of ROOT_FILES) {
    const srcFile = path.join(sourceDir, fileName);
    if (fs.existsSync(srcFile)) {
      const destFile = path.join(targetDir, fileName);
      if (fileName === 'hooks.json') {
        installHooksJson(srcFile, destFile);
      } else {
        fs.copyFileSync(srcFile, destFile);
      }
      copiedFiles.push(fileName);
    }
  }

  const dirModes = {};
  for (const dirName of LINK_DIRS) {
    // sidecars 目录需就地改写 sidecar.json 中的绝对 node 路径，强制走拷贝模式避免污染源仓
    const dirForceCopy = forceCopy || dirName === 'sidecars';
    const mode = linkOrCopyDir(
      path.join(sourceDir, dirName),
      path.join(targetDir, dirName),
      dirForceCopy
    );
    if (mode !== 'skipped') {
      dirModes[dirName] = mode;
    }
  }
  patchInstalledSidecarsNodeBinary(path.join(targetDir, 'sidecars'));

  if (!options.silent) {
    console.log('');
    console.log(`[tokless:antigravity] 已安装至 ${targetDir}`);
    console.log(`   插件源目录 : ${sourceDir}`);
    console.log(`   清单文件   : ${copiedFiles.join(', ')}`);
    console.log(
      `   模块挂载   : ${Object.entries(dirModes)
        .map(([k, v]) => `${k}[${v}]`)
        .join(', ')}`
    );
  }

  return {
    target: 'antigravity',
    targetDir,
    copiedFiles,
    dirModes,
  };
}

function uninstall(options = {}) {
  const homeDir = resolveHomeDir(options);
  const targetDir = path.join(homeDir, '.gemini', 'config', 'plugins', PLUGIN_NAME);
  let existed = fs.existsSync(targetDir);
  if (!existed) {
    try {
      fs.lstatSync(targetDir);
      existed = true;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  if (!existed) {
    if (!options.silent) {
      console.log(`[tokless:antigravity] 未检测到已安装的 ${PLUGIN_NAME}（${targetDir} 不存在）。`);
    }
    return { target: 'antigravity', targetDir, removed: false };
  }

  removePathSafe(targetDir);
  if (!options.silent) {
    console.log(`[tokless:antigravity] 已卸载 ${PLUGIN_NAME}（已清理 ${targetDir}）。`);
  }
  return { target: 'antigravity', targetDir, removed: true };
}

module.exports = {
  id: 'antigravity',
  aliases: ['agy', 'antigravity'],
  label: 'Antigravity (~/.gemini/config/plugins/agy-tokless)',
  PLUGIN_NAME,
  installHooksJson,
  detect,
  install,
  uninstall,
};
