'use strict';

const fs = require('fs');
const path = require('path');
const { SUPPORTED_EXTS } = require('./registry');

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'exports',
  '.next',
  '.nuxt',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  'coverage',
  '.turbo',
  'Objects',
  'Listings',
  '.cache',
  '.clangd',
  '.vs',
  '.idea',
]);

function isDefaultIgnoredDirName(name) {
  return IGNORED_DIRS.has(name) || name.startsWith('cmake-build-');
}

function toPosixPath(p) {
  return p.replace(/\\/g, '/');
}

function resolveMaxDepth(options = {}, fallback = Infinity) {
  const candidates = [options.maxDepth, options.depth];
  for (const val of candidates) {
    if (val === Infinity) return Infinity;
    if (Number.isInteger(val) && val >= 0) return val;
  }
  return fallback;
}

function normalizeExcludeMatcher(exclude) {
  const names = new Set();
  const paths = [];
  const rawItems = [];

  if (Array.isArray(exclude) || exclude instanceof Set) {
    for (const item of exclude) {
      if (typeof item === 'string' && item.trim()) rawItems.push(item.trim());
    }
  } else if (typeof exclude === 'string' && exclude.trim()) {
    for (const part of exclude.split(',')) {
      if (part.trim()) rawItems.push(part.trim());
    }
  }

  for (const raw of rawItems) {
    const cleaned = toPosixPath(raw).replace(/^\.\//, '').replace(/\/+$/, '');
    if (!cleaned) continue;
    if (cleaned.includes('/')) {
      paths.push(cleaned);
    } else {
      names.add(cleaned);
    }
  }

  return { names, paths };
}

function isExtraExcluded(matcher, entryName, relPath) {
  if (matcher.names.has(entryName)) return true;
  for (let i = 0; i < matcher.paths.length; i++) {
    const pat = matcher.paths[i];
    if (relPath === pat || relPath.startsWith(`${pat}/`)) return true;
  }
  return false;
}

function escapeRegexChar(ch) {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findCharClassEnd(pattern, startIdx) {
  let i = startIdx + 1;
  if (i < pattern.length && (pattern[i] === '!' || pattern[i] === '^')) i++;
  if (i < pattern.length && pattern[i] === ']') i++;
  while (i < pattern.length) {
    if (pattern[i] === '\\' && i + 1 < pattern.length) {
      i += 2;
      continue;
    }
    if (pattern[i] === ']') return i;
    i++;
  }
  return -1;
}

function compileGitignorePattern(pattern) {
  let regexStr = '^';
  let i = 0;
  const len = pattern.length;

  while (i < len) {
    if (pattern.startsWith('**/', i) && (i === 0 || pattern[i - 1] === '/')) {
      while (pattern.startsWith('**/', i)) {
        i += 3;
      }
      regexStr += '(?:.+/)?';
      continue;
    }
    if (pattern.slice(i) === '/**') {
      regexStr += '/.+';
      i = len;
      break;
    }
    if (pattern.startsWith('/**/', i)) {
      while (pattern.startsWith('/**/', i)) {
        i += 3;
      }
      i += 1;
      regexStr += '/(?:.+/)?';
      continue;
    }
    if (pattern.slice(i) === '**' && (i === 0 || pattern[i - 1] === '/')) {
      regexStr += '.*';
      i = len;
      break;
    }

    const ch = pattern[i];
    if (ch === '\\' && i + 1 < len) {
      regexStr += escapeRegexChar(pattern[i + 1]);
      i += 2;
      continue;
    }
    if (ch === '*') {
      while (i < len && pattern[i] === '*') i++;
      regexStr += '[^/]*';
      continue;
    }
    if (ch === '?') {
      regexStr += '[^/]';
      i++;
      continue;
    }
    if (ch === '[') {
      const closeIdx = findCharClassEnd(pattern, i);
      if (closeIdx !== -1) {
        const inner = pattern.slice(i + 1, closeIdx);
        const isNegatedClass = inner.startsWith('!') || inner.startsWith('^');
        const classBody = (isNegatedClass ? inner.slice(1) : inner).replace(/(^|[^\\])\]/g, '$1\\]');
        if (isNegatedClass) {
          regexStr += `(?:(?!/)[${'^' + classBody}])`;
        } else {
          regexStr += `[${classBody}]`;
        }
        i = closeIdx + 1;
        continue;
      }
      regexStr += '\\[';
      i++;
      continue;
    }

    regexStr += escapeRegexChar(ch);
    i++;
  }

  regexStr += '$';
  return new RegExp(regexStr);
}

function stripUnescapedTrailingSpaces(line) {
  let end = line.length;
  while (end > 0 && line[end - 1] === ' ') {
    let bs = 0;
    let idx = end - 2;
    while (idx >= 0 && line[idx] === '\\') {
      bs++;
      idx--;
    }
    if (bs % 2 === 1) break;
    end--;
  }
  return line.slice(0, end);
}

function parseGitignoreLine(rawLine, baseDir) {
  let line = rawLine.replace(/\r$/, '');
  if (!line || /^\s*$/.test(line)) return null;
  if (line.startsWith('#')) return null;

  line = stripUnescapedTrailingSpaces(line);
  if (!line) return null;

  let negated = false;
  if (line.startsWith('!')) {
    negated = true;
    line = line.slice(1);
    if (!line) return null;
  }

  let dirOnly = false;
  if (line.endsWith('/') && !line.endsWith('\\/')) {
    dirOnly = true;
    line = line.slice(0, -1);
    if (!line) return null;
  }

  let anchored = false;
  if (line.startsWith('/')) {
    anchored = true;
    line = line.slice(1);
    if (!line) return null;
  } else if (line.includes('/')) {
    anchored = true;
  }

  const regex = compileGitignorePattern(line);
  return {
    baseDir,
    negated,
    dirOnly,
    anchored,
    regex,
  };
}

function parseGitignoreContent(content, baseDir) {
  if (!content) return [];
  const cleaned = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const lines = cleaned.split('\n');
  const rules = [];
  for (let i = 0; i < lines.length; i++) {
    const rule = parseGitignoreLine(lines[i], baseDir);
    if (rule) rules.push(rule);
  }
  return rules;
}

function loadGitignoreRules(dirPath) {
  const ignoreFile = path.join(dirPath, '.gitignore');
  try {
    const st = fs.statSync(ignoreFile);
    if (!st.isFile()) return [];
    const content = fs.readFileSync(ignoreFile, 'utf8');
    return parseGitignoreContent(content, dirPath);
  } catch (_) {
    return [];
  }
}

function isIgnoredByRules(rules, fullPath, isDir) {
  if (!rules || rules.length === 0) return false;
  let ignored = false;
  let cachedBase = null;
  let cachedRel = '';

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (rule.dirOnly && !isDir) continue;

    if (rule.baseDir !== cachedBase) {
      cachedBase = rule.baseDir;
      cachedRel = toPosixPath(path.relative(rule.baseDir, fullPath));
    }
    if (!cachedRel || cachedRel === '.' || cachedRel === '..' || cachedRel.startsWith('../')) {
      continue;
    }

    let matched;
    if (rule.anchored) {
      matched = rule.regex.test(cachedRel);
    } else {
      const slashIdx = cachedRel.lastIndexOf('/');
      const baseName = slashIdx === -1 ? cachedRel : cachedRel.slice(slashIdx + 1);
      matched = rule.regex.test(baseName);
    }

    if (matched) {
      ignored = !rule.negated;
    }
  }

  return ignored;
}

