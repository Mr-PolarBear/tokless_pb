'use strict';

const jsLang = require('../javascript');

const ID = 'sfc';
const EXTENSIONS = ['.vue', '.svelte'];

function resolveScriptExt(openTagLine) {
  const langMatch = openTagLine.match(/\blang\s*=\s*["']?([A-Za-z0-9_-]+)["']?/i);
  if (!langMatch) return '.js';
  const lang = langMatch[1].toLowerCase();
  if (lang === 'ts' || lang === 'typescript') return '.ts';
  if (lang === 'tsx') return '.tsx';
  if (lang === 'jsx') return '.jsx';
  return '.js';
}

function parse(lines, ext = '.vue', options = {}) {
  if (ext && typeof ext === 'object') {
    options = ext;
    ext = '.vue';
  }
  const baseOffset = options.lineOffset || 0;
  const items = [];
  const blockRegex = /^<(template|script|style)(\b[^>]*)?>/i;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const m = trimmed.match(blockRegex);
    if (!m) continue;

    const tag = m[1].toLowerCase();
    const closeTag = `</${tag}>`;
    let endIdx = i;
    for (let j = i; j < lines.length; j++) {
      if (lines[j].toLowerCase().includes(closeTag)) {
        endIdx = j;
        break;
      }
    }

    items.push({
      kind: 'section',
      name: tag,
      signature: trimmed.replace(/>.*$/, '>'),
      startLine: i + 1 + baseOffset,
      endLine: endIdx + 1 + baseOffset,
      depth: 0,
    });

    if (tag === 'script' && endIdx > i + 1) {
      const innerLines = lines.slice(i + 1, endIdx);
      const scriptExt = resolveScriptExt(trimmed);
      const scriptItems = jsLang.parse(innerLines, scriptExt, {
        lineOffset: baseOffset + i + 1,
      });
      for (const si of scriptItems) {
        items.push({ ...si, depth: si.depth + 1 });
      }
    }

    i = endIdx;
  }

  return items;
}

module.exports = {
  id: ID,
  extensions: EXTENSIONS,
  parse,
};
