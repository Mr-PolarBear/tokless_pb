'use strict';

const path = require('path');

const LANG_DIR_TO_EXTS = Object.freeze({
  javascript: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'],
  sfc: ['.vue', '.svelte'],
  java: ['.java'],
  'c-family': [
    '.c',
    '.h',
    '.cpp',
    '.hpp',
    '.cc',
    '.cxx',
    '.c++',
    '.hh',
    '.hxx',
    '.h++',
    '.inl',
    '.inc',
    '.cs',
  ],
  kotlin: ['.kt', '.kts'],
  go: ['.go'],
  rust: ['.rs'],
  python: ['.py'],
  markdown: ['.md', '.mdx', '.markdown'],
});

const EXT_TO_LANG_DIR = new Map();
for (const [langDir, exts] of Object.entries(LANG_DIR_TO_EXTS)) {
  for (const ext of exts) {
    EXT_TO_LANG_DIR.set(ext, langDir);
  }
}

const SUPPORTED_EXTS = new Set(EXT_TO_LANG_DIR.keys());

const loadedHandlers = new Map();

function normalizeExt(extOrPath) {
  if (!extOrPath) return '';
  const str = String(extOrPath).toLowerCase();
  if (str.startsWith('.')) return str;
  return path.extname(str).toLowerCase() || `.${str}`;
}

function getLanguageDir(extOrPath) {
  const ext = normalizeExt(extOrPath);
  return EXT_TO_LANG_DIR.get(ext) || null;
}

function getLanguageHandler(extOrPath) {
  const langDir = getLanguageDir(extOrPath);
  if (!langDir) return null;
  if (loadedHandlers.has(langDir)) {
    return loadedHandlers.get(langDir);
  }
  // 陷阱: 仅在真实扫描到对应后缀时按需惰性 require 语言模块，保持 CLI 冷启动与 SUPPORTED_EXTS 零额外加载开销
  const handler = require(path.join(__dirname, '..', 'langs', langDir));
  loadedHandlers.set(langDir, handler);
  return handler;
}

function clearLanguageCache() {
  loadedHandlers.clear();
}

module.exports = {
  LANG_DIR_TO_EXTS,
  EXT_TO_LANG_DIR,
  SUPPORTED_EXTS,
  normalizeExt,
  getLanguageDir,
  getLanguageHandler,
  clearLanguageCache,
};
