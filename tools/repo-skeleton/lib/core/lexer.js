'use strict';

const REGEX_PREV_KEYWORDS = new Set([
  'return',
  'throw',
  'case',
  'typeof',
  'void',
  'delete',
  'in',
  'instanceof',
  'new',
  'await',
  'yield',
  'else',
  'do',
  'of',
]);

const DEFAULT_LEXER_CONFIG = {
  lineComments: ['//'],
  blockComments: [['/*', '*/']],
  nestedBlockComments: false,
  strings: ['"', "'"],
  templateBacktick: false,
  templateDollarString: false,
  rawBacktick: false,
  tripleQuotes: false,
  rustRawStrings: false,
  rustLifetimes: false,
  cSharpVerbatimStrings: false,
  regexLiterals: false,
  charSingleQuote: false,
};

const LEXER_PRESETS = {
  js: {
    ...DEFAULT_LEXER_CONFIG,
    templateBacktick: true,
    regexLiterals: true,
  },
  java: {
    ...DEFAULT_LEXER_CONFIG,
    tripleQuotes: ['"""'],
    charSingleQuote: true,
  },
  c: {
    ...DEFAULT_LEXER_CONFIG,
    cSharpVerbatimStrings: true,
    charSingleQuote: true,
  },
  kotlin: {
    ...DEFAULT_LEXER_CONFIG,
    nestedBlockComments: true,
    strings: ['"'],
    templateDollarString: true,
    tripleQuotes: ['"""'],
    charSingleQuote: true,
  },
  go: {
    ...DEFAULT_LEXER_CONFIG,
    rawBacktick: true,
    charSingleQuote: true,
  },
  rust: {
    ...DEFAULT_LEXER_CONFIG,
    nestedBlockComments: true,
    strings: ['"'],
    rustRawStrings: true,
    rustLifetimes: true,
  },
  python: {
    ...DEFAULT_LEXER_CONFIG,
    lineComments: ['#'],
    blockComments: [],
    tripleQuotes: ['"""', "'''"],
  },
};

function resolveLexerConfig(configOrPreset) {
  if (!configOrPreset) return DEFAULT_LEXER_CONFIG;
  if (typeof configOrPreset === 'string') {
    return LEXER_PRESETS[configOrPreset] || DEFAULT_LEXER_CONFIG;
  }
  return { ...DEFAULT_LEXER_CONFIG, ...configOrPreset };
}

function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk++;
    }
  }
  const nonCjk = text.length - cjk;
  return Math.max(1, Math.ceil(cjk * 1.5 + nonCjk / 3.8));
}