function findGitRoot(startDir) {
  let cur = path.resolve(startDir);
  while (true) {
    try {
      if (fs.existsSync(path.join(cur, '.git'))) {
        return cur;
      }
    } catch (_) {
      // Ignore permission errors while probing upward
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function resolveAncestorIgnoreState(root, respectGitignore) {
  const gitRoot = findGitRoot(root);
  if (!gitRoot || gitRoot === root) {
    return { gitRoot, penetrated: false, initialRules: [] };
  }

  const relFromGit = path.relative(gitRoot, root);
  const parts = relFromGit.split(path.sep).filter(Boolean);
  const ancestors = [gitRoot];
  let acc = gitRoot;
  for (let i = 0; i < parts.length; i++) {
    acc = path.join(acc, parts[i]);
    ancestors.push(acc);
  }

  const accumulatedRules = respectGitignore ? loadGitignoreRules(gitRoot) : [];

  for (let k = 1; k < ancestors.length; k++) {
    const dirK = ancestors[k];
    const dirName = path.basename(dirK);
    if (
      isDefaultIgnoredDirName(dirName) ||
      (respectGitignore && isIgnoredByRules(accumulatedRules, dirK, true))
    ) {
      return { gitRoot, penetrated: true, initialRules: [] };
    }
    if (respectGitignore && k < ancestors.length - 1) {
      const layer = loadGitignoreRules(dirK);
      for (let j = 0; j < layer.length; j++) {
        accumulatedRules.push(layer[j]);
      }
    }
  }

  return { gitRoot, penetrated: false, initialRules: accumulatedRules };
}

function safeRealpath(targetPath) {
  try {
    return fs.realpathSync(targetPath);
  } catch (_) {
    return null;
  }
}

function normalizeRealKey(realPath) {
  return process.platform === 'win32' ? realPath.toLowerCase() : realPath;
}

function normalizeExtensionSet(extensions) {
  if (extensions === null) return null;
  if (extensions === undefined) return SUPPORTED_EXTS;
  if (extensions instanceof Set) return extensions;
  if (Array.isArray(extensions)) {
    return new Set(extensions.map((ext) => String(ext).toLowerCase()));
  }
  return SUPPORTED_EXTS;
}

function walkDirectory(dirPath, options = {}) {
  const root = path.resolve(dirPath);
  const maxDepth = resolveMaxDepth(options, Infinity);
  const respectGitignore = options.respectGitignore !== false;
  const extSet = normalizeExtensionSet(options.extensions);
  const excludeMatcher = normalizeExcludeMatcher(options.exclude);
  const onFile = typeof options.onFile === 'function' ? options.onFile : null;

  const { gitRoot, penetrated, initialRules } = resolveAncestorIgnoreState(root, respectGitignore);
  const rootReal = safeRealpath(root) || root;
  const visitedRealDirs = new Set([normalizeRealKey(rootReal)]);
  const files = onFile ? null : [];

  function walk(currentDir, currentRealDir, currentDepth, parentRules) {
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (_) {
      return;
    }

    const localRules = respectGitignore ? loadGitignoreRules(currentDir) : [];
    const rules = localRules.length > 0 ? parentRules.concat(localRules) : parentRules;

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const fullPath = path.join(currentDir, entry.name);
      const isSymlink = entry.isSymbolicLink();
      let isDir = false;
      let isFile = false;

      if (isSymlink) {
        // 陷阱: Node readdirSync 对软链与 Windows Junction 返回 isDirectory()=false，需 statSync 探测真实目标
        try {
          const st = fs.statSync(fullPath);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch (_) {
          continue;
        }
      } else {
        isDir = entry.isDirectory();
        isFile = entry.isFile();
      }

      const relPath = toPosixPath(path.relative(root, fullPath));

      if (isDir) {
        if (isDefaultIgnoredDirName(entry.name)) continue;
        if (isExtraExcluded(excludeMatcher, entry.name, relPath)) continue;
        if (respectGitignore && isIgnoredByRules(rules, fullPath, true)) continue;

        if (currentDepth < maxDepth) {
          const childRealDir = isSymlink
            ? safeRealpath(fullPath)
            : path.join(currentRealDir, entry.name);
          if (!childRealDir) continue;

          const visitKey = normalizeRealKey(childRealDir);
          if (visitedRealDirs.has(visitKey)) continue;
          visitedRealDirs.add(visitKey);

          walk(fullPath, childRealDir, currentDepth + 1, rules);
        }
      } else if (isFile) {
        const ext = path.extname(entry.name).toLowerCase();
        if (extSet && !extSet.has(ext)) continue;
        if (isExtraExcluded(excludeMatcher, entry.name, relPath)) continue;
        if (respectGitignore && isIgnoredByRules(rules, fullPath, false)) continue;

        const fileInfo = {
          fullPath,
          relPath,
          ext,
          name: entry.name,
        };
        if (onFile) {
          onFile(fileInfo);
        } else {
          files.push(fileInfo);
        }
      }
    }
  }

  walk(root, rootReal, 0, initialRules);

  return {
    root,
    maxDepth,
    gitRoot,
    penetrated,
    files: files || [],
  };
}

module.exports = {
  IGNORED_DIRS,
  isDefaultIgnoredDirName,
  toPosixPath,
  resolveMaxDepth,
  parseGitignoreContent,
  isIgnoredByRules,
  findGitRoot,
  walkDirectory,
};
