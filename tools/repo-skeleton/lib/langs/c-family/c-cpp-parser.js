'use strict';

const C_HEADER_EXTS = new Set(['.h', '.hpp', '.hh', '.hxx', '.h++', '.inl', '.inc']);

const C_CONTROL_KEYWORDS = new Set([
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
  '_Static_assert',
]);

/**
 * 判断 raw 字符串索引 pos 处的单引号 `'` 是否为 C++14/C23 数字分隔符（例如 1'000'000、0xFF'FF）
 * 注意排除 u8'a'、u'a'、U'a'、L'a' 等字符字面量前缀
 */
function isDigitSeparatorQuote(raw, pos) {
  if (pos <= 0 || pos + 1 >= raw.length) return false;
  if (!/[0-9a-fA-F]/.test(raw[pos + 1])) return false;
  const prefixSlice = raw.slice(0, pos);
  return /(?:^|[^A-Za-z0-9_])(?:0[xX][0-9a-fA-F]+(?:'[0-9a-fA-F]+)*|0[bB][01]+(?:'[01]+)*|[0-9]+(?:'[0-9]+)*)$/.test(
    prefixSlice
  );
}

/**
 * 判断 raw 字符串索引 pos 处是否为 C++11 Raw String 开头（如 R"delim(...)delim" / u8R"..."）
 */
function matchCppRawStringStart(raw, pos) {
  if (raw[pos] === 'R' && pos + 1 < raw.length && raw[pos + 1] === '"') {
    const prev = pos > 0 ? raw[pos - 1] : '';
    const before2 = pos >= 2 ? raw.slice(pos - 2, pos) : '';
    const before1 = pos >= 1 ? raw[pos - 1] : '';
    const prevPrev = pos >= 3 ? raw[pos - 3] : '';
    const prev1Char = pos >= 2 ? raw[pos - 2] : '';

    let validPrefix = pos === 0 || !/[A-Za-z0-9_]/.test(prev);
    if (!validPrefix && before2 === 'u8' && (pos === 2 || !/[A-Za-z0-9_]/.test(prevPrev))) {
      validPrefix = true;
    } else if (
      !validPrefix &&
      (before1 === 'u' || before1 === 'U' || before1 === 'L') &&
      (pos === 1 || !/[A-Za-z0-9_]/.test(prev1Char))
    ) {
      validPrefix = true;
    }
    if (!validPrefix) return null;

    const openParenIdx = raw.indexOf('(', pos + 2);
    if (openParenIdx === -1) return null;
    const delim = raw.slice(pos + 2, openParenIdx);
    if (delim.length > 16 || /[\s()\\]/.test(delim)) return null;
    return { endMarker: `)${delim}"`, openEndIdx: openParenIdx };
  }
  return null;
}

/**
 * C / C++ 专用词法与预处理器扫描器：
 * - 剥离注释、字符串/字符字面量、C++11 Raw String，识别 C++14/C23 数字分隔符
 * - 隔离预处理器指令行（含 `\` 续行），防止宏内花括号污染常规代码 braceDepth
 * - 维护条件编译栈，隔离 #if 0 死代码并平衡 #if/#elif/#else/#endif 多分支括号深度
 */
function preprocessCCppLines(lines) {
  const analyzed = new Array(lines.length);
  const directives = [];

  let braceDepth = 0;
  let parenDepth = 0;
  let inBlockComment = false;
  let inRawString = false;
  let rawEndMarker = '';
  let inStringQuote = null;
  let inPreprocessor = false;
  let currentDirective = null;
  const condStack = [];

  const isDisabled = () => condStack.some((c) => c.inDisabledBranch);

  function finalizeDirective() {
    if (!currentDirective) return;
    const joinedClean = currentDirective.cleanLines
      .map((s) => s.replace(/\\\s*$/, ' '))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const m = joinedClean.match(/^#\s*([A-Za-z_]\w*)(?:\s+(.*))?$/);
    const dirName = m ? m[1] : '';
    const argClean = m && m[2] ? m[2].trim() : '';

    if (dirName === 'if' || dirName === 'ifdef' || dirName === 'ifndef') {
      const parentDisabled = isDisabled();
      const isZeroCond = dirName === 'if' && /^\(?\s*0\s*\)?$/.test(argClean);
      const inDisabledBranch = parentDisabled || isZeroCond;
      condStack.push({
        entryBraceDepth: braceDepth,
        entryParenDepth: parenDepth,
        branchExitBraceDepth: null,
        branchExitParenDepth: null,
        parentDisabled,
        inDisabledBranch,
      });
    } else if (dirName === 'elif') {
      if (condStack.length > 0) {
        const top = condStack[condStack.length - 1];
        if (!top.inDisabledBranch && top.branchExitBraceDepth === null) {
          top.branchExitBraceDepth = braceDepth;
          top.branchExitParenDepth = parenDepth;
        }
        braceDepth = top.entryBraceDepth;
        parenDepth = top.entryParenDepth;
        const isZeroCond = /^\(?\s*0\s*\)?$/.test(argClean);
        top.inDisabledBranch = top.parentDisabled || isZeroCond;
      }
    } else if (dirName === 'else') {
      if (condStack.length > 0) {
        const top = condStack[condStack.length - 1];
        if (!top.inDisabledBranch && top.branchExitBraceDepth === null) {
          top.branchExitBraceDepth = braceDepth;
          top.branchExitParenDepth = parenDepth;
        }
        braceDepth = top.entryBraceDepth;
        parenDepth = top.entryParenDepth;
        top.inDisabledBranch = top.parentDisabled;
      }
    } else if (dirName === 'endif') {
      if (condStack.length > 0) {
        const top = condStack.pop();
        if (!top.inDisabledBranch && top.branchExitBraceDepth === null) {
          top.branchExitBraceDepth = braceDepth;
          top.branchExitParenDepth = parenDepth;
        }
        if (top.branchExitBraceDepth !== null) {
          braceDepth = top.branchExitBraceDepth;
          parenDepth = top.branchExitParenDepth;
        } else {
          braceDepth = top.entryBraceDepth;
          parenDepth = top.entryParenDepth;
        }
      }
    }

    currentDirective.name = dirName;
    currentDirective.argClean = argClean;
    currentDirective.joinedClean = joinedClean;
    currentDirective.disabled =
      dirName === 'if' ||
      dirName === 'ifdef' ||
      dirName === 'ifndef' ||
      dirName === 'elif' ||
      dirName === 'else' ||
      dirName === 'endif'
        ? condStack.some((c) => c.parentDisabled)
        : isDisabled();
    directives.push(currentDirective);
    currentDirective = null;
  }

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const raw = lines[lineIdx];
    const len = raw.length;
    const out = [];
    const braceStart = braceDepth;
    const parenStart = parenDepth;
    const lineDisabled = isDisabled();

    let inLineComment = false;
    let seenCodeTokenOnLine = false;
    let isDirectiveLine = inPreprocessor;

    for (let i = 0; i < len; i++) {
      const ch = raw[i];
      const next = i + 1 < len ? raw[i + 1] : '';

      if (inLineComment) {
        out.push(' ');
        continue;
      }

      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          out.push('  ');
          i++;
          inBlockComment = false;
          continue;
        }
        out.push(' ');
        continue;
      }

      if (inRawString) {
        if (raw.startsWith(rawEndMarker, i)) {
          out.push(rawEndMarker);
          i += rawEndMarker.length - 1;
          inRawString = false;
          rawEndMarker = '';
          continue;
        }
        out.push(' ');
        continue;
      }

      if (inStringQuote) {
        if (ch === '\\') {
          out.push('  ');
          i++;
          continue;
        }
        if (ch === inStringQuote) {
          out.push(ch);
          inStringQuote = null;
          continue;
        }
        out.push(' ');
        continue;
      }

      if (ch === '/' && next === '/') {
        inLineComment = true;
        out.push('  ');
        i++;
        continue;
      }

      if (ch === '/' && next === '*') {
        inBlockComment = true;
        out.push('  ');
        i++;
        continue;
      }

      if (!isDirectiveLine && !seenCodeTokenOnLine && ch === '#') {
        isDirectiveLine = true;
        inPreprocessor = true;
        currentDirective = {
          startIdx: lineIdx,
          endIdx: lineIdx,
          rawLines: [],
          cleanLines: [],
          name: '',
          argClean: '',
          joinedClean: '',
          disabled: lineDisabled,
        };
        out.push(ch);
        seenCodeTokenOnLine = true;
        continue;
      }

      const rawStart = matchCppRawStringStart(raw, i);
      if (rawStart) {
        seenCodeTokenOnLine = true;
        inRawString = true;
        rawEndMarker = rawStart.endMarker;
        out.push(raw.slice(i, rawStart.openEndIdx + 1));
        i = rawStart.openEndIdx;
        continue;
      }

      if (ch === '"') {
        seenCodeTokenOnLine = true;
        inStringQuote = '"';
        out.push('"');
        continue;
      }

      if (ch === "'") {
        seenCodeTokenOnLine = true;
        if (isDigitSeparatorQuote(raw, i)) {
          out.push("'");
          continue;
        }
        inStringQuote = "'";
        out.push("'");
        continue;
      }

      if (!/\s/.test(ch)) {
        seenCodeTokenOnLine = true;
      }

      if (!isDirectiveLine && !lineDisabled) {
        if (ch === '{') braceDepth++;
        else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
        else if (ch === '(') parenDepth++;
        else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
      }

      out.push(ch);
    }

    const hasLineContinuation = /\\\s*$/.test(raw);
    if (!hasLineContinuation && inStringQuote) {
      inStringQuote = null;
    }

    const clean = out.join('');

    if (isDirectiveLine && currentDirective) {
      currentDirective.endIdx = lineIdx;
      currentDirective.rawLines.push(raw);
      currentDirective.cleanLines.push(clean);
      if (!hasLineContinuation && !inBlockComment) {
        inPreprocessor = false;
        finalizeDirective();
      }
    }

    analyzed[lineIdx] = {
      raw,
      clean,
      braceStart,
      braceEnd: braceDepth,
      parenStart,
      parenEnd: parenDepth,
      isDirective: isDirectiveLine,
      disabled: lineDisabled,
    };
  }

  if (currentDirective) {
    inPreprocessor = false;
    finalizeDirective();
  }

  return { analyzed, directives };
}