function splitLines(content) {
  if (!content) return [];
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function formatInt(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function matchPrefixAt(str, pos, prefixes) {
  if (!prefixes || prefixes.length === 0) return null;
  for (let i = 0; i < prefixes.length; i++) {
    const p = prefixes[i];
    if (p && str.startsWith(p, pos)) return p;
  }
  return null;
}

function matchPairStartAt(str, pos, pairs) {
  if (!pairs || pairs.length === 0) return null;
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    if (pair && pair[0] && str.startsWith(pair[0], pos)) return pair;
  }
  return null;
}

function preprocessBraceLines(lines, configOrPreset) {
  const cfg = resolveLexerConfig(configOrPreset);
  const tripleList = Array.isArray(cfg.tripleQuotes)
    ? cfg.tripleQuotes
    : cfg.tripleQuotes
      ? ['"""', "'''"]
      : [];
  const stringSet = new Set(cfg.strings || []);

  const result = new Array(lines.length);
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;

  let activeBlockComment = null;
  let blockCommentNested = 0;
  let activeTripleQuote = null;
  let inBacktick = false;
  let inCSharpVerbatim = false;
  let inRustRawString = false;
  let rustRawHashes = 0;
  const templateExprStack = [];

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const raw = lines[lineIdx];
    const len = raw.length;
    const out = [];
    const braceStart = braceDepth;
    const parenStart = parenDepth;
    const bracketStart = bracketDepth;

    let inLineComment = false;
    let inStringQuote = null;
    let inRegex = false;
    let inRegexClass = false;
    let prevSigToken = '';

    for (let i = 0; i < len; i++) {
      const ch = raw[i];
      const next = i + 1 < len ? raw[i + 1] : '';

      if (inLineComment) {
        out.push(' ');
        continue;
      }

      if (activeBlockComment) {
        const [openTok, closeTok] = activeBlockComment;
        if (cfg.nestedBlockComments && raw.startsWith(openTok, i)) {
          blockCommentNested++;
          out.push(' '.repeat(openTok.length));
          i += openTok.length - 1;
          continue;
        }
        if (raw.startsWith(closeTok, i)) {
          out.push(' '.repeat(closeTok.length));
          i += closeTok.length - 1;
          if (cfg.nestedBlockComments && blockCommentNested > 0) {
            blockCommentNested--;
          } else {
            activeBlockComment = null;
          }
          continue;
        }
        out.push(' ');
        continue;
      }

      // 陷阱: Java 15+ / Kotlin / Python 多行三引号文本块内常含未闭合 `"` 或 `{`，必须跨行吞掉内部字符并保留等宽空格对齐列索引
      if (activeTripleQuote) {
        if (!cfg.templateDollarString && ch === '\\') {
          out.push('  ');
          i++;
          continue;
        }
        if (cfg.templateDollarString && ch === '$' && next === '{') {
          templateExprStack.push({ depth: braceDepth, resume: 'triple', quote: activeTripleQuote });
          braceDepth++;
          out.push(' ');
          out.push('{');
          i++;
          activeTripleQuote = null;
          prevSigToken = '{';
          continue;
        }
        if (raw.startsWith(activeTripleQuote, i)) {
          const qLen = activeTripleQuote.length;
          out.push('"'.repeat(qLen));
          i += qLen - 1;
          activeTripleQuote = null;
          prevSigToken = '"';
          continue;
        }
        out.push(' ');
        continue;
      }

      if (inCSharpVerbatim) {
        if (ch === '"' && next === '"') {
          out.push('  ');
          i++;
          continue;
        }
        if (ch === '"') {
          out.push('"');
          inCSharpVerbatim = false;
          prevSigToken = '"';
          continue;
        }
        out.push(' ');
        continue;
      }

      if (inRustRawString) {
        if (ch === '"') {
          let hashes = 0;
          while (i + 1 + hashes < len && raw[i + 1 + hashes] === '#' && hashes < rustRawHashes) {
            hashes++;
          }
          if (hashes === rustRawHashes) {
            out.push('"');
            for (let h = 0; h < hashes; h++) out.push('#');
            i += hashes;
            inRustRawString = false;
            prevSigToken = '"';
            continue;
          }
        }
        out.push(' ');
        continue;
      }

      if (inBacktick) {
        if (cfg.templateBacktick) {
          if (ch === '\\') {
            out.push('  ');
            i++;
            continue;
          }
          if (ch === '$' && next === '{') {
            templateExprStack.push({ depth: braceDepth, resume: 'backtick', quote: '`' });
            braceDepth++;
            out.push(' ');
            out.push('{');
            i++;
            inBacktick = false;
            prevSigToken = '{';
            continue;
          }
          if (ch === '`') {
            inBacktick = false;
            out.push('`');
            prevSigToken = '`';
            continue;
          }
          out.push(' ');
          continue;
        }
        if (ch === '`') {
          inBacktick = false;
          out.push('`');
          prevSigToken = '`';
        } else {
          out.push(' ');
        }
        continue;
      }

      if (inStringQuote) {
        if (ch === '\\') {
          out.push('  ');
          i++;
          continue;
        }
        if (cfg.templateDollarString && inStringQuote === '"' && ch === '$' && next === '{') {
          templateExprStack.push({ depth: braceDepth, resume: 'string', quote: '"' });
          braceDepth++;
          out.push(' ');
          out.push('{');
          i++;
          inStringQuote = null;
          prevSigToken = '{';
          continue;
        }
        if (ch === inStringQuote) {
          out.push(ch);
          inStringQuote = null;
          prevSigToken = ch;
          continue;
        }
        out.push(' ');
        continue;
      }

      if (inRegex) {
        if (ch === '\\') {
          out.push('  ');
          i++;
          continue;
        }
        if (ch === '[') {
          inRegexClass = true;
          out.push(' ');
          continue;
        }
        if (ch === ']' && inRegexClass) {
          inRegexClass = false;
          out.push(' ');
          continue;
        }
        if (ch === '/' && !inRegexClass) {
          inRegex = false;
          out.push('/');
          prevSigToken = '/';
          while (i + 1 < len && /[a-z]/i.test(raw[i + 1])) {
            out.push(' ');
            i++;
          }
          continue;
        }
        out.push(' ');
        continue;
      }

      const lineCommentTok = matchPrefixAt(raw, i, cfg.lineComments);
      if (lineCommentTok) {
        inLineComment = true;
        out.push(' '.repeat(lineCommentTok.length));
        i += lineCommentTok.length - 1;
        continue;
      }

      const blockPair = matchPairStartAt(raw, i, cfg.blockComments);
      if (blockPair) {
        activeBlockComment = blockPair;
        blockCommentNested = 0;
        out.push(' '.repeat(blockPair[0].length));
        i += blockPair[0].length - 1;
        continue;
      }

      const tripleTok = matchPrefixAt(raw, i, tripleList);
      if (tripleTok) {
        activeTripleQuote = tripleTok;
        out.push('"'.repeat(tripleTok.length));
        i += tripleTok.length - 1;
        continue;
      }

      if (cfg.cSharpVerbatimStrings && ch === '@' && next === '"') {
        inCSharpVerbatim = true;
        out.push(' "');
        i++;
        continue;
      }

      if (cfg.rustRawStrings && (ch === 'r' || (ch === 'b' && next === 'r'))) {
        let pos = ch === 'b' ? i + 2 : i + 1;
        let hashes = 0;
        while (pos < len && raw[pos] === '#') {
          hashes++;
          pos++;
        }
        if (pos < len && raw[pos] === '"' && (i === 0 || !/[A-Za-z0-9_]/.test(raw[i - 1]))) {
          inRustRawString = true;
          rustRawHashes = hashes;
          for (let k = i; k <= pos; k++) out.push(raw[k]);
          i = pos;
          continue;
        }
      }

      if (cfg.regexLiterals && ch === '/') {
        const startsRegex =
          prevSigToken === '' ||
          '([{,;:=!?&|^~+-*%<>'.includes(prevSigToken) ||
          REGEX_PREV_KEYWORDS.has(prevSigToken);
        if (startsRegex) {
          inRegex = true;
          inRegexClass = false;
          out.push('/');
          continue;
        }
      }

      if (ch === "'" && cfg.rustLifetimes) {
        const tail = raw.slice(i);
        const charLitMatch = tail.match(/^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F_]+\}|.)|[^'\\])'/);
        if (charLitMatch) {
          out.push("'");
          for (let k = 1; k < charLitMatch[0].length - 1; k++) out.push(' ');
          out.push("'");
          i += charLitMatch[0].length - 1;
          prevSigToken = "'";
          continue;
        }
        out.push("'");
        prevSigToken = "'";
        continue;
      }

      if (stringSet.has(ch)) {
        inStringQuote = ch;
        out.push(ch);
        continue;
      }

      if (ch === '`' && (cfg.templateBacktick || cfg.rawBacktick)) {
        inBacktick = true;
        out.push('`');
        continue;
      }

      if (ch === '{') {
        braceDepth++;
      } else if (ch === '}') {
        braceDepth = Math.max(0, braceDepth - 1);
        if (
          templateExprStack.length > 0 &&
          braceDepth === templateExprStack[templateExprStack.length - 1].depth
        ) {
          const resumed = templateExprStack.pop();
          out.push('}');
          prevSigToken = '}';
          if (resumed.resume === 'backtick') inBacktick = true;
          else if (resumed.resume === 'triple') activeTripleQuote = resumed.quote;
          else if (resumed.resume === 'string') inStringQuote = resumed.quote;
          continue;
        }
      } else if (ch === '(') {
        parenDepth++;
      } else if (ch === ')') {
        parenDepth = Math.max(0, parenDepth - 1);
      } else if (ch === '[') {
        bracketDepth++;
      } else if (ch === ']') {
        bracketDepth = Math.max(0, bracketDepth - 1);
      }

      out.push(ch);

      if (!/\s/.test(ch)) {
        if (/[A-Za-z0-9_$]/.test(ch)) {
          if (i > 0 && /[A-Za-z0-9_$]/.test(raw[i - 1]) && /[A-Za-z0-9_$]/.test(prevSigToken)) {
            prevSigToken += ch;
          } else {
            prevSigToken = ch;
          }
        } else {
          prevSigToken = ch;
        }
      }
    }

    result[lineIdx] = {
      raw,
      clean: out.join(''),
      braceStart,
      braceEnd: braceDepth,
      parenStart,
      parenEnd: parenDepth,
      bracketStart,
      bracketEnd: bracketDepth,
    };
  }

  return result;
}

