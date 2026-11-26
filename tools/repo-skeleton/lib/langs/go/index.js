'use strict';

const {
  preprocessBraceLines,
  findMatchingForward,
} = require('../../core/lexer');
const {
  findDeclarationRange,
  buildCompactSignature,
} = require('../../core/block-anchor');

const ID = 'go';
const EXTENSIONS = ['.go'];

function extractGoFuncName(analyzed, lineIdx) {
  const clean = analyzed[lineIdx].clean;
  const m = clean.match(/^\s*func\b\s*/);
  if (!m) return null;
  let col = m[0].length;
  if (col < clean.length && clean[col] === '(') {
    const closeRecv = findMatchingForward(analyzed, lineIdx, col, '(', ')');
    if (!closeRecv) return null;
    const afterRecv = analyzed[closeRecv.line].clean.slice(closeRecv.col + 1).trimStart();
    const nm = afterRecv.match(/^([A-Za-z_]\w*)\b/);
    return nm ? nm[1] : null;
  }
  const nm = clean.slice(col).match(/^([A-Za-z_]\w*)\b/);
  return nm ? nm[1] : null;
}

function parse(lines, ext = '.go', options = {}) {
  if (ext && typeof ext === 'object') {
    options = ext;
    ext = '.go';
  }
  const lineOffset = options.lineOffset || 0;
  const analyzed = preprocessBraceLines(lines, 'go');
  const items = [];
  let inTypeGroup = false;

  for (let i = 0; i < analyzed.length; i++) {
    const info = analyzed[i];
    if (info.braceStart !== 0) continue;
    const trimmed = info.clean.trim();
    if (!trimmed) continue;

    if (!inTypeGroup && /^type\s*\(\s*$/.test(trimmed)) {
      inTypeGroup = true;
      continue;
    }
    if (inTypeGroup && /^\)\s*$/.test(trimmed)) {
      inTypeGroup = false;
      continue;
    }

    let kind = null;
    let name = '';
    let m;

    if (!inTypeGroup && /^func\b/.test(trimmed)) {
      const fnName = extractGoFuncName(analyzed, i);
      if (fnName) {
        kind = 'func';
        name = fnName;
      }
    } else if (
      (m = trimmed.match(/^(?:type\s+)?([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s+struct\b/)) &&
      (inTypeGroup || trimmed.startsWith('type '))
    ) {
      kind = 'struct';
      name = m[1];
    } else if (
      (m = trimmed.match(/^(?:type\s+)?([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s+interface\b/)) &&
      (inTypeGroup || trimmed.startsWith('type '))
    ) {
      kind = 'interface';
      name = m[1];
    } else if (!inTypeGroup && (m = trimmed.match(/^type\s+([A-Za-z_]\w*)\b/))) {
      kind = 'type';
      name = m[1];
    } else if (inTypeGroup && (m = trimmed.match(/^([A-Za-z_]\w*)\b/))) {
      kind = 'type';
      name = m[1];
    }

    if (kind) {
      const range = findDeclarationRange(analyzed, i, 'go');
      const signature = buildCompactSignature(analyzed, i, range.headerEndIdx, range.hasBlock);
      items.push({
        kind,
        name,
        signature,
        startLine: i + 1 + lineOffset,
        endLine: range.endIdx + 1 + lineOffset,
        depth: 0,
      });
      i = range.endIdx;
    }
  }

  return items;
}

module.exports = {
  id: ID,
  extensions: EXTENSIONS,
  parse,
};