function formatMacroSignature(rawLines, maxLen = 140) {
  const parts = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i].replace(/\/\/.*$/, '').replace(/\\\s*$/, '').trim();
    if (line) parts.push(line);
  }
  let sig = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (sig.length > maxLen) {
    sig = sig.slice(0, maxLen - 3).trimEnd() + '...';
  }
  return sig;
}

/**
 * 提取 C/C++ #define 宏（跳过 Include Guard，保留函数式宏与多行宏，智能折叠连续常量宏）
 */
function extractCCppMacros(directives, analyzed, lineOffset = 0) {
  const items = [];
  const activeDirectives = directives.filter((d) => !d.disabled);
  const singleConstMacros = [];

  for (let i = 0; i < activeDirectives.length; i++) {
    const dir = activeDirectives[i];
    if (dir.name !== 'define') continue;

    const cleanJoined = dir.joinedClean;
    const m = cleanJoined.match(/^#\s*define\s+([A-Za-z_]\w*)(?:\(([^)]*)\))?(.*)$/);
    if (!m) continue;

    const macroName = m[1];
    const hasParenArgs = m[2] !== undefined;
    const bodyClean = (m[3] || '').trim();

    if (!hasParenArgs && !bodyClean && i > 0) {
      const prev = activeDirectives[i - 1];
      if (
        (prev.name === 'ifndef' && prev.argClean === macroName) ||
        (prev.name === 'if' && new RegExp(`^!\\s*defined\\s*\\(?\\s*${macroName}\\s*\\)?$`).test(prev.argClean))
      ) {
        continue;
      }
    }

    const isMultiLine = dir.endIdx > dir.startIdx;
    if (hasParenArgs || isMultiLine) {
      items.push({
        kind: 'macro',
        name: macroName,
        signature: formatMacroSignature(dir.rawLines),
        startLine: dir.startIdx + 1 + lineOffset,
        endLine: dir.endIdx + 1 + lineOffset,
        depth: 0,
      });
    } else {
      singleConstMacros.push({
        name: macroName,
        startIdx: dir.startIdx,
        endIdx: dir.endIdx,
        signature: formatMacroSignature(dir.rawLines),
      });
    }
  }

  const groups = [];
  for (const mac of singleConstMacros) {
    if (groups.length === 0) {
      groups.push([mac]);
      continue;
    }
    const prevGroup = groups[groups.length - 1];
    const prev = prevGroup[prevGroup.length - 1];
    let contiguous = mac.startIdx - prev.endIdx <= 4;
    if (contiguous) {
      for (let lineIdx = prev.endIdx + 1; lineIdx < mac.startIdx; lineIdx++) {
        const info = analyzed[lineIdx];
        if (!info) continue;
        if (!info.isDirective && info.clean.trim() !== '') {
          contiguous = false;
          break;
        }
        if (info.isDirective && !/^#\s*define\b/.test(info.clean.trim())) {
          contiguous = false;
          break;
        }
      }
    }
    if (contiguous) {
      prevGroup.push(mac);
    } else {
      groups.push([mac]);
    }
  }

  const totalSingle = singleConstMacros.length;
  for (const group of groups) {
    if ((totalSingle <= 15 && group.length <= 3) || group.length === 1) {
      for (const mac of group) {
        items.push({
          kind: 'macro',
          name: mac.name,
          signature: mac.signature,
          startLine: mac.startIdx + 1 + lineOffset,
          endLine: mac.endIdx + 1 + lineOffset,
          depth: 0,
        });
      }
    } else {
      const anchors =
        group.length <= 4
          ? group.map((g) => g.name).join(', ')
          : `${group[0].name}, ${group[1].name}, ..., ${group[group.length - 1].name}`;
      items.push({
        kind: 'macro',
        name: group[0].name,
        signature: `#define (${group.length} macros: ${anchors})`,
        startLine: group[0].startIdx + 1 + lineOffset,
        endLine: group[group.length - 1].endIdx + 1 + lineOffset,
        depth: 0,
      });
    }
  }

  return items;
}

function findMatchingDelim(text, openIdx, openCh, closeCh) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === openCh) depth++;
    else if (text[i] === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function stripCCppAttributes(text) {
  let s = text;
  const attrPatterns = [/\b__attribute(?:__)?\s*\(/g, /\b__declspec\s*\(/g, /\balignas\s*\(/g, /\bnoexcept\s*\(/g];
  for (const re of attrPatterns) {
    let match;
    while ((match = re.exec(s)) !== null) {
      const openIdx = s.indexOf('(', match.index);
      const closeIdx = openIdx !== -1 ? findMatchingDelim(s, openIdx, '(', ')') : -1;
      if (closeIdx !== -1) {
        s = s.slice(0, match.index) + ' ' + s.slice(closeIdx + 1);
        re.lastIndex = match.index;
      } else {
        break;
      }
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    const idx = s.indexOf('[[');
    if (idx !== -1) {
      const closeIdx = s.indexOf(']]', idx + 2);
      if (closeIdx !== -1) {
        s = s.slice(0, idx) + ' ' + s.slice(closeIdx + 2);
        changed = true;
      }
    }
  }
  return s;
}

function stripLeadingTemplate(text) {
  const trimmed = text.trimStart();
  if (!/^template\s*</.test(trimmed)) return trimmed;
  const ltIdx = trimmed.indexOf('<');
  let depth = 0;
  for (let i = ltIdx; i < trimmed.length; i++) {
    if (trimmed[i] === '<') depth++;
    else if (trimmed[i] === '>') {
      depth--;
      if (depth === 0) {
        return trimmed.slice(i + 1).trimStart();
      }
    }
  }
  return trimmed;
}

function findCCppDeclarationRange(analyzed, startIdx) {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let seenBlock = false;
  let firstBlockHeaderEndIdx = startIdx;
  let requiresSemiAfterBlock = null;
  let headerBeforeFirstBrace = '';
  let braceOpenLineIdx = -1;
  let braceOpenCol = -1;
  let braceCloseLineIdx = -1;
  let braceCloseCol = -1;

  function peekNextNonSpaceChar(lineIdx, colIdx) {
    for (let j = lineIdx; j < analyzed.length; j++) {
      if (analyzed[j].isDirective || analyzed[j].disabled) continue;
      const line = analyzed[j].clean;
      const startK = j === lineIdx ? colIdx + 1 : 0;
      for (let k = startK; k < line.length; k++) {
        if (!/\s/.test(line[k])) return line[k];
      }
    }
    return '';
  }

  function isMemberInitBrace(prefixClean) {
    const noAttr = stripLeadingTemplate(stripCCppAttributes(prefixClean)).trim();
    if (/^(?:class|struct|union|enum|namespace|extern)\b/.test(noAttr)) return false;
    if (/=\s*$/.test(noAttr)) return false;

    let p = 0;
    let sawParamClose = false;
    let initColonIdx = -1;
    for (let k = 0; k < noAttr.length; k++) {
      const c = noAttr[k];
      if (c === '(') p++;
      else if (c === ')') {
        p = Math.max(0, p - 1);
        if (p === 0) sawParamClose = true;
      } else if (c === ':' && p === 0 && sawParamClose) {
        const prevC = k > 0 ? noAttr[k - 1] : '';
        const nextC = k + 1 < noAttr.length ? noAttr[k + 1] : '';
        if (prevC !== ':' && nextC !== ':') {
          initColonIdx = k;
          break;
        }
      }
    }
    if (initColonIdx === -1) return false;

    const afterColon = noAttr.slice(initColonIdx + 1);
    let cp = 0;
    let cb = 0;
    let ca = 0;
    let lastComma = -1;
    for (let k = 0; k < afterColon.length; k++) {
      const c = afterColon[k];
      if (c === '(') cp++;
      else if (c === ')') cp = Math.max(0, cp - 1);
      else if (c === '{') cb++;
      else if (c === '}') cb = Math.max(0, cb - 1);
      else if (c === '<' && cp === 0 && cb === 0) ca++;
      else if (c === '>' && cp === 0 && cb === 0) ca = Math.max(0, ca - 1);
      else if (c === ',' && cp === 0 && cb === 0 && ca === 0) lastComma = k;
    }
    const lastInitItem = afterColon.slice(lastComma + 1).trim();
    if (!lastInitItem) return false;
    if (lastInitItem.endsWith(')') || lastInitItem.endsWith('}')) return false;
    return true;
  }

  let sawDirectiveSincePrevCode = false;

  for (let j = startIdx; j < analyzed.length; j++) {
    const info = analyzed[j];
    if (info.isDirective || info.disabled) {
      sawDirectiveSincePrevCode = true;
      continue;
    }
    if (j > startIdx && sawDirectiveSincePrevCode) {
      const startBraceDepth = analyzed[startIdx].braceStart;
      brace = Math.max(0, info.braceStart - startBraceDepth);
      sawDirectiveSincePrevCode = false;
    }
    const line = info.clean;

    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (!seenBlock) headerBeforeFirstBrace += ch;

      if (ch === '(') paren++;
      else if (ch === ')') paren = Math.max(0, paren - 1);
      else if (ch === '[') bracket++;
      else if (ch === ']') bracket = Math.max(0, bracket - 1);
      else if (ch === '{') {
        if (paren === 0 && bracket === 0) {
          if (!seenBlock && brace === 0) {
            const prefix = headerBeforeFirstBrace.slice(0, -1);
            if (!isMemberInitBrace(prefix)) {
              seenBlock = true;
              firstBlockHeaderEndIdx = j;
              braceOpenLineIdx = j;
              braceOpenCol = k;
              const noAttr = stripLeadingTemplate(stripCCppAttributes(prefix)).trim();
              const isPureTypeHeader =
                /^(?:typedef\b|class\b|struct\b|union\b|enum\b)/.test(noAttr) &&
                !/\(/.test(noAttr.split(':')[0]);
              requiresSemiAfterBlock = isPureTypeHeader || /=\s*$/.test(noAttr);
            }
          }
          brace++;
        }
      } else if (ch === '}') {
        if (paren === 0 && bracket === 0 && brace > 0) {
          brace--;
          if (brace === 0 && seenBlock) {
            braceCloseLineIdx = j;
            braceCloseCol = k;
            if (!requiresSemiAfterBlock) {
              const nextCh = peekNextNonSpaceChar(j, k);
              if (nextCh === ';') {
                continue;
              }
              return {
                endIdx: j,
                headerEndIdx: firstBlockHeaderEndIdx,
                hasBlock: true,
                braceOpenLineIdx,
                braceOpenCol,
                braceCloseLineIdx,
                braceCloseCol,
              };
            }
          } else if (brace === 0 && !seenBlock) {
            headerBeforeFirstBrace += ' ';
          }
        }
      } else if (ch === ';') {
        if (paren === 0 && bracket === 0 && brace === 0) {
          return {
            endIdx: j,
            headerEndIdx: seenBlock ? firstBlockHeaderEndIdx : j,
            hasBlock: seenBlock,
            braceOpenLineIdx,
            braceOpenCol,
            braceCloseLineIdx: seenBlock ? braceCloseLineIdx : -1,
            braceCloseCol: seenBlock ? braceCloseCol : -1,
          };
        }
      }
    }

    if (!seenBlock) headerBeforeFirstBrace += ' ';
  }

  return {
    endIdx: analyzed.length - 1,
    headerEndIdx: seenBlock ? firstBlockHeaderEndIdx : analyzed.length - 1,
    hasBlock: seenBlock,
    braceOpenLineIdx,
    braceOpenCol,
    braceCloseLineIdx: seenBlock ? analyzed.length - 1 : -1,
    braceCloseCol: -1,
  };
}

function hasTopLevelAssignmentBeforeBrace(text) {
  let p = 0;
  let b = 0;
  let a = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') p++;
    else if (ch === ')') p = Math.max(0, p - 1);
    else if (ch === '[') b++;
    else if (ch === ']') b = Math.max(0, b - 1);
    else if (ch === '<' && p === 0 && b === 0) a++;
    else if (ch === '>' && p === 0 && b === 0) a = Math.max(0, a - 1);
    else if (ch === '=' && p === 0 && b === 0 && a === 0) {
      const next = text[i + 1] || '';
      if (next !== '=') return true;
    }
  }
  return false;
}

function stripTrailingMemberInitList(text) {
  let p = 0;
  let b = 0;
  let sawParam = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') p++;
    else if (ch === ')') {
      p = Math.max(0, p - 1);
      if (p === 0) sawParam = true;
    } else if (ch === '[') b++;
    else if (ch === ']') b = Math.max(0, b - 1);
    else if (ch === ':' && p === 0 && b === 0 && sawParam) {
      const prev = i > 0 ? text[i - 1] : '';
      const next = i + 1 < text.length ? text[i + 1] : '';
      if (prev !== ':' && next !== ':') {
        return text.slice(0, i);
      }
    }
  }
  return text;
}

function extractCFunctionName(headerClean, options = {}) {
  const { hasBlock = false, inClass = false, isHeader = false, classNames = [] } = options;

  let s = stripLeadingTemplate(stripCCppAttributes(headerClean));
  s = stripTrailingMemberInitList(s).trim();
  if (!s) return null;

  const topParens = [];
  let p = 0;
  let b = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(' && b === 0) {
      if (p === 0) topParens.push({ start: i, end: -1 });
      p++;
    } else if (ch === ')' && b === 0) {
      p = Math.max(0, p - 1);
      if (p === 0 && topParens.length > 0 && topParens[topParens.length - 1].end === -1) {
        topParens[topParens.length - 1].end = i;
      }
    } else if (ch === '[') {
      b++;
    } else if (ch === ']') {
      b = Math.max(0, b - 1);
    }
  }

  if (topParens.length === 0) return null;

  const paramParen = topParens[topParens.length - 1];
  if (paramParen.end === -1) return null;

  const afterLastParen = s.slice(paramParen.end + 1).trim();
  const prefixBeforeParen = s.slice(0, paramParen.start).trimEnd();

  // 优先检查 C++ operator 重载（如 `operator()(int x)`、`operator==`、`operator<<`）
  const opMatch = prefixBeforeParen.match(
    /\b((?:[A-Za-z_]\w*::)*operator\s*(?:\(\)|\[\]|new\s*\[\]|delete\s*\[\]|->\*|->|<=>|<<=|>>=|<<|>>|<=|>=|==|!=|&&|\|\||\+\+|--|[+\-*/%^&|~!<>=,]))\s*$/
  );
  if (opMatch) {
    return opMatch[1].replace(/\s+/g, '');
  }

  // 返回函数指针的函数声明：`ret (*fn(args))(ret_args)`
  if (prefixBeforeParen.endsWith(')') && topParens.length >= 2) {
    const innerParen = topParens[topParens.length - 2];
    const innerContent = s.slice(innerParen.start + 1, innerParen.end);
    const fnPtrDeclMatch = innerContent.match(
      /^\s*\*\s*((?:[A-Za-z_]\w*::)*[A-Za-z_]\w*)\s*\(/
    );
    if (fnPtrDeclMatch) {
      const name = fnPtrDeclMatch[1];
      const baseName = name.split('::').pop();
      if (C_CONTROL_KEYWORDS.has(baseName)) return null;
      return name;
    }
    return null;
  }

  const nameMatch = prefixBeforeParen.match(/((?:~?[A-Za-z_]\w*::)*~?[A-Za-z_]\w*)\s*$/);
  if (!nameMatch) return null;

  const fullName = nameMatch[1];
  const shortName = fullName.split('::').pop();
  if (C_CONTROL_KEYWORDS.has(shortName)) {
    return null;
  }

  const retPrefix = prefixBeforeParen.slice(0, prefixBeforeParen.length - fullName.length).trim();
  if (/=/.test(retPrefix) && !/\boperator\b/.test(retPrefix)) {
    return null;
  }

  if (
    afterLastParen &&
    !/^(?:const|volatile|override|final|noexcept|throw\b|->|=\s*(?:0|default|delete)|&|&&|;|\s)*$/.test(
      afterLastParen
    )
  ) {
    if (/[=+]/.test(afterLastParen) && !/^=\s*(?:0|default|delete)\s*;?\s*$/.test(afterLastParen)) {
      return null;
    }
  }

  if (!hasBlock) {
    if (!inClass) {
      if (!retPrefix) return null;
      if (!isHeader && !/\bextern\b/.test(retPrefix)) {
        return null;
      }
    } else {
      const isCtorOrDtor = shortName.startsWith('~') || classNames.includes(shortName);
      if (!retPrefix && !isCtorOrDtor) {
        return null;
      }
    }
  }

  return fullName;
}

function buildCCppSignature(analyzed, startIdx, range, suffixOverride = '', maxLen = 140) {
  const limitEnd = range.hasBlock
    ? Math.min(range.headerEndIdx, startIdx + 20)
    : Math.min(range.endIdx, startIdx + 20);
  const parts = [];

  for (let i = startIdx; i <= limitEnd; i++) {
    const info = analyzed[i];
    if (!info || info.isDirective || info.disabled) continue;
    let slice = info.clean;
    if (range.hasBlock && i === range.braceOpenLineIdx && range.braceOpenCol !== -1) {
      slice = slice.slice(0, range.braceOpenCol);
    }
    const trimmed = slice.trim();
    if (trimmed) parts.push(trimmed);
  }

  let sig = parts.join(' ').replace(/\s+/g, ' ').replace(/;+\s*$/, '').trim();
  if (suffixOverride) {
    sig = `${sig} ${suffixOverride}`.replace(/\s+/g, ' ').trim();
  }
  if (sig.length > maxLen) {
    sig = sig.slice(0, maxLen - 3).trimEnd() + '...';
  }
  return sig;
}

/**
 * 解析 C / C++ 源码与头文件（.c, .cpp, .cc, .cxx, .c++, .h, .hpp, .hh, .hxx, .h++, .inl, .inc）
 */
function parseCCpp(lines, ext = '.c', options = {}) {
  const lineOffset = options.lineOffset || 0;
  const isHeader = C_HEADER_EXTS.has(ext);
  const isPlainC = ext === '.c';
  const { analyzed, directives } = preprocessCCppLines(lines);

  const macroItems = extractCCppMacros(directives, analyzed, lineOffset);
  const declItems = [];
  const containerStack = [];

  for (let i = 0; i < analyzed.length; i++) {
    while (containerStack.length > 0 && i > containerStack[containerStack.length - 1].endIdx) {
      containerStack.pop();
    }

    const info = analyzed[i];
    if (info.isDirective || info.disabled) continue;

    let trimmed = info.clean.trim();
    if (!trimmed) continue;

    trimmed = trimmed.replace(/^(?:\}\s*;?\s*)+/, '').trim();
    trimmed = trimmed.replace(/^(?:public|protected|private)(?:\s+slots)?\s*:/, '').trim();
    trimmed = trimmed.replace(/^(?:signals|Q_SIGNALS|slots|Q_SLOTS)\s*:/, '').trim();
    if (!trimmed || trimmed === ';') continue;

    const topContainer = containerStack.length > 0 ? containerStack[containerStack.length - 1] : null;
    const activeBodyDepth = topContainer ? topContainer.bodyDepth : 0;
    const currentDepth = containerStack.filter((c) => !c.transparent).length;

    if (info.braceStart !== activeBodyDepth) continue;

    const range = findCCppDeclarationRange(analyzed, i);

    const headerParts = [];
    const headerScanEnd = range.hasBlock ? range.braceOpenLineIdx : range.endIdx;
    for (let k = i; k <= headerScanEnd; k++) {
      const kInfo = analyzed[k];
      if (!kInfo || kInfo.isDirective || kInfo.disabled) continue;
      let seg = kInfo.clean;
      if (k === i) {
        seg = seg.trimStart().replace(/^(?:\}\s*;?\s*)+/, '').trimStart();
        seg = seg.replace(/^(?:public|protected|private)(?:\s+slots)?\s*:/, '').trimStart();
        seg = seg.replace(/^(?:signals|Q_SIGNALS|slots|Q_SLOTS)\s*:/, '').trimStart();
      }
      if (range.hasBlock && k === range.braceOpenLineIdx && range.braceOpenCol !== -1) {
        seg = seg.slice(0, range.braceOpenCol);
      }
      const t = seg.trim();
      if (t) headerParts.push(t);
    }
    let headerClean = headerParts.join(' ').replace(/\s+/g, ' ').replace(/;+\s*$/, '').trim();
    if (!headerClean) {
      i = range.endIdx;
      continue;
    }

    if (/^(?:using\b|static_assert\b|_Static_assert\b|friend\b)/.test(headerClean)) {
      i = range.endIdx;
      continue;
    }

    // 1. extern "C" / extern "C++" 透明容器或单行声明前缀
    const externBlockMatch = headerClean.match(/^extern\s+"[^"]*"\s*$/);
    if (externBlockMatch && range.hasBlock) {
      if (range.endIdx > range.headerEndIdx) {
        containerStack.push({
          type: 'extern_c',
          bodyDepth: activeBodyDepth + 1,
          endIdx: range.endIdx,
          transparent: true,
          name: '',
        });
        i = range.headerEndIdx;
      } else {
        i = range.endIdx;
      }
      continue;
    }
    if (/^extern\s+"[^"]*"\s+/.test(headerClean)) {
      headerClean = headerClean.replace(/^extern\s+"[^"]*"\s+/, '').trim();
    }

    let tailClean = '';
    if (range.hasBlock && range.braceCloseLineIdx !== -1) {
      const tailParts = [];
      for (let k = range.braceCloseLineIdx; k <= range.endIdx; k++) {
        const kInfo = analyzed[k];
        if (!kInfo || kInfo.isDirective || kInfo.disabled) continue;
        let seg = kInfo.clean;
        if (k === range.braceCloseLineIdx && range.braceCloseCol !== -1) {
          seg = seg.slice(range.braceCloseCol + 1);
        }
        const t = seg.replace(/;+\s*$/, '').trim();
        if (t) tailParts.push(t);
      }
      tailClean = tailParts.join(' ').replace(/\s+/g, ' ').trim();
    }

    const headerNoAttr = stripLeadingTemplate(stripCCppAttributes(headerClean)).trim();

    // 2. C++ namespace
    const nsMatch = headerNoAttr.match(
      /^(?:inline\s+)?namespace(?:\s+([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*))?\s*$/
    );
    if (nsMatch && range.hasBlock) {
      const nsName = nsMatch[1] || '(anonymous)';
      declItems.push({
        kind: 'namespace',
        name: nsName,
        signature: buildCCppSignature(analyzed, i, range),
        startLine: i + 1 + lineOffset,
        endLine: range.endIdx + 1 + lineOffset,
        depth: currentDepth,
      });
      if (range.endIdx > range.headerEndIdx) {
        containerStack.push({
          type: 'namespace',
          bodyDepth: activeBodyDepth + 1,
          endIdx: range.endIdx,
          transparent: false,
          name: nsName,
        });
        i = range.headerEndIdx;
      } else {
        i = range.endIdx;
      }
      continue;
    }

    // 3. typedef（struct/union/enum 块别名与函数指针/常规别名）
    if (/^typedef\b/.test(headerNoAttr)) {
      let aliasName = 'typedef';
      let sig = '';
      if (range.hasBlock) {
        const aliasMatch = tailClean.match(/\**\s*([A-Za-z_]\w*)(?:\s*\[[^\]]*\])?(?:\s*,|$)/);
        if (aliasMatch) aliasName = aliasMatch[1];
        const suffix = tailClean ? `{ ... } ${tailClean}` : '{ ... }';
        sig = buildCCppSignature(analyzed, i, range, suffix);
      } else {
        const fnPtrMatch = headerClean.match(/\(\s*\*\s*([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\)/);
        if (fnPtrMatch) {
          aliasName = fnPtrMatch[1];
        } else {
          const simpleMatch = headerClean
            .replace(/(?:\s*\[[^\]]*\])+\s*$/, '')
            .match(/([A-Za-z_]\w*)\s*$/);
          if (simpleMatch) aliasName = simpleMatch[1];
        }
        sig = buildCCppSignature(analyzed, i, range);
      }

      declItems.push({
        kind: 'typedef',
        name: aliasName,
        signature: sig,
        startLine: i + 1 + lineOffset,
        endLine: range.endIdx + 1 + lineOffset,
        depth: currentDepth,
      });
      i = range.endIdx;
      continue;
    }

    // 4. class / struct / union / enum 定义
    const typeMatch = headerNoAttr.match(
      /^(class|struct|union|enum(?:\s+class|\s+struct)?)(?:\s+(?:[A-Za-z_]\w*::)*([A-Za-z_]\w*))?(?:\s*:\s*.*)?$/
    );
    const hasParenInTypeHeader = /\(/.test(headerNoAttr.split(':')[0]);
    if (typeMatch && range.hasBlock && !hasParenInTypeHeader) {
      const rawKind = typeMatch[1].split(/\s+/)[0];
      const typeName =
        typeMatch[2] ||
        (tailClean ? tailClean.replace(/^[*&\s]+/, '').split(/[\s,;=\[]/)[0] : '(anonymous)');
      const suffix = tailClean && !tailClean.startsWith('=') ? `{ ... } ${tailClean}` : '';
      declItems.push({
        kind: rawKind,
        name: typeName,
        signature: buildCCppSignature(analyzed, i, range, suffix),
        startLine: i + 1 + lineOffset,
        endLine: range.endIdx + 1 + lineOffset,
        depth: currentDepth,
      });

      const shouldEnterScope =
        range.endIdx > range.headerEndIdx &&
        (rawKind === 'class' || (rawKind === 'struct' && !isPlainC));

      if (shouldEnterScope) {
        containerStack.push({
          type: rawKind,
          bodyDepth: activeBodyDepth + 1,
          endIdx: range.endIdx,
          transparent: false,
          name: typeName,
        });
        i = range.headerEndIdx;
      } else {
        i = range.endIdx;
      }
      continue;
    }

    // 5. 大型顶层静态初始化表 / 驱动 ops 表（带 = { ... } 且跨行 >= 4 行）
    const inClassContainer =
      topContainer && (topContainer.type === 'class' || topContainer.type === 'struct');
    if (range.hasBlock && !inClassContainer && hasTopLevelAssignmentBeforeBrace(headerClean)) {
      const spanLines = range.endIdx - i + 1;
      if (spanLines >= 4) {
        const lhs = headerClean.split('=')[0].replace(/(?:\s*\[[^\]]*\])+\s*$/, '').trim();
        const varMatch = lhs.match(/([A-Za-z_]\w*)\s*$/);
        const varName = varMatch ? varMatch[1] : 'var';
        declItems.push({
          kind: 'var',
          name: varName,
          signature: buildCCppSignature(analyzed, i, range, '= { ... }').replace(
            /=\s*=\s*\{\s*\.\.\.\s*\}/,
            '= { ... }'
          ),
          startLine: i + 1 + lineOffset,
          endLine: range.endIdx + 1 + lineOffset,
          depth: currentDepth,
        });
      }
      i = range.endIdx;
      continue;
    }

    // 6. 函数定义与头文件/类内函数原型（与上游契约对齐：顶层使用 'function'，类内使用 'method'）
    const classNames = containerStack
      .filter((c) => c.type === 'class' || c.type === 'struct')
      .map((c) => c.name);
    const fnName = extractCFunctionName(headerClean, {
      hasBlock: range.hasBlock,
      inClass: Boolean(inClassContainer),
      isHeader,
      classNames,
    });

    if (fnName) {
      declItems.push({
        kind: inClassContainer ? 'method' : 'function',
        name: fnName,
        signature: buildCCppSignature(analyzed, i, range),
        startLine: i + 1 + lineOffset,
        endLine: range.endIdx + 1 + lineOffset,
        depth: currentDepth,
      });
    }

    i = range.endIdx;
  }

  return [...macroItems, ...declItems].sort(
    (a, b) => a.startLine - b.startLine || a.depth - b.depth
  );
}

module.exports = {
  C_HEADER_EXTS,
  parseCCpp,
};