const OPEN_TO_CLOSE = {
  '(': ')',
  '[': ']',
  '{': '}',
  '<': '>',
};

const CLOSE_TO_OPEN = {
  ')': '(',
  ']': '[',
  '}': '{',
  '>': '<',
};

function findMatchingForward(analyzed, startLine, startCol, openChar = '(', closeChar = OPEN_TO_CLOSE[openChar]) {
  let depth = 0;
  for (let line = startLine; line < analyzed.length; line++) {
    const clean = analyzed[line].clean;
    const kStart = line === startLine ? startCol : 0;
    for (let col = kStart; col < clean.length; col++) {
      const ch = clean[col];
      if (ch === openChar) {
        depth++;
      } else if (ch === closeChar) {
        depth--;
        if (depth === 0) {
          return { line, col };
        }
      }
    }
  }
  return null;
}

function findMatchingBackward(analyzed, endLine, endCol, closeChar = ')', openChar = CLOSE_TO_OPEN[closeChar], minLine = 0) {
  let depth = 0;
  const floor = Math.max(0, minLine);
  for (let line = endLine; line >= floor; line--) {
    const clean = analyzed[line].clean;
    const kStart = line === endLine ? endCol : clean.length - 1;
    for (let col = kStart; col >= 0; col--) {
      const ch = clean[col];
      if (ch === closeChar) {
        depth++;
      } else if (ch === openChar) {
        depth--;
        if (depth === 0) {
          return { line, col };
        }
      }
    }
  }
  return null;
}

