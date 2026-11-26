'use strict';

const {
  preprocessBraceLines,
  findMatchingForward,
  findMatchingBackward,
  skipWhitespaceBackward,
  stripLeadingAnnotationsOnText,
  sliceCleanRange,
  hasTopLevelChar,
} = require('./lexer');

const DEFAULT_CONTROL_KEYWORDS = new Set([
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'catch',
  'finally',
  'try',
  'with',
  'synchronized',
  'when',
  'match',
  'loop',
  'using',
  'lock',
  'fixed',
  'checked',
  'unchecked',
  'return',
  'throw',
  'new',
  'typeof',
  'delete',
  'await',
  'yield',
  'sizeof',
  'alignof',
  'decltype',
  'static_assert',
]);

const DEFAULT_CONTAINERS = new Set([
  'class',
  'interface',
  '@interface',
  'enum',
  'record',
  'struct',
  'trait',
  'impl',
  'namespace',
  'module',
  'mod',
  'object',
]);

const DEFAULT_TRAILING_KEYWORDS = new Set([
  'throws',
  'const',
  'noexcept',
  'override',
  'final',
  'volatile',
  'mutable',
  'ref',
  'where',
  'pure',
  'default',
  'delete',
  'requires',
]);

function findDeclarationRange(analyzed, startIdx, options = {}) {
  const lang = typeof options === 'string' ? options : options.lang || '';
  const allowThrows = options.allowThrows !== false && (lang === 'c' || lang === 'java' || !lang);
  const allowWhere = options.allowWhere !== false && (lang === 'rust' || lang === 'c' || lang === 'kotlin' || !lang);

  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let blockStarted = false;
  let headerEndIdx = startIdx;

  for (let j = startIdx; j < analyzed.length; j++) {
    const line = analyzed[j].clean;
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (ch === '(') paren++;
      else if (ch === ')') paren = Math.max(0, paren - 1);
      else if (ch === '[') bracket++;
      else if (ch === ']') bracket = Math.max(0, bracket - 1);
      else if (ch === '{') {
        if (!blockStarted && paren === 0 && bracket === 0) {
          blockStarted = true;
          headerEndIdx = j;
        }
        brace++;
      } else if (ch === '}') {
        brace = Math.max(0, brace - 1);
        if (blockStarted && brace === 0) {
          // 陷阱: TS 函数返回对象字面量类型 `: { a: string } {` 同一行紧跟真实函数体 `{` 时不能提前截断
          const rest = line.slice(k + 1).trim();
          if (rest.startsWith('{') || rest.startsWith('=>')) {
            blockStarted = false;
          } else {
            return { endIdx: j, headerEndIdx, hasBlock: true };
          }
        }
      }
    }

    if (blockStarted && brace === 0) {
      return { endIdx: j, headerEndIdx, hasBlock: true };
    }

    if (!blockStarted && brace === 0 && paren === 0 && bracket === 0) {
      const trimmed = line.trim();
      if (trimmed.endsWith(';')) {
        return { endIdx: j, headerEndIdx: j, hasBlock: false };
      }
      if (
        trimmed.endsWith('=>') ||
        trimmed.endsWith('=') ||
        trimmed.endsWith(':') ||
        trimmed.endsWith(',') ||
        trimmed.endsWith('(') ||
        trimmed.endsWith('|') ||
        trimmed.endsWith('&') ||
        trimmed.endsWith('->') ||
        trimmed.startsWith('@') ||
        /\b(?:extends|implements|permits|throws|where)\s*$/.test(trimmed)
      ) {
        continue;
      }

      let nextTrimmed = '';
      for (let n = j + 1; n < analyzed.length && n <= j + 4; n++) {
        const t = analyzed[n].clean.trim();
        if (t) {
          nextTrimmed = t;
          break;
        }
      }
      if (
        nextTrimmed.startsWith('{') ||
        nextTrimmed.startsWith('=>') ||
        nextTrimmed.startsWith('|') ||
        nextTrimmed.startsWith('&') ||
        nextTrimmed.startsWith('->') ||
        nextTrimmed.startsWith(':') ||
        (allowThrows && /^(?:throws|extends|implements|permits)\b/.test(nextTrimmed)) ||
        (allowWhere && /^where\b/.test(nextTrimmed))
      ) {
        continue;
      }

      return { endIdx: j, headerEndIdx: j, hasBlock: false };
    }
  }

  return { endIdx: analyzed.length - 1, headerEndIdx, hasBlock: blockStarted };
}

