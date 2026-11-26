'use strict';

const {
  preprocessBraceLines,
  findMatchingForward,
} = require('../../core/lexer');
const {
  stripLeadingAttributesAndAnnotations,
  scanBraceLanguage,
} = require('../../core/block-anchor');

const ID = 'rust';
const EXTENSIONS = ['.rs'];
const RUST_CONTAINERS = new Set(['struct', 'enum', 'trait', 'impl', 'mod']);

function parse(lines, ext = '.rs', options = {}) {
  if (ext && typeof ext === 'object') {
    options = ext;
    ext = '.rs';
  }
  const lineOffset = options.lineOffset || 0;
  const analyzed = preprocessBraceLines(lines, 'rust');

  return scanBraceLanguage(analyzed, {
    lexer: 'rust',
    containers: RUST_CONTAINERS,
    lineOffset,
    mapCallableKind() {
      return 'fn';
    },
    onStatementLine({
      analyzed: rows,
      lineIdx,
      scopeStack,
      items,
      lineOffset: offset,
      findDeclarationRange,
      buildCompactSignature,
    }) {
      const trimmed = rows[lineIdx].clean.trim();
      if (!trimmed) return null;

      if (/^#!?\[/.test(trimmed) && !trimmed.includes('fn ') && !trimmed.includes('struct ') && !trimmed.includes('type ') && !trimmed.includes('macro_rules!')) {
        return null;
      }

      const core = stripLeadingAttributesAndAnnotations(trimmed);
      if (!core) return null;

      const macroMatch = core.match(/^(?:pub(?:\s*\([^)]*\))?\s+)?macro_rules!\s+([A-Za-z_]\w*)/);
      if (macroMatch) {
        let endIdx = lineIdx;
        const cleanLine = rows[lineIdx].clean;
        const openMatch = cleanLine.match(/[\{(\[]/);
        if (openMatch) {
          const openChar = openMatch[0];
          const closePos = findMatchingForward(rows, lineIdx, openMatch.index, openChar);
          if (closePos) endIdx = closePos.line;
        }
        const signature = buildCompactSignature(rows, lineIdx, lineIdx, true);
        items.push({
          kind: 'macro',
          name: macroMatch[1],
          signature,
          startLine: lineIdx + 1 + offset,
          endLine: endIdx + 1 + offset,
          depth: scopeStack.length,
        });
        return { jumpToLine: endIdx };
      }

      const semiCandidate = core.match(
        /^(?:pub(?:\s*\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern(?:\s+"[^"]*")?\s+)?(fn|struct|type|mod)\s+([A-Za-z_]\w*)/
      );
      if (!semiCandidate) return null;

      const range = findDeclarationRange(rows, lineIdx, 'rust');
      if (range.hasBlock) return null;

      const joinedClean = rows
        .slice(lineIdx, range.endIdx + 1)
        .map((r) => r.clean)
        .join(' ')
        .trim();
      if (!joinedClean.endsWith(';')) return null;

      let startIdx = lineIdx;
      while (startIdx > 0) {
        const prevTrim = rows[startIdx - 1].clean.trim();
        if (/^#\[/.test(prevTrim) && rows[startIdx - 1].braceStart === rows[lineIdx].braceStart) {
          startIdx--;
        } else {
          break;
        }
      }

      const signature = buildCompactSignature(rows, startIdx, range.headerEndIdx, false);
      items.push({
        kind: semiCandidate[1],
        name: semiCandidate[2],
        signature,
        startLine: startIdx + 1 + offset,
        endLine: range.endIdx + 1 + offset,
        depth: scopeStack.length,
      });
      return { jumpToLine: range.endIdx };
    },
  });
}

module.exports = {
  id: ID,
  extensions: EXTENSIONS,
  parse,
};
