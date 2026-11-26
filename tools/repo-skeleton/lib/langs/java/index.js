'use strict';

const {
  preprocessBraceLines,
  findMatchingForward,
  skipWhitespaceForward,
  stripLeadingAnnotationsOnText,
  hasTopLevelChar,
} = require('../../core/lexer');
const { scanBraceLanguage } = require('../../core/block-anchor');

const ID = 'java';
const EXTENSIONS = ['.java'];
const JAVA_CONTAINERS = new Set(['class', 'interface', '@interface', 'enum', 'record']);

function neutralizeAnnotationBraces(lines) {
  const analyzed = preprocessBraceLines(lines, 'java');
  let mutated = false;

  for (let line = 0; line < analyzed.length; line++) {
    const clean = analyzed[line].clean;
    for (let col = 0; col < clean.length; col++) {
      if (clean[col] !== '@') continue;
      if (/^@interface\b/.test(clean.slice(col))) continue;
      const nameMatch = clean.slice(col + 1).match(/^\s*([A-Za-z_$][\w$.]*)/);
      if (!nameMatch) continue;
      const afterNameCol = col + 1 + nameMatch[0].length;
      const next = skipWhitespaceForward(
        analyzed,
        line,
        afterNameCol,
        Math.min(analyzed.length - 1, line + 1)
      );
      if (!next || next.ch !== '(') continue;
      const closePos = findMatchingForward(analyzed, next.line, next.col, '(', ')');
      if (!closePos) continue;

      // 陷阱: 注解实参内的数组或 Lambda 花括号（如 `@RequestMapping(value = {"/a", "/b"})`）会扰乱类体 braceStart 深度，需先抹平为空格
      for (let rLine = next.line; rLine <= closePos.line; rLine++) {
        const cStr = analyzed[rLine].clean;
        const cStart = rLine === next.line ? next.col + 1 : 0;
        const cEnd = rLine === closePos.line ? closePos.col - 1 : cStr.length - 1;
        if (cStart > cEnd) continue;
        let chars = null;
        for (let k = cStart; k <= cEnd; k++) {
          if (cStr[k] === '{' || cStr[k] === '}' || cStr[k] === ';') {
            if (!chars) chars = cStr.split('');
            chars[k] = ' ';
            mutated = true;
          }
        }
        if (chars) {
          analyzed[rLine].clean = chars.join('');
        }
      }

      line = closePos.line;
      col = closePos.col;
    }
  }

  if (mutated) {
    let brace = 0;
    for (let i = 0; i < analyzed.length; i++) {
      analyzed[i].braceStart = brace;
      const c = analyzed[i].clean;
      for (let k = 0; k < c.length; k++) {
        if (c[k] === '{') brace++;
        else if (c[k] === '}') brace = Math.max(0, brace - 1);
      }
      analyzed[i].braceEnd = brace;
    }
  }

  return analyzed;
}

function parse(lines, ext = '.java', options = {}) {
  if (ext && typeof ext === 'object') {
    options = ext;
    ext = '.java';
  }
  const lineOffset = options.lineOffset || 0;
  const analyzed = neutralizeAnnotationBraces(lines);

  return scanBraceLanguage(analyzed, {
    lexer: 'java',
    containers: JAVA_CONTAINERS,
    javaStyleEnum: true,
    javaCompactRecordConstructor: true,
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
      const activeScope = scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : null;
      if (!activeScope || (activeScope.kind !== 'interface' && activeScope.kind !== '@interface')) {
        return null;
      }
      const trimmed = rows[lineIdx].clean.trim();
      if (!trimmed || trimmed.startsWith('@')) {
        const stripped = stripLeadingAnnotationsOnText(trimmed).rest;
        if (!stripped) return null;
      }
      const range = findDeclarationRange(rows, lineIdx, 'java');
      if (range.hasBlock) return null;

      const joinedClean = rows
        .slice(lineIdx, range.endIdx + 1)
        .map((r) => r.clean)
        .join(' ')
        .trim();
      if (!joinedClean.endsWith(';')) return null;

      const withoutAnnos = stripLeadingAnnotationsOnText(joinedClean).rest;
      const openParen = withoutAnnos.indexOf('(');
      if (openParen <= 0) return null;
      const beforeParen = withoutAnnos.slice(0, openParen).trim();
      if (hasTopLevelChar(beforeParen, '=')) return null;

      const nameMatch = beforeParen.match(/([A-Za-z_$][\w$]*)$/);
      if (!nameMatch) return null;
      const prefix = beforeParen.slice(0, beforeParen.length - nameMatch[1].length).trim();
      if (!prefix) return null;

      const signature = buildCompactSignature(rows, lineIdx, range.headerEndIdx, false);
      items.push({
        kind: 'method',
        name: nameMatch[1],
        signature,
        startLine: lineIdx + 1 + offset,
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