function buildCompactSignature(analyzed, startIdx, headerEndIdx, hasBlock, maxLen = 140, cutPos = null) {
  let sig = '';

  if (hasBlock) {
    let cutLine = cutPos ? cutPos.line : -1;
    let cutCol = cutPos ? cutPos.col : -1;

    if (cutLine === -1) {
      let p = 0;
      let b = 0;
      for (let i = startIdx; i <= headerEndIdx; i++) {
        const cleanLine = analyzed[i].clean;
        for (let k = 0; k < cleanLine.length; k++) {
          const ch = cleanLine[k];
          if (ch === '(') p++;
          else if (ch === ')') p = Math.max(0, p - 1);
          else if (ch === '[') b++;
          else if (ch === ']') b = Math.max(0, b - 1);
          else if (ch === '{' && p === 0 && b === 0) {
            const after = cleanLine.slice(k + 1);
            const closeIdx = after.indexOf('}');
            if (closeIdx !== -1 && after.slice(closeIdx + 1).trim().startsWith('{')) {
              continue;
            }
            cutLine = i;
            cutCol = k;
            break;
          }
        }
        if (cutLine !== -1) break;
      }
    }

    const effectiveEnd = cutLine !== -1 ? cutLine : headerEndIdx;
    const parts = [];
    for (let i = startIdx; i <= effectiveEnd; i++) {
      let rawLine = analyzed[i].raw;
      if (i === cutLine && cutCol !== -1) {
        rawLine = rawLine.slice(0, cutCol);
      }
      const trimmed = rawLine.trim();
      if (trimmed) parts.push(trimmed);
    }
    sig = parts.join(' ').replace(/\s+/g, ' ').trim();
  } else {
    const parts = [];
    for (let i = startIdx; i <= headerEndIdx; i++) {
      const trimmed = analyzed[i].raw.trim();
      if (trimmed) parts.push(trimmed);
    }
    sig = parts.join(' ').replace(/\s+/g, ' ').replace(/;+\s*$/, '').trim();
  }

  if (maxLen > 0 && sig.length > maxLen) {
    sig = sig.slice(0, maxLen - 3).trimEnd() + '...';
  }
  return sig;
}

