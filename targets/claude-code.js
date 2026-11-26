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

const CORE_FILES = ['package.json', 'index.js', 'README.md', 'LICENSE'];
const CORE_DIRS = ['scripts', 'tools', 'lib'];

function isToklessHookHandler(handler) {
  if (!handler || typeof handler !== 'object') return false;
  const cmd = String(handler.command || '');
  return cmd.includes('read-guard-hook.js');
}

function mergeClaudeSettings(settingsPath, hookCommand) {
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    const raw = fs.readFileSync(settingsPath, 'utf8').trim();
    if (raw) {
      settings = JSON.parse(raw);
    }
  }

  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    settings.hooks = {};
  }
  if (!Array.isArray(settings.hooks.PreToolUse)) {
    settings.hooks.PreToolUse = [];
  }

  const cleanedGroups = [];
  for (const group of settings.hooks.PreToolUse) {
    if (!group || typeof group !== 'object') {
      cleanedGroups.push(group);
      continue;
    }
    if (Array.isArray(group.hooks)) {
      const remaining = group.hooks.filter((h) => !isToklessHookHandler(h));
      if (remaining.length > 0) {
        cleanedGroups.push({ ...group, hooks: remaining });
      }
    } else if (!isToklessHookHandler(group)) {
      cleanedGroups.push(group);
    }
  }

  cleanedGroups.push({
    matcher: 'Read',
    hooks: [
      {
        type: 'command',
        command: hookCommand,
        timeout: 10,
      },
    ],
  });

  settings.hooks.PreToolUse = cleanedGroups;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return settings;
}

function unmergeClaudeSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return false;
  let settings;
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8').trim();
    if (!raw) return false;
    settings = JSON.parse(raw);
  } catch (_) {
    return false;
  }

  if (!settings || !settings.hooks || !Array.isArray(settings.hooks.PreToolUse)) {
    return false;
  }

  let changed = false;
  const cleanedGroups = [];
  for (const group of settings.hooks.PreToolUse) {
    if (!group || typeof group !== 'object') {
      cleanedGroups.push(group);
      continue;
    }
    if (Array.isArray(group.hooks)) {
      const remaining = group.hooks.filter((h) => {
        const hit = isToklessHookHandler(h);
        if (hit) changed = true;
        return !hit;
      });
      if (remaining.length > 0) {
        cleanedGroups.push({ ...group, hooks: remaining });
      }
    } else if (isToklessHookHandler(group)) {
      changed = true;
    } else {
      cleanedGroups.push(group);
    }
  }

  if (!changed) return false;

  if (cleanedGroups.length > 0) {
    settings.hooks.PreToolUse = cleanedGroups;
  } else {
    delete settings.hooks.PreToolUse;
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return true;
}