function skipWhitespaceForward(analyzed, startLine, startCol, maxLine = analyzed.length - 1) {
  const ceil = Math.min(analyzed.length - 1, maxLine);
  for (let line = startLine; line <= ceil; line++) {
    const clean = analyzed[line].clean;
    const kStart = line === startLine ? startCol : 0;
    for (let col = kStart; col < clean.length; col++) {
      if (!/\s/.test(clean[col])) {
        return { line, col, ch: clean[col] };
      }
    }
  }
  return null;
}

function skipWhitespaceBackward(analyzed, startLine, startCol, minLine = 0) {
  const floor = Math.max(0, minLine);
  for (let line = startLine; line >= floor; line--) {
    const clean = analyzed[line].clean;
    const kStart = line === startLine ? startCol : clean.length - 1;
    for (let col = kStart; col >= 0; col--) {
      if (!/\s/.test(clean[col])) {
        return { line, col, ch: clean[col] };
      }
    }
  }
  return null;
}

function stripLeadingAnnotationsOnText(cleanText) {
  let pos = 0;
  const len = cleanText.length;
  while (pos < len) {
    while (pos < len && /\s/.test(cleanText[pos])) pos++;
    if (pos >= len || cleanText[pos] !== '@') break;
    // 陷阱: `@interface` 是 Java 注解类型容器声明本身，不能当作前置修饰注解剥掉
    if (/^@interface\b/.test(cleanText.slice(pos))) break;
    pos++;
    while (pos < len && /\s/.test(cleanText[pos])) pos++;
    const nameMatch = cleanText.slice(pos).match(/^[A-Za-z_$][\w$.:]*/);
    if (!nameMatch) break;
    pos += nameMatch[0].length;
    while (pos < len && /\s/.test(cleanText[pos])) pos++;
    if (pos < len && cleanText[pos] === '(') {
      let depth = 0;
      while (pos < len) {
        if (cleanText[pos] === '(') depth++;
        else if (cleanText[pos] === ')') {
          depth--;
          if (depth === 0) {
            pos++;
            break;
          }
        }
        pos++;
      }
    }
  }
  while (pos < len && /\s/.test(cleanText[pos])) pos++;
  return { rest: cleanText.slice(pos), offset: pos };
}