function findStatementStart(analyzed, fromLine, fromCol, minLine, targetDepth) {
  let startLine = fromLine;
  let startCol = 0;

  let paren = 0;
  let bracket = 0;
  let foundBoundary = false;

  for (let line = fromLine; line >= minLine; line--) {
    const info = analyzed[line];
    const clean = info.clean;
    const kStart = line === fromLine ? fromCol - 1 : clean.length - 1;

    for (let col = kStart; col >= 0; col--) {
      const ch = clean[col];
      if (ch === ')') paren++;
      else if (ch === '(') paren = Math.max(0, paren - 1);
      else if (ch === ']') bracket++;
      else if (ch === '[') bracket = Math.max(0, bracket - 1);
      else if (paren === 0 && bracket === 0 && (ch === ';' || ch === '{' || ch === '}')) {
        startLine = line;
        startCol = col + 1;
        foundBoundary = true;
        break;
      }
    }
    if (foundBoundary) break;

    if (line < fromLine && paren === 0 && bracket === 0) {
      const trimmed = clean.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        startLine = line + 1;
        startCol = 0;
        foundBoundary = true;
        break;
      }
      if (info.braceStart !== targetDepth && info.braceEnd !== targetDepth) {
        startLine = line + 1;
        startCol = 0;
        foundBoundary = true;
        break;
      }
    }
  }

  if (!foundBoundary) {
    startLine = minLine;
    startCol = 0;
  }

  while (startLine < fromLine || (startLine === fromLine && startCol < fromCol)) {
    const rest = analyzed[startLine].clean.slice(startCol);
    if (rest.trim() !== '' && !rest.trim().startsWith('#')) {
      const leadWs = rest.match(/^\s*/)[0].length;
      startCol += leadWs;
      break;
    }
    startLine++;
    startCol = 0;
  }

  // 陷阱: 注解/属性行与声明头分行书写时需向上合并，否则生成的方法签名会丢失 `@Auth(...)` / `#[derive]` 且行号偏晚
  if (startCol === (analyzed[startLine].clean.match(/^\s*/)[0].length)) {
    let probe = startLine - 1;
    while (probe >= minLine) {
      const pInfo = analyzed[probe];
      const pTrim = pInfo.clean.trim();
      if (!pTrim) break;
      if (pInfo.braceEnd === targetDepth && pTrim.endsWith(')') && pInfo.parenStart > 0) {
        const openParen = findMatchingBackward(analyzed, probe, pInfo.clean.lastIndexOf(')'), ')', '(', minLine);
        if (openParen) {
          const headTrim = analyzed[openParen.line].clean.slice(0, openParen.col).trim();
          if (/^(?:@[A-Za-z_$][\w$.:]*|#\s*\[|[A-Za-z_][\w.]*\s*$)/.test(headTrim)) {
            startLine = openParen.line;
            startCol = analyzed[startLine].clean.match(/^\s*/)[0].length;
            probe = openParen.line - 1;
            continue;
          }
        }
      }
      if (
        pInfo.braceStart === targetDepth &&
        (/^@[A-Za-z_$]/.test(pTrim) || /^#!?\[/.test(pTrim) || /^\[[A-Za-z_]/.test(pTrim)) &&
        !pTrim.endsWith(';') &&
        !pTrim.endsWith('{') &&
        !pTrim.endsWith('}')
      ) {
        startLine = probe;
        startCol = analyzed[startLine].clean.match(/^\s*/)[0].length;
        probe--;
        continue;
      }
      break;
    }
  }

  return { line: startLine, col: startCol };
}

function stripLeadingAttributesAndAnnotations(text) {
  let s = text;
  while (s.length > 0) {
    s = s.trimStart();
    if (s.startsWith('@') && !/^@interface\b/.test(s)) {
      const stripped = stripLeadingAnnotationsOnText(s);
      if (stripped.offset > 0) {
        s = stripped.rest;
        continue;
      }
      break;
    }
    if (s.startsWith('#[') || s.startsWith('#![') || (s.startsWith('[') && /^\[[A-Za-z_]/.test(s))) {
      const openIdx = s.indexOf('[');
      let depth = 0;
      let endIdx = -1;
      for (let i = openIdx; i < s.length; i++) {
        if (s[i] === '[') depth++;
        else if (s[i] === ']') {
          depth--;
          if (depth === 0) {
            endIdx = i;
            break;
          }
        }
      }
      if (endIdx !== -1) {
        s = s.slice(endIdx + 1);
        continue;
      }
    }
    break;
  }
  return s.trimStart();
}

function matchContainerHeader(headerClean, containersSet) {
  const core = stripLeadingAttributesAndAnnotations(headerClean);
  if (!core) return null;
  if (hasTopLevelChar(core, '=')) return null;

  const annoTypeMatch = core.match(
    /^(?:(?:public|private|protected|internal|abstract|final|static|strictfp)\s+)*(@interface)\s+([A-Za-z_$][\w$]*)\b/
  );
  if (annoTypeMatch && containersSet.has('@interface')) {
    return { kind: '@interface', name: annoTypeMatch[2] };
  }

  if (containersSet.has('impl')) {
    const implMatch = core.match(/^(?:(?:pub(?:\s*\([^)]*\))?|unsafe|default|const)\s+)*impl\b([\s\S]*)$/);
    if (implMatch) {
      const rawRest = implMatch[1].replace(/\bwhere\b[\s\S]*$/, '').replace(/\s+/g, ' ').trim();
      return { kind: 'impl', name: rawRest || 'impl' };
    }
  }

  if (containersSet.has('object')) {
    const objMatch = core.match(
      /^(?:(?:public|private|protected|internal|data|sealed|external)\s+)*(?:companion\s+)?object(?:\s+([A-Za-z_$][\w$]*))?(?:\s*:|\s*$)/
    );
    if (objMatch) {
      return { kind: 'object', name: objMatch[1] || 'companion' };
    }
  }

  const goTypeMatch = core.match(/^type\s+([A-Za-z_]\w*)\s+(struct|interface)\b/);
  if (goTypeMatch && containersSet.has(goTypeMatch[2])) {
    return { kind: goTypeMatch[2], name: goTypeMatch[1] };
  }

  const kwRegex =
    /^(?:(?:public|private|protected|internal|export|default|declare|abstract|final|static|sealed|non-sealed|open|data|value|inline|inner|fun|partial|unsafe|extern|pub(?:\s*\([^)]*\))?|async|const|template\s*<[^>]*>)\s+)*(@interface|class|interface|enum\s+class|enum\s+struct|enum|record|struct|trait|namespace|module|mod|union)\s+([A-Za-z_$][\w$.:]*)/;
  const m = core.match(kwRegex);
  if (!m) return null;

  let rawKind = m[1].replace(/\s+/g, ' ');
  if (rawKind === 'enum class' || rawKind === 'enum struct') rawKind = 'enum';
  if (!containersSet.has(rawKind)) return null;

  return { kind: rawKind, name: m[2] };
}

