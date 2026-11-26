'use strict';

const ID = 'python';
const EXTENSIONS = ['.py'];

function preprocessPythonLines(lines) {
  const result = new Array(lines.length);
  let tripleQuote = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const startedInTriple = tripleQuote !== null;
    let inSingle = false;
    let inDouble = false;
    const out = [];

    for (let k = 0; k < raw.length; k++) {
      const ch = raw[k];
      if (tripleQuote) {
        if (raw.slice(k, k + 3) === tripleQuote) {
          tripleQuote = null;
          out.push('   ');
          k += 2;
        } else {
          out.push(' ');
        }
        continue;
      }
      if (inSingle) {
        if (ch === '\\') {
          out.push('  ');
          k++;
          continue;
        }
        if (ch === "'") inSingle = false;
        out.push(' ');
        continue;
      }
      if (inDouble) {
        if (ch === '\\') {
          out.push('  ');
          k++;
          continue;
        }
        if (ch === '"') inDouble = false;
        out.push(' ');
        continue;
      }

      if (ch === '#') {
        while (k < raw.length) {
          out.push(' ');
          k++;
        }
        break;
      }
      if (raw.slice(k, k + 3) === '"""' || raw.slice(k, k + 3) === "'''") {
        tripleQuote = raw.slice(k, k + 3);
        out.push('   ');
        k += 2;
        continue;
      }
      if (ch === "'") {
        inSingle = true;
        out.push("'");
        continue;
      }
      if (ch === '"') {
        inDouble = true;
        out.push('"');
        continue;
      }
      out.push(ch);
    }

    const expanded = raw.replace(/^\t+/, (m) => '    '.repeat(m.length));
    const indent = expanded.length - expanded.trimStart().length;

    result[i] = {
      raw,
      clean: out.join(''),
      indent,
      startedInTriple,
      endedInTriple: tripleQuote !== null,
    };
  }

  return result;
}

function parse(lines, ext = '.py', options = {}) {
  if (ext && typeof ext === 'object') {
    options = ext;
    ext = '.py';
  }
  const lineOffset = options.lineOffset || 0;
  const analyzed = preprocessPythonLines(lines);
  const items = [];
  const classStack = [];

  for (let i = 0; i < analyzed.length; i++) {
    const info = analyzed[i];
    if (info.startedInTriple) continue;

    const trimmed = info.clean.trim();
    if (!trimmed) continue;

    while (classStack.length > 0 && info.indent <= classStack[classStack.length - 1].indent) {
      classStack.pop();
    }

    const m = trimmed.match(/^(class|async\s+def|def)\s+([A-Za-z_]\w*)\b/);
    if (!m) continue;

    const rawKind = m[1];
    const name = m[2];
    const isClass = rawKind === 'class';
    const headerIndent = info.indent;

    if (headerIndent > 0 && classStack.length === 0) continue;
    if (classStack.length > 1) continue;

    let startIdx = i;
    let probe = i - 1;
    while (probe >= 0) {
      const pInfo = analyzed[probe];
      if (pInfo.startedInTriple) break;
      const pTrim = pInfo.clean.trim();
      if (pInfo.indent === headerIndent && pTrim.startsWith('@')) {
        startIdx = probe;
        probe--;
        continue;
      }
      break;
    }

    let headerEndIdx = i;
    let paren = 0;
    let bracket = 0;
    for (let j = i; j < analyzed.length; j++) {
      const c = analyzed[j].clean;
      for (let k = 0; k < c.length; k++) {
        if (c[k] === '(') paren++;
        else if (c[k] === ')') paren = Math.max(0, paren - 1);
        else if (c[k] === '[') bracket++;
        else if (c[k] === ']') bracket = Math.max(0, bracket - 1);
      }
      if (paren === 0 && bracket === 0 && c.trimEnd().endsWith(':')) {
        headerEndIdx = j;
        break;
      }
      if (j > i && paren === 0 && bracket === 0 && analyzed[j].indent <= headerIndent) {
        break;
      }
    }

    let lastContentIdx = headerEndIdx;
    for (let j = headerEndIdx + 1; j < analyzed.length; j++) {
      const nextInfo = analyzed[j];
      // 陷阱: 多行三引号 docstring 内部行可能顶格书写（indent === 0），必须按三引号状态归入当前函数/类体防提前截断
      if (nextInfo.startedInTriple || nextInfo.endedInTriple) {
        lastContentIdx = j;
        continue;
      }
      const nextTrimmed = nextInfo.clean.trim();
      if (!nextTrimmed) continue;
      if (nextInfo.indent <= headerIndent) {
        break;
      }
      lastContentIdx = j;
    }

    const sigParts = [];
    for (let j = i; j <= headerEndIdx; j++) {
      const t = analyzed[j].raw.trim();
      if (t) sigParts.push(t);
    }
    let signature = sigParts.join(' ').replace(/\s+/g, ' ').replace(/:\s*$/, '').trim();
    if (signature.length > 140) {
      signature = signature.slice(0, 137).trimEnd() + '...';
    }

    const depth = classStack.length > 0 ? 1 : 0;
    items.push({
      kind: isClass ? 'class' : depth === 1 ? 'method' : 'def',
      name,
      signature,
      startLine: startIdx + 1 + lineOffset,
      endLine: lastContentIdx + 1 + lineOffset,
      depth,
    });

    if (isClass) {
      classStack.push({ indent: headerIndent, endIdx: lastContentIdx });
      i = headerEndIdx;
    } else {
      i = lastContentIdx;
    }
  }

  return items;
}

module.exports = {
  id: ID,
  extensions: EXTENSIONS,
  parse,
};
