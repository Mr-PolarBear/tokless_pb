'use strict';

const {
  preprocessBraceLines,
  findMatchingForward,
} = require('../../core/lexer');
const {
  stripLeadingAttributesAndAnnotations,
  matchContainerHeader,
  scanBraceLanguage,
} = require('../../core/block-anchor');

const ID = 'kotlin';
const EXTENSIONS = ['.kt', '.kts'];
const KOTLIN_CONTAINERS = new Set(['class', 'interface', 'object', 'enum']);

function extractKotlinFunName(coreHeader) {
  const funMatch = coreHeader.match(
    /^(?:(?:public|private|protected|internal|open|abstract|override|final|suspend|inline|infix|operator|tailrec|external|actual|expect)\s+)*fun\b\s*([\s\S]*)$/
  );
  if (!funMatch) return null;
  let rest = funMatch[1].trimStart();
  if (rest.startsWith('<')) {
    let angle = 0;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '<') angle++;
      else if (rest[i] === '>') {
        angle--;
        if (angle === 0) {
          rest = rest.slice(i + 1).trimStart();
          break;
        }
      }
    }
  }
  const parenIdx = rest.indexOf('(');
  const head = (parenIdx !== -1 ? rest.slice(0, parenIdx) : rest.split(/[=:]/)[0]).trim();
  if (!head) return null;
  const extMatch = head.match(/([A-Za-z_][\w.]*(?:<[^>]*>)?\??\.[A-Za-z_`][\w`]*|[A-Za-z_`][\w`]*)$/);
  if (!extMatch) return null;
  return extMatch[1].replace(/\s+/g, '');
}

function parse(lines, ext = '.kt', options = {}) {
  if (ext && typeof ext === 'object') {
    options = ext;
    ext = '.kt';
  }
  const lineOffset = options.lineOffset || 0;
  const analyzed = preprocessBraceLines(lines, 'kotlin');

  return scanBraceLanguage(analyzed, {
    lexer: 'kotlin',
    containers: KOTLIN_CONTAINERS,
    javaStyleEnum: true,
    lineOffset,
    mapCallableKind(callable, scopeStack) {
      if (scopeStack.length === 0 && callable.kind === 'function') {
        return 'fun';
      }
      return callable.kind;
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
      const core = stripLeadingAttributesAndAnnotations(trimmed);
      if (!core) return null;

      const container = matchContainerHeader(core, KOTLIN_CONTAINERS);
      if (container) {
        const range = findDeclarationRange(rows, lineIdx, 'kotlin');
        if (!range.hasBlock) {
          const signature = buildCompactSignature(rows, lineIdx, range.headerEndIdx, false);
          items.push({
            kind: container.kind,
            name: container.name,
            signature,
            startLine: lineIdx + 1 + offset,
            endLine: range.endIdx + 1 + offset,
            depth: scopeStack.length,
          });
          return { jumpToLine: range.endIdx };
        }
        return null;
      }

      if (/\bfun\b/.test(core)) {
        const range = findDeclarationRange(rows, lineIdx, 'kotlin');
        const headerText = stripLeadingAttributesAndAnnotations(
          rows
            .slice(lineIdx, range.headerEndIdx + 1)
            .map((r) => r.clean)
            .join(' ')
        );
        const funName = extractKotlinFunName(headerText);
        if (!funName) return null;

        // 陷阱: Kotlin 单表达式函数 `fun f() = run { ... }` 右值带尾随 Lambda 花括号，以及扩展函数 `Type.foo()` 统一在此精确定名
        let isExprBodyOrAbstract = !range.hasBlock;
        if (range.hasBlock) {
          const firstOpenParen = headerText.indexOf('(');
          if (firstOpenParen !== -1) {
            let p = 0;
            let closeIdx = -1;
            for (let k = firstOpenParen; k < headerText.length; k++) {
              if (headerText[k] === '(') p++;
              else if (headerText[k] === ')') {
                p--;
                if (p === 0) {
                  closeIdx = k;
                  break;
                }
              }
            }
            if (closeIdx !== -1) {
              const afterParams = headerText.slice(closeIdx + 1).split('{')[0];
              if (afterParams.includes('=')) {
                isExprBodyOrAbstract = true;
              }
            }
          }
        }

        if (isExprBodyOrAbstract || funName.includes('.')) {
          let endIdx = range.endIdx;
          if (range.hasBlock && isExprBodyOrAbstract) {
            const braceLineClean = rows[range.headerEndIdx].clean;
            const braceCol = braceLineClean.indexOf('{');
            if (braceCol !== -1) {
              const closeBrace = findMatchingForward(rows, range.headerEndIdx, braceCol, '{', '}');
              if (closeBrace) endIdx = closeBrace.line;
            }
          }
          let sig = buildCompactSignature(rows, lineIdx, range.headerEndIdx, range.hasBlock);
          if (isExprBodyOrAbstract && sig.includes('=')) {
            sig = sig.replace(/\s*=\s*[^=]*$/, '').trim() || sig;
          }
          items.push({
            kind: scopeStack.length > 0 ? 'method' : 'fun',
            name: funName,
            signature: sig,
            startLine: lineIdx + 1 + offset,
            endLine: endIdx + 1 + offset,
            depth: scopeStack.length,
          });
          return { jumpToLine: endIdx };
        }
      }

      return null;
    },
  });
}

module.exports = {
  id: ID,
  extensions: EXTENSIONS,
  parse,
};