function skipTrailingClausesBackward(analyzed, braceLine, braceCol, minLine, profile) {
  const trailingKw = profile.trailingKeywords || DEFAULT_TRAILING_KEYWORDS;
  let cur = skipWhitespaceBackward(analyzed, braceLine, braceCol - 1, minLine);
  if (!cur) return null;

  let guard = 0;
  while (cur && guard++ < 40) {
    if (cur.ch === ')') {
      const openPos = findMatchingBackward(analyzed, cur.line, cur.col, ')', '(', minLine);
      if (!openPos) return null;
      const beforeOpen = skipWhitespaceBackward(analyzed, openPos.line, openPos.col - 1, minLine);
      if (beforeOpen) {
        const linePrefix = analyzed[beforeOpen.line].clean.slice(0, beforeOpen.col + 1);
        const wordMatch = linePrefix.match(/([A-Za-z_~][\w$]*)\s*$/);
        const word = wordMatch ? wordMatch[1] : '';
        if (word === 'noexcept' || word === 'throw' || word === 'requires') {
          const wordCol = beforeOpen.col + 1 - wordMatch[0].length;
          cur = skipWhitespaceBackward(analyzed, beforeOpen.line, wordCol - 1, minLine);
          continue;
        }
        // 陷阱: C++/Kotlin 构造器委托 `: Base(a)` 与 Go 多返回值 `(int, error)` 会紧贴 `{`，需继续向左回退定位真实形参 `(...)`
        const colonCheck = sliceCleanRange(analyzed, minLine, 0, openPos.line, openPos.col - 1);
        if (/\)\s*:\s*[A-Za-z_][\w:.,\s<>()]*$/.test(colonCheck)) {
          const colonIdx = colonCheck.lastIndexOf(':');
          const prefixBeforeColon = colonCheck.slice(0, colonIdx);
          const linesBefore = prefixBeforeColon.split('\n');
          const targetLine = minLine + linesBefore.length - 1;
          const targetCol = linesBefore[linesBefore.length - 1].length - 1;
          cur = skipWhitespaceBackward(analyzed, targetLine, targetCol, minLine);
          continue;
        }
        if (beforeOpen.ch === ')') {
          const prevOpen = findMatchingBackward(analyzed, beforeOpen.line, beforeOpen.col, ')', '(', minLine);
          if (prevOpen) {
            const beforePrevOpen = sliceCleanRange(analyzed, minLine, 0, prevOpen.line, prevOpen.col - 1).trim();
            if (!/^func$/.test(beforePrevOpen)) {
              cur = beforeOpen;
              continue;
            }
          }
        }
      }
      return { closeParen: cur, openParen: openPos };
    }

    if (cur.ch === '>') {
      const lineBefore = analyzed[cur.line].clean.slice(0, cur.col + 1);
      if (/->\s*$/.test(lineBefore)) {
        cur = skipWhitespaceBackward(analyzed, cur.line, cur.col - 2, minLine);
        continue;
      }
      const openAngle = findMatchingBackward(analyzed, cur.line, cur.col, '>', '<', minLine);
      if (!openAngle) break;
      cur = skipWhitespaceBackward(analyzed, openAngle.line, openAngle.col - 1, minLine);
      continue;
    }

    if (cur.ch === ']') {
      const openBracket = findMatchingBackward(analyzed, cur.line, cur.col, ']', '[', minLine);
      if (!openBracket) break;
      cur = skipWhitespaceBackward(analyzed, openBracket.line, openBracket.col - 1, minLine);
      continue;
    }

    const lineSlice = analyzed[cur.line].clean.slice(0, cur.col + 1);
    const arrowMatch = lineSlice.match(/(?:->|:|::|,|\?|&|\*|\+|\||!)\s*$/);
    if (arrowMatch) {
      cur = skipWhitespaceBackward(
        analyzed,
        cur.line,
        cur.col + 1 - arrowMatch[0].length - 1,
        minLine
      );
      continue;
    }

    const tokenMatch = lineSlice.match(/([A-Za-z_$][\w$.:]*)\s*$/);
    if (tokenMatch) {
      const word = tokenMatch[1];
      const nextPos = skipWhitespaceBackward(
        analyzed,
        cur.line,
        cur.col + 1 - tokenMatch[0].length - 1,
        minLine
      );
      if (!nextPos) return null;
      if (
        trailingKw.has(word) ||
        nextPos.ch === ')' ||
        nextPos.ch === ',' ||
        nextPos.ch === ':' ||
        nextPos.ch === '>' ||
        nextPos.ch === '&' ||
        nextPos.ch === '*' ||
        nextPos.ch === '?' ||
        nextPos.ch === '.' ||
        nextPos.ch === '+' ||
        nextPos.ch === '|' ||
        nextPos.ch === "'"
      ) {
        cur = nextPos;
        continue;
      }
      const prevSlice = analyzed[nextPos.line].clean.slice(0, nextPos.col + 1);
      if (/(?:->|\bthrows|\bwhere|\bimpl|\bdyn|\bfor|\bconst|\bmut|\blifetime)\s*$/.test(prevSlice) || /'[A-Za-z_]\w*\s*$/.test(prevSlice)) {
        cur = nextPos;
        continue;
      }
      return null;
    }

    if (cur.ch === "'") {
      cur = skipWhitespaceBackward(analyzed, cur.line, cur.col - 1, minLine);
      continue;
    }

    break;
  }

  return null;
}