function rewriteClaudeSkillDoc(rawSkillMd, cliPath) {
  const unixCli = cliPath.replace(/\\/g, '/');
  const winCli = cliPath.replace(/\//g, '\\');
  return rawSkillMd
    .replace(/\$HOME\/\.gemini\/config\/plugins\/agy-tokless\/tools\/repo-skeleton\/cli\.js/g, unixCli)
    .replace(/\$env:USERPROFILE\\\.gemini\\config\\plugins\\agy-tokless\\tools\\repo-skeleton\\cli\.js/g, winCli);
}

function detect(options = {}) {
  const homeDir = resolveHomeDir(options);
  return fs.existsSync(path.join(homeDir, '.claude'));
}

function install(options = {}) {
  const sourceDir = options.sourceDir || path.resolve(__dirname, '..');
  const homeDir = resolveHomeDir(options);
  const forceCopy = shouldForceCopy(sourceDir, options.copy);
  const withGuard = Boolean(options.withGuard);

  const claudeRoot = path.join(homeDir, '.claude');
  const coreDir = path.join(claudeRoot, 'tokless');
  const skillDestDir = path.join(claudeRoot, 'skills', 'code-skeleton');
  const settingsPath = path.join(claudeRoot, 'settings.json');

  removePathSafe(coreDir);
  fs.mkdirSync(coreDir, { recursive: true });

  for (const fileName of CORE_FILES) {
    const srcFile = path.join(sourceDir, fileName);
    if (fs.existsSync(srcFile)) {
      fs.copyFileSync(srcFile, path.join(coreDir, fileName));
    }
  }

  const dirModes = {};
  for (const dirName of CORE_DIRS) {
    const mode = linkOrCopyDir(
      path.join(sourceDir, dirName),
      path.join(coreDir, dirName),
      forceCopy
    );
    if (mode !== 'skipped') {
      dirModes[dirName] = mode;
    }
  }

  removePathSafe(skillDestDir);
  fs.mkdirSync(skillDestDir, { recursive: true });
  const srcSkillFile = path.join(sourceDir, 'skills', 'code-skeleton', 'SKILL.md');
  const skeletonCliPath = path.join(coreDir, 'tools', 'repo-skeleton', 'cli.js');
  if (fs.existsSync(srcSkillFile)) {
    const rawSkill = fs.readFileSync(srcSkillFile, 'utf8');
    fs.writeFileSync(
      path.join(skillDestDir, 'SKILL.md'),
      rewriteClaudeSkillDoc(rawSkill, skeletonCliPath),
      'utf8'
    );
  }

  let hookCommand = null;
  let cleanedStaleHook = false;
  if (withGuard) {
    const hookScriptPath = path.join(coreDir, 'scripts', 'read-guard-hook.js');
    const quotedNode = quoteCommandBinary(resolveNodeBinary());
    hookCommand = `${quotedNode} ${JSON.stringify(hookScriptPath)}`;
    mergeClaudeSettings(settingsPath, hookCommand);
  } else if (fs.existsSync(settingsPath)) {
    cleanedStaleHook = unmergeClaudeSettings(settingsPath);
  }

  if (!options.silent) {
    console.log('');
    console.log(`[tokless:claude] 已安装核心至 ${coreDir}`);
    console.log(`   技能目录   : ${skillDestDir}`);
    if (withGuard) {
      console.log(`   钩子配置   : ${settingsPath} (已启用 PreToolUse -> Read, >800 行无行号导航)`);
    } else if (cleanedStaleHook) {
      console.log(`   钩子配置   : 已从 ${settingsPath} 自动移除旧 PreToolUse 钩子 (默认关闭，需启用请加 --with-guard)`);
    } else {
      console.log(`   钩子配置   : 默认关闭 (需启用 PreToolUse -> Read 请加 --with-guard)`);
    }
  }

  return {
    target: 'claude',
    coreDir,
    skillDestDir,
    settingsPath,
    hookCommand,
    withGuard,
    cleanedStaleHook,
    dirModes,
  };
}

function uninstall(options = {}) {
  const homeDir = resolveHomeDir(options);
  const claudeRoot = path.join(homeDir, '.claude');
  const coreDir = path.join(claudeRoot, 'tokless');
  const skillDestDir = path.join(claudeRoot, 'skills', 'code-skeleton');
  const settingsPath = path.join(claudeRoot, 'settings.json');

  const hadCore = fs.existsSync(coreDir);
  const hadSkill = fs.existsSync(skillDestDir);
  removePathSafe(coreDir);
  removePathSafe(skillDestDir);
  const unmerged = unmergeClaudeSettings(settingsPath);
  const removed = hadCore || hadSkill || unmerged;

  if (!options.silent) {
    if (removed) {
      console.log(`[tokless:claude] 已卸载 Claude Code 挂载（已清理 ${coreDir}、技能与 PreToolUse 钩子）。`);
    } else {
      console.log(`[tokless:claude] 未检测到已安装的 Claude Code 挂载。`);
    }
  }

  return {
    target: 'claude',
    coreDir,
    skillDestDir,
    settingsPath,
    removed,
  };
}

module.exports = {
  id: 'claude',
  aliases: ['claude', 'claude-code'],
  label: 'Claude Code (~/.claude/tokless + skills; optional PreToolUse Read hook)',
  mergeClaudeSettings,
  unmergeClaudeSettings,
  detect,
  install,
  uninstall,
};
