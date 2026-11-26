'use strict';

const {
  preprocessBraceLines,
  hasTopLevelChar,
} = require('../../core/lexer');
const {
  DEFAULT_CONTROL_KEYWORDS,
  stripLeadingAttributesAndAnnotations,
  scanBraceLanguage,
} = require('../../core/block-anchor');
const { parseCCpp } = require('./c-cpp-parser');

const ID = 'c-family';
const EXTENSIONS = [
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
];
const CS_CONTAINERS = new Set(['class', 'struct', 'interface', 'enum', 'record', 'namespace']);

function parseCSharp(lines, lineOffset = 0) {
  const analyzed = preprocessBraceLines(lines, 'c');

  return scanBraceLanguage(analyzed, {
    lexer: 'c',
    containers: CS_CONTAINERS,
    lineOffset,
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
      if (!trimmed || trimmed.startsWith('#')) return null;

      const core = stripLeadingAttributesAndAnnotations(trimmed);
      if (!core) return null;

      const activeScope = scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : null;
      const inTypeScope =
        activeScope !== null && activeScope.kind !== 'namespace' && activeScope.kind !== 'enum';

      if (inTypeScope) {
        const propMatch = core.match(
          /^(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|readonly|new|required|unsafe)\s+)+[\w.<>,?\[\]\s]+\s+([A-Za-z_]\w*)\s*(?:\{|=>)/
        );
        if (propMatch && !DEFAULT_CONTROL_KEYWORDS.has(propMatch[1])) {
          const beforeBraceOrArrow = core.split(/\{|=>/)[0];
          if (!beforeBraceOrArrow.includes('(') && !hasTopLevelChar(beforeBraceOrArrow, '=')) {
            const range = findDeclarationRange(rows, lineIdx, 'c');
            const signature = buildCompactSignature(
              rows,
              lineIdx,
              range.headerEndIdx,
              range.hasBlock
            );
            items.push({
              kind: 'property',
              name: propMatch[1],
              signature,
              startLine: lineIdx + 1 + offset,
              endLine: range.endIdx + 1 + offset,
              depth: scopeStack.length,
            });
            return { jumpToLine: range.endIdx };
          }
        }
      }

      if (activeScope && activeScope.kind === 'interface') {
        const range = findDeclarationRange(rows, lineIdx, 'c');
        if (range.hasBlock) return null;

        const joined = stripLeadingAttributesAndAnnotations(
          rows
            .slice(lineIdx, range.endIdx + 1)
            .map((r) => r.clean)
            .join(' ')
        ).trim();
        if (!joined.endsWith(';')) return null;

        const parenIdx = joined.indexOf('(');
        if (parenIdx <= 0) return null;
        const beforeParen = joined.slice(0, parenIdx).trim();
        if (hasTopLevelChar(beforeParen, '=')) return null;

        const nm = beforeParen.match(/([A-Za-z_]\w*)$/);
        if (!nm || DEFAULT_CONTROL_KEYWORDS.has(nm[1])) return null;
        const prefix = beforeParen.slice(0, beforeParen.length - nm[1].length).trim();
        if (!prefix) return null;

        const signature = buildCompactSignature(rows, lineIdx, range.headerEndIdx, false);
        items.push({
          kind: 'method',
          name: nm[1],
          signature,
          startLine: lineIdx + 1 + offset,
          endLine: range.endIdx + 1 + offset,
          depth: scopeStack.length,
        });
        return { jumpToLine: range.endIdx };
      }

      return null;
    },
  });
}

function parse(lines, ext = '.c', options = {}) {
  if (ext && typeof ext === 'object') {
    options = ext;
    ext = '.c';
  }
  const normalizedExt = String(ext || '.c').toLowerCase();
  const lineOffset = options.lineOffset || 0;

  if (normalizedExt === '.cs') {
    return parseCSharp(lines, lineOffset);
  }
  return parseCCpp(lines, normalizedExt, options);
}

module.exports = {
  id: ID,
  extensions: EXTENSIONS,
  parse,
};