function extractCallableFromBeforeParen(beforeParenClean, controlKeywords, inContainer) {
  const core = stripLeadingAttributesAndAnnotations(beforeParenClean).trim();
  if (!core) return null;

  // 陷阱: 语句顶层含 `=` 属于字段匿名类初始化（如 `Runnable r = new Runnable() {}`），但须放行 C++ `operator=` / `operator==`
  const withoutOperatorEq = core.replace(/\boperator\s*==?\b/g, 'operator_eq');
  if (hasTopLevelChar(withoutOperatorEq, '=')) return null;
  if (/\bnew\s+[A-Za-z_$][\w$.:<>?\s,]*$/.test(core)) return null;

  const firstWordMatch = core.match(/^([A-Za-z_$][\w$]*)\b/);
  if (firstWordMatch && controlKeywords.has(firstWordMatch[1])) {
    return null;
  }

  const goRecvMatch = core.match(/^func\s*\([^)]*\)\s*([A-Za-z_]\w*)$/);
  if (goRecvMatch) {
    return { kind: 'func', name: goRecvMatch[1] };
  }

  const opMatch = core.match(/\b(operator\s*(?:\(\)|\[\]|[^\s(]+))\s*$/);
  if (opMatch) {
    return { kind: inContainer ? 'method' : 'function', name: opMatch[1].replace(/\s+/g, '') };
  }

  let target = core;
  if (target.endsWith('>')) {
    let angle = 0;
    for (let i = target.length - 1; i >= 0; i--) {
      if (target[i] === '>') angle++;
      else if (target[i] === '<') {
        angle--;
        if (angle === 0) {
          target = target.slice(0, i).trimEnd();
          break;
        }
      }
    }
  }

  const nameMatch = target.match(/([~A-Za-z_$][\w$]*)$/);
  if (!nameMatch) return null;
  const name = nameMatch[1];
  if (controlKeywords.has(name)) return null;

  const prefix = target.slice(0, target.length - name.length).trim();
  if (/\bfn$/.test(prefix)) return { kind: inContainer ? 'method' : 'fn', name };
  if (/\bfunc$/.test(prefix)) return { kind: inContainer ? 'method' : 'func', name };
  if (/\bfun$/.test(prefix) || /\bfun\s*<[^>]*>$/.test(prefix)) {
    return { kind: inContainer ? 'method' : 'fun', name };
  }

  return { kind: inContainer ? 'method' : 'function', name };
}