function skipLeadingAnnotations(analyzed, startLine, startCol = 0) {
  let line = startLine;
  let col = startCol;
  while (line < analyzed.length) {
    const next = skipWhitespaceForward(analyzed, line, col);
    if (!next) return null;
    line = next.line;
    col = next.col;
    const clean = analyzed[line].clean;
    if (clean[col] !== '@') {
      return { line, col };
    }
    if (/^@interface\b/.test(clean.slice(col))) {
      return { line, col };
    }
    let curCol = col + 1;
    while (curCol < clean.length && /\s/.test(clean[curCol])) curCol++;
    const nameMatch = clean.slice(curCol).match(/^[A-Za-z_$][\w$.:]*/);
    if (!nameMatch) {
      return { line, col };
    }
    curCol += nameMatch[0].length;
    const afterName = skipWhitespaceForward(analyzed, line, curCol, Math.min(analyzed.length - 1, line + 1));
    if (afterName && afterName.ch === '(') {
      const closePos = findMatchingForward(analyzed, afterName.line, afterName.col, '(', ')');
      if (!closePos) return null;
      line = closePos.line;
      col = closePos.col + 1;
      continue;
    }
    col = curCol;
  }
  return null;
}

function sliceCleanRange(analyzed, startLine, startCol, endLine, endCol) {
  if (startLine > endLine || (startLine === endLine && startCol > endCol)) return '';
  if (startLine === endLine) {
    return analyzed[startLine].clean.slice(startCol, endCol + 1);
  }
  const parts = [analyzed[startLine].clean.slice(startCol)];
  for (let i = startLine + 1; i < endLine; i++) {
    parts.push(analyzed[i].clean);
  }
  parts.push(analyzed[endLine].clean.slice(0, endCol + 1));
  return parts.join('\n');
}

function hasTopLevelChar(text, targetChar) {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let angle = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : '';
    const next = i + 1 < text.length ? text[i + 1] : '';
    if (ch === '(') paren++;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket = Math.max(0, bracket - 1);
    else if (ch === '{') brace++;
    else if (ch === '}') brace = Math.max(0, brace - 1);
    else if (ch === '<' && next !== '=' && prev !== '-' && prev !== '=') angle++;
    else if (ch === '>' && prev !== '-' && prev !== '=' && next !== '=') {
      if (angle > 0) angle--;
    } else if (
      ch === targetChar &&
      paren === 0 &&
      bracket === 0 &&
      brace === 0 &&
      angle === 0
    ) {
      if (targetChar === '=' && (prev === '=' || prev === '!' || prev === '<' || prev === '>' || next === '=' || next === '>')) {
        continue;
      }
      return true;
    }
  }
  return false;
}

module.exports = {
  REGEX_PREV_KEYWORDS,
  DEFAULT_LEXER_CONFIG,
  LEXER_PRESETS,
  resolveLexerConfig,
  estimateTokens,
  splitLines,
  formatInt,
  preprocessBraceLines,
  findMatchingForward,
  findMatchingBackward,
  skipWhitespaceForward,
  skipWhitespaceBackward,
  stripLeadingAnnotationsOnText,
  skipLeadingAnnotations,
  sliceCleanRange,
  hasTopLevelChar,
};