function findEnumConstantsSemicolon(analyzed, bodyStartLine, bodyStartCol, enumEndLine, enumBodyDepth) {
  for (let line = bodyStartLine; line <= enumEndLine; line++) {
    const clean = analyzed[line].clean;
    const kStart = line === bodyStartLine ? bodyStartCol : 0;
    let curDepth = line === bodyStartLine ? enumBodyDepth : analyzed[line].braceStart;
    let paren = line === bodyStartLine ? 0 : analyzed[line].parenStart;

    for (let col = kStart; col < clean.length; col++) {
      const ch = clean[col];
      if (ch === '{') curDepth++;
      else if (ch === '}') {
        curDepth--;
        if (curDepth < enumBodyDepth) return null;
      } else if (ch === '(') paren++;
      else if (ch === ')') paren = Math.max(0, paren - 1);
      else if (ch === ';' && curDepth === enumBodyDepth && paren === 0) {
        return { line, col };
      }
    }
  }
  return null;
}

function scanBraceLanguage(lines, profile = {}) {
  const analyzed = Array.isArray(lines) && lines.length > 0 && typeof lines[0] === 'object' && 'clean' in lines[0]
    ? lines
    : preprocessBraceLines(lines, profile.lexer || 'c');

  const containersSet = profile.containers instanceof Set
    ? profile.containers
    : new Set(profile.containers || DEFAULT_CONTAINERS);
  const controlKeywords = profile.controlKeywords instanceof Set
    ? profile.controlKeywords
    : new Set([...DEFAULT_CONTROL_KEYWORDS, ...(profile.controlKeywords || [])]);
  const lineOffset = profile.lineOffset || 0;
  const maxSigLen = profile.maxSignatureLength || 140;

  const items = [];
  const scopeStack = [];
  let minStatementLine = 0;

  for (let i = 0; i < analyzed.length; i++) {
    while (scopeStack.length > 0 && i > scopeStack[scopeStack.length - 1].endIdx) {
      scopeStack.pop();
    }

    const activeScope = scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : null;
    const expectedDepth = activeScope ? activeScope.bodyDepth : 0;
    const info = analyzed[i];

    if (typeof profile.onStatementLine === 'function' && info.braceStart === expectedDepth) {
      const hookRes = profile.onStatementLine({
        analyzed,
        lineIdx: i,
        expectedDepth,
        scopeStack,
        items,
        lineOffset,
        findDeclarationRange,
        buildCompactSignature,
      });
      if (hookRes && typeof hookRes.jumpToLine === 'number') {
        minStatementLine = hookRes.jumpToLine + 1;
        i = hookRes.jumpToLine;
        continue;
      }
    }

    let curBrace = info.braceStart;
    const clean = info.clean;

    for (let col = 0; col < clean.length; col++) {
      const ch = clean[col];
      if (ch === ';') {
        if (curBrace === expectedDepth) {
          minStatementLine = i;
        }
        continue;
      }
      if (ch === '}') {
        curBrace = Math.max(0, curBrace - 1);
        if (curBrace === expectedDepth) {
          minStatementLine = i;
        }
        continue;
      }
      if (ch !== '{') continue;

      const openDepth = curBrace;
      curBrace++;

      if (openDepth !== expectedDepth) continue;

      // 陷阱: Java `enum` 首个顶层 `;` 之前的 `RED("r") { ... }` 是枚举常量实例块，必须整块跳过防内部重写方法平铺泄漏到外层
      if (
        activeScope &&
        activeScope.kind === 'enum' &&
        activeScope.enumBodyEnabledAfter &&
        (i < activeScope.enumBodyEnabledAfter.line ||
          (i === activeScope.enumBodyEnabledAfter.line && col < activeScope.enumBodyEnabledAfter.col))
      ) {
        const closeEnumConst = findMatchingForward(analyzed, i, col, '{', '}');
        if (closeEnumConst) {
          minStatementLine = closeEnumConst.line;
          i = closeEnumConst.line;
          break;
        }
        continue;
      }
      if (activeScope && activeScope.kind === 'enum' && activeScope.hasEnumMethods === false) {
        continue;
      }

      const closeBrace = findMatchingForward(analyzed, i, col, '{', '}');
      const blockEndLine = closeBrace ? closeBrace.line : analyzed.length - 1;
      const floorLine = Math.max(
        minStatementLine,
        activeScope ? activeScope.headerEndIdx : 0
      );
      const stmtStart = findStatementStart(analyzed, i, col, floorLine, expectedDepth);
      const headerClean = sliceCleanRange(analyzed, stmtStart.line, stmtStart.col, i, col - 1);

      const containerMatch = matchContainerHeader(headerClean, containersSet);
      if (containerMatch) {
        const signature = buildCompactSignature(
          analyzed,
          stmtStart.line,
          i,
          true,
          maxSigLen,
          { line: i, col }
        );
        items.push({
          kind: containerMatch.kind,
          name: containerMatch.name,
          signature,
          startLine: stmtStart.line + 1 + lineOffset,
          endLine: blockEndLine + 1 + lineOffset,
          depth: scopeStack.length,
        });

        const scopeEntry = {
          kind: containerMatch.kind,
          name: containerMatch.name,
          headerEndIdx: i,
          endIdx: blockEndLine,
          bodyDepth: expectedDepth + 1,
          hasEnumMethods: true,
          enumBodyEnabledAfter: null,
        };

        if (containerMatch.kind === 'enum' && profile.javaStyleEnum) {
          const semiPos = findEnumConstantsSemicolon(
            analyzed,
            i,
            col + 1,
            blockEndLine,
            expectedDepth + 1
          );
          if (semiPos) {
            scopeEntry.enumBodyEnabledAfter = semiPos;
          } else {
            scopeEntry.hasEnumMethods = false;
          }
        }

        scopeStack.push(scopeEntry);
        minStatementLine = i;
        break;
      }

      const parenPair = skipTrailingClausesBackward(analyzed, i, col, stmtStart.line, profile);
      if (parenPair) {
        const beforeParenClean = sliceCleanRange(
          analyzed,
          stmtStart.line,
          stmtStart.col,
          parenPair.openParen.line,
          parenPair.openParen.col - 1
        );
        const callable = extractCallableFromBeforeParen(
          beforeParenClean,
          controlKeywords,
          scopeStack.length > 0
        );
        if (callable) {
          let finalKind = callable.kind;
          if (typeof profile.mapCallableKind === 'function') {
            finalKind = profile.mapCallableKind(callable, scopeStack) || finalKind;
          }
          const signature = buildCompactSignature(
            analyzed,
            stmtStart.line,
            i,
            true,
            maxSigLen,
            { line: i, col }
          );
          items.push({
            kind: finalKind,
            name: callable.name,
            signature,
            startLine: stmtStart.line + 1 + lineOffset,
            endLine: blockEndLine + 1 + lineOffset,
            depth: scopeStack.length,
          });
          minStatementLine = blockEndLine;
          i = blockEndLine;
          break;
        }
      } else if (
        activeScope &&
        activeScope.kind === 'record' &&
        profile.javaCompactRecordConstructor
      ) {
        const compactCore = stripLeadingAttributesAndAnnotations(headerClean).trim();
        const recCtor = compactCore.match(
          /^(?:(?:public|private|protected)\s+)?([A-Za-z_$][\w$]*)$/
        );
        if (recCtor && recCtor[1] === activeScope.name) {
          const signature = buildCompactSignature(
            analyzed,
            stmtStart.line,
            i,
            true,
            maxSigLen,
            { line: i, col }
          );
          items.push({
            kind: 'method',
            name: recCtor[1],
            signature,
            startLine: stmtStart.line + 1 + lineOffset,
            endLine: blockEndLine + 1 + lineOffset,
            depth: scopeStack.length,
          });
          minStatementLine = blockEndLine;
          i = blockEndLine;
          break;
        }
      }

      // 陷阱: 非容器且非函数的代码块（如 `static { ... }` 或匿名内部类字段）必须整块跳过，否则其内部方法会在子级深度被误扫或打断外层
      if (closeBrace && closeBrace.line > i) {
        minStatementLine = closeBrace.line;
        i = closeBrace.line;
        break;
      }
    }
  }

  return items;
}

module.exports = {
  DEFAULT_CONTROL_KEYWORDS,
  DEFAULT_CONTAINERS,
  DEFAULT_TRAILING_KEYWORDS,
  findDeclarationRange,
  buildCompactSignature,
  findStatementStart,
  stripLeadingAttributesAndAnnotations,
  matchContainerHeader,
  skipTrailingClausesBackward,
  extractCallableFromBeforeParen,
  scanBraceLanguage,
};
