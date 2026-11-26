'use strict';

const fs = require('fs');
const path = require('path');
const { estimateTokens, splitLines } = require('./core/lexer');
const { normalizeExt, getLanguageDir, getLanguageHandler } = require('./core/registry');

function stripMarkdownDecorations(text) {
  if (!text) return '';
  return String(text)
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSymbolQuery(rawQuery, options = {}) {
  if (rawQuery === undefined || rawQuery === null) return '';
  let q = String(rawQuery).trim();
  if (!q) return '';

  const isMarkdown = Boolean(options.isMarkdown);
  if (isMarkdown) {
    q = q.replace(/^#{1,6}\s+/, '').replace(/\s+#+\s*$/, '').trim();
  } else if (/^#{2,}\s+/.test(q)) {
    q = q.replace(/^#+\s+/, '').trim();
  } else if (q.startsWith('#')) {
    const rest = q.slice(1).trim();
    if (rest) q = rest;
  }

  if (/\(\s*\)$/.test(q) && !/operator\s*\(\s*\)$/.test(q)) {
    q = q.replace(/\(\s*\)$/, '').trim();
  }

  return q;
}

function parseSliceTarget(target, explicitSymbol) {
  const rawTarget = target !== undefined && target !== null ? String(target).trim() : '';
  const hasExplicit =
    explicitSymbol !== undefined &&
    explicitSymbol !== null &&
    String(explicitSymbol).trim() !== '';

  let filePath = rawTarget;
  let rawSymbol = hasExplicit ? String(explicitSymbol).trim() : '';

  if (!hasExplicit && rawTarget) {
    const hashIdx = rawTarget.indexOf('#');
    if (hashIdx > 0 && !fs.existsSync(path.resolve(rawTarget))) {
      filePath = rawTarget.slice(0, hashIdx).trim();
      rawSymbol = rawTarget.slice(hashIdx + 1).trim();
    }
  }

  const ext = normalizeExt(filePath);
  const isMarkdown = getLanguageDir(ext) === 'markdown';
  const symbol = normalizeSymbolQuery(rawSymbol, { isMarkdown });

  return {
    filePath,
    symbol,
    rawSymbol,
  };
}

function stripGenericParams(typeExpr) {
  if (!typeExpr) return '';
  let out = '';
  let depth = 0;
  for (let i = 0; i < typeExpr.length; i++) {
    const ch = typeExpr[i];
    if (ch === '<' || ch === '[') {
      depth++;
    } else if (ch === '>' || ch === ']') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0) {
      out += ch;
    }
  }
  return out.trim();
}

function extractGoReceiverType(signature) {
  if (!signature) return null;
  const m = signature.match(/^\s*func\s*\(([^)]+)\)/);
  if (!m) return null;
  const recvInner = m[1].trim();
  if (!recvInner) return null;
  const withoutGenerics = stripGenericParams(recvInner);
  const typeMatch = withoutGenerics.match(/([A-Za-z_]\w*)\s*$/);
  return typeMatch ? typeMatch[1] : null;
}

function normalizeRustImplTarget(rawName) {
  if (!rawName) return '';
  let s = String(rawName).replace(/\bwhere\b[\s\S]*$/, '').trim();
  const forSplit = s.split(/\bfor\b/);
  if (forSplit.length > 1) {
    s = forSplit[forSplit.length - 1].trim();
  } else if (s.startsWith('<')) {
    s = stripGenericParams(s);
  }
  s = stripGenericParams(s)
    .replace(/^[&*\s']+/, '')
    .replace(/\b(?:mut|dyn|impl)\b\s*/g, '')
    .trim();
  const lastSeg = s.split('::').pop().trim();
  const idMatch = lastSeg.match(/^([A-Za-z_]\w*)/);
  return idMatch ? idMatch[1] : s || 'impl';
}

function splitHierarchySegments(str, isMarkdown = false) {
  if (!str) return [];
  if (isMarkdown) {
    if (str.includes('>')) {
      return str
        .split(/\s*>\s*/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (str.includes('.')) {
      return str
        .split('.')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return [str.trim()];
  }

  const normalized = String(str)
    .replace(/\s*>\s*/g, '.')
    .replace(/::/g, '.');
  return normalized
    .split('.')
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildQualifiedItems(items, ext = '') {
  if (!Array.isArray(items) || items.length === 0) return [];
  const normalizedExt = normalizeExt(ext);
  const langDir = getLanguageDir(normalizedExt);
  const isGo = langDir === 'go';
  const isRust = langDir === 'rust';
  const isCFamily = langDir === 'c-family' && normalizedExt !== '.cs';
  const isMarkdown = langDir === 'markdown';

  if (isMarkdown) {
    const headingStack = [];
    return items.map((item) => {
      const level = typeof item.level === 'number' ? item.level : (item.depth || 0) + 1;
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }
      const cleanName = stripMarkdownDecorations(item.name);
      const parents = headingStack.map((h) => h.name);
      const cleanParents = headingStack.map((h) => h.cleanName);
      const segments = [...parents, item.name];
      const cleanSegments = [...cleanParents, cleanName];
      const qualifiedName = segments.join(' > ');
      const dotQualified = segments.join('.');
      const cleanQualified = cleanSegments.join(' > ');
      const cleanDotQualified = cleanSegments.join('.');

      const aliases = new Set([
        item.name,
        cleanName,
        qualifiedName,
        dotQualified,
        cleanQualified,
        cleanDotQualified,
      ]);

      headingStack.push({ level, name: item.name, cleanName });

      return {
        ...item,
        shortName: item.name,
        cleanName,
        parents,
        segments,
        cleanSegments,
        qualifiedName,
        aliases: [...aliases].filter(Boolean),
      };
    });
  }

  const scopeStack = [];
  return items.map((item) => {
    const depth = typeof item.depth === 'number' ? item.depth : 0;
    while (scopeStack.length > 0 && scopeStack[scopeStack.length - 1].depth >= depth) {
      scopeStack.pop();
    }

    let containerDisplayName = item.name || '';
    if (isRust && item.kind === 'impl') {
      containerDisplayName = normalizeRustImplTarget(item.name);
    }

    const parentSegments = [];
    for (const ancestor of scopeStack) {
      for (const seg of ancestor.segments) {
        parentSegments.push(seg);
      }
    }

    let ownSegments = [item.name];
    let shortName = item.name;

    if (isGo && item.kind === 'func' && depth === 0) {
      const recvType = extractGoReceiverType(item.signature);
      if (recvType) {
        ownSegments = [recvType, item.name];
        shortName = item.name;
      }
    } else if (isCFamily && item.name && item.name.includes('::')) {
      const parts = item.name.split('::').filter(Boolean);
      if (parts.length > 1) {
        ownSegments = parts;
        shortName = parts[parts.length - 1];
      }
    } else if (isRust && item.kind === 'impl') {
      ownSegments = [containerDisplayName];
      shortName = containerDisplayName;
    } else if (item.kind === 'namespace' && item.name && item.name.includes('::')) {
      ownSegments = item.name.split('::').filter(Boolean);
      shortName = ownSegments[ownSegments.length - 1];
    }

    const fullSegments = [...parentSegments, ...ownSegments].filter(Boolean);
    const qualifiedName = fullSegments.join('.');
    const colonQualified = fullSegments.join('::');

    const aliases = new Set([
      item.name,
      shortName,
      qualifiedName,
      colonQualified,
    ]);
    if (shortName && shortName.startsWith('#') && shortName.length > 1) {
      const barePrivate = shortName.slice(1);
      const bareFull = [...parentSegments, barePrivate].filter(Boolean);
      aliases.add(barePrivate);
      aliases.add(bareFull.join('.'));
    }

    scopeStack.push({
      depth,
      kind: item.kind,
      segments: isRust && item.kind === 'impl' ? [containerDisplayName] : ownSegments,
    });

    return {
      ...item,
      shortName,
      parents: fullSegments.slice(0, -1),
      segments: fullSegments,
      qualifiedName,
      aliases: [...aliases].filter(Boolean),
    };
  });
}

function hasHierarchySeparator(query, isMarkdown = false) {
  if (!query) return false;
  if (query.includes('>') || query.includes('::')) return true;
  if (query.includes('.')) {
    if (query === 'module.exports') return false;
    return true;
  }
  return false;
}

function segmentsSuffixMatch(itemSegs, querySegs, caseInsensitive = false, stripMd = false) {
  if (!Array.isArray(itemSegs) || !Array.isArray(querySegs)) return false;
  if (querySegs.length === 0 || querySegs.length > itemSegs.length) return false;

  const offset = itemSegs.length - querySegs.length;
  for (let i = 0; i < querySegs.length; i++) {
    let a = itemSegs[offset + i];
    let b = querySegs[i];
    if (stripMd) {
      a = stripMarkdownDecorations(a);
      b = stripMarkdownDecorations(b);
    }
    if (caseInsensitive) {
      a = a.toLowerCase();
      b = b.toLowerCase();
    }
    if (a !== b) return false;
  }
  return true;
}

function matchQualifiedItems(qualifiedItems, rawQuery, ext = '') {
  const normalizedExt = normalizeExt(ext);
  const isMarkdown = getLanguageDir(normalizedExt) === 'markdown';
  const query = normalizeSymbolQuery(rawQuery, { isMarkdown });
  if (!query || qualifiedItems.length === 0) return [];

  const hierarchical = hasHierarchySeparator(query, isMarkdown);
  let matched = [];

  if (hierarchical) {
    const querySegs = splitHierarchySegments(query, isMarkdown);

    // 1. Exact full hierarchy match (or exact alias match)
    matched = qualifiedItems.filter((item) => {
      if (item.aliases.includes(query)) return true;
      return (
        item.segments.length === querySegs.length &&
        segmentsSuffixMatch(item.segments, querySegs, false, false)
      );
    });

    // 2. Markdown decoration-stripped exact full hierarchy match
    if (matched.length === 0 && isMarkdown) {
      matched = qualifiedItems.filter(
        (item) =>
          item.segments.length === querySegs.length &&
          segmentsSuffixMatch(item.segments, querySegs, false, true)
      );
    }

    // 3. Case-insensitive full hierarchy match
    if (matched.length === 0) {
      const qLower = query.toLowerCase();
      matched = qualifiedItems.filter((item) => {
        if (item.aliases.some((a) => a.toLowerCase() === qLower)) return true;
        return (
          item.segments.length === querySegs.length &&
          segmentsSuffixMatch(item.segments, querySegs, true, isMarkdown)
        );
      });
    }

    // 4. Suffix segment match (e.g. Inner.run matching Outer.Inner.run)
    if (matched.length === 0 && querySegs.length >= 2) {
      matched = qualifiedItems.filter((item) =>
        segmentsSuffixMatch(item.segments, querySegs, false, isMarkdown)
      );
      if (matched.length === 0) {
        matched = qualifiedItems.filter((item) =>
          segmentsSuffixMatch(item.segments, querySegs, true, isMarkdown)
        );
      }
    }
  } else {
    // Single symbol name query
    // 1. Exact match on item.name or item.shortName (including JS #private methods)
    const hashPrefixed = `#${query}`;
    matched = qualifiedItems.filter(
      (item) =>
        item.name === query ||
        item.shortName === query ||
        item.name === hashPrefixed ||
        item.shortName === hashPrefixed
    );

    // 2. Markdown stripped decoration match (exact case)
    if (matched.length === 0 && isMarkdown) {
      const cleanQuery = stripMarkdownDecorations(query);
      matched = qualifiedItems.filter((item) => item.cleanName === cleanQuery);
    }

    // 3. Case-insensitive match on name / shortName / cleanName
    if (matched.length === 0) {
      const qLower = query.toLowerCase();
      const cleanQLower = isMarkdown ? stripMarkdownDecorations(query).toLowerCase() : qLower;
      matched = qualifiedItems.filter((item) => {
        if (item.name && item.name.toLowerCase() === qLower) return true;
        if (item.shortName && item.shortName.toLowerCase() === qLower) return true;
        if (isMarkdown && item.cleanName && item.cleanName.toLowerCase() === cleanQLower) {
          return true;
        }
        return false;
      });
    }
  }

  return matched.slice().sort((a, b) => a.startLine - b.startLine || (a.depth || 0) - (b.depth || 0));
}

function splitIdentifierWords(str) {
  if (!str) return [];
  const cleaned = stripMarkdownDecorations(String(str))
    .replace(/::/g, ' ')
    .replace(/[._\->/]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return cleaned
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^[^a-z0-9\u4e00-\u9fff]+|[^a-z0-9\u4e00-\u9fff]+$/g, ''))
    .filter(Boolean);
}

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n];
}

function scoreCandidateSimilarity(query, item) {
  const qLower = stripMarkdownDecorations(query).toLowerCase();
  const shortCand = stripMarkdownDecorations(item.shortName || item.name || '').toLowerCase();
  const qualCand = stripMarkdownDecorations(item.qualifiedName || item.name || '').toLowerCase();
  const primary = hasHierarchySeparator(query) ? qualCand : shortCand;
  if (!qLower || !primary) return 0;

  let bestScore = 0;

  for (const cand of new Set([primary, shortCand, qualCand])) {
    if (!cand) continue;
    let score = 0;

    if (cand === qLower) {
      score = 1.0;
    } else if (cand.startsWith(qLower) || qLower.startsWith(cand)) {
      const ratio = Math.min(cand.length, qLower.length) / Math.max(cand.length, qLower.length);
      score = Math.max(score, 0.72 + 0.23 * ratio);
    } else if (cand.includes(qLower) || qLower.includes(cand)) {
      const ratio = Math.min(cand.length, qLower.length) / Math.max(cand.length, qLower.length);
      score = Math.max(score, 0.62 + 0.25 * ratio);
    }

    const maxLen = Math.max(cand.length, qLower.length);
    if (maxLen > 0 && Math.abs(cand.length - qLower.length) <= Math.max(6, Math.ceil(maxLen * 0.6))) {
      const dist = levenshteinDistance(qLower, cand);
      const editSim = 1 - dist / maxLen;
      if (editSim >= 0.45) {
        score = Math.max(score, editSim * 0.85);
      }
    }

    if (score > bestScore) bestScore = score;
  }

  const qWords = splitIdentifierWords(query);
  const cWords = splitIdentifierWords(`${item.qualifiedName || ''} ${item.shortName || ''}`);
  if (qWords.length > 0 && cWords.length > 0) {
    const cSet = new Set(cWords);
    let overlap = 0;
    for (const qw of qWords) {
      if (cSet.has(qw)) {
        overlap += 1;
      } else if (qw.length >= 3) {
        for (const cw of cSet) {
          if (cw.includes(qw) || qw.includes(cw)) {
            overlap += 0.7;
            break;
          }
          if (Math.abs(cw.length - qw.length) <= 2 && levenshteinDistance(qw, cw) <= 1) {
            overlap += 0.65;
            break;
          }
        }
      }
    }
    if (overlap > 0) {
      const unionSize = new Set([...qWords, ...cWords]).size;
      const wordScore = 0.45 + 0.45 * (overlap / Math.max(qWords.length, Math.min(unionSize, qWords.length + 2)));
      if (wordScore > bestScore) bestScore = Math.min(0.92, wordScore);
    }
  }

  return Number(bestScore.toFixed(4));
}

function rankSymbolSuggestions(qualifiedItems, rawQuery, maxCount = 5) {
  const query = String(rawQuery || '').trim();
  if (!query || !Array.isArray(qualifiedItems) || qualifiedItems.length === 0) return [];

  const scored = [];
  const seenKeys = new Set();

  for (const item of qualifiedItems) {
    const dedupKey = `${item.qualifiedName}:${item.startLine}-${item.endLine}`;
    if (seenKeys.has(dedupKey)) continue;
    seenKeys.add(dedupKey);

    const score = scoreCandidateSimilarity(query, item);
    if (score >= 0.36) {
      scored.push({
        score,
        item: {
          qualifiedName: item.qualifiedName,
          name: item.name,
          kind: item.kind,
          signature: item.signature,
          startLine: item.startLine,
          endLine: item.endLine,
        },
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.item.startLine - b.item.startLine);
  return scored.slice(0, maxCount).map((entry) => entry.item);
}

function formatSkeletonOutline(items, totalLines) {
  if (!Array.isArray(items) || items.length === 0) {
    return `(no symbol signatures detected; total ${totalLines} lines)`;
  }
  const out = [];
  for (const item of items) {
    const indent = '  '.repeat(item.depth || 0);
    out.push(`${indent}[L${item.startLine}-L${item.endLine}] ${item.signature}`);
  }
  return out.join('\n');
}

function formatSliceLines(lines, startLine, endLine, withLineNumbers = false) {
  const sIdx = Math.max(0, startLine - 1);
  const eIdx = Math.min(lines.length, endLine);
  const rawSlice = lines.slice(sIdx, eIdx);
  if (!withLineNumbers) {
    return rawSlice.join('\n');
  }
  const padWidth = Math.max(4, String(endLine).length);
  return rawSlice
    .map((line, offset) => `${String(sIdx + offset + 1).padStart(padWidth, ' ')} | ${line}`)
    .join('\n');
}

function formatSliceSuccess(fileLabel, matches, options = {}) {
  const blocks = [];
  for (let idx = 0; idx < matches.length; idx++) {
    const m = matches[idx];
    const header = fileLabel
      ? `${fileLabel} [L${m.startLine}-L${m.endLine}] ${m.signature}`
      : `[L${m.startLine}-L${m.endLine}] ${m.signature}`;
    if (options.includeFileHeader !== false && fileLabel && matches.length === 1) {
      blocks.push(`[L${m.startLine}-L${m.endLine}] ${m.signature}\n${m.content}`);
    } else {
      blocks.push(`${header}\n${m.content}`);
    }
  }

  if (fileLabel && matches.length === 1 && options.includeFileHeader !== false) {
    return `File: ${fileLabel}\n${blocks[0]}`;
  }
  if (fileLabel && matches.length > 1 && options.includeFileHeader !== false) {
    return `File: ${fileLabel} (${matches.length} matches)\n\n${blocks.join('\n\n')}`;
  }
  return blocks.join('\n\n');
}

function formatSliceNotFound(fileLabel, query, totalLines, suggestions, skeletonText) {
  const targetLabel = fileLabel || '<inline>';
  const out = [`Symbol "${query}" not found in ${targetLabel} (total ${totalLines} lines).`];

  if (Array.isArray(suggestions) && suggestions.length > 0) {
    out.push('');
    out.push('Did you mean:');
    for (const s of suggestions) {
      out.push(`  - ${s.qualifiedName} [L${s.startLine}-L${s.endLine}] (${s.signature})`);
    }
  }

  out.push('');
  out.push('Current symbols in file:');
  out.push(skeletonText);
  return out.join('\n');
}

function parseRawSkeletonItems(lines, ext, options = {}) {
  const handler = getLanguageHandler(ext);
  if (!handler) return [];
  return typeof handler === 'function'
    ? handler(lines, ext, options)
    : handler.parse(lines, ext, options);
}

function sliceSymbolFromText(content, ext, symbolQuery, options = {}) {
  const t0 = performance.now();
  const rawContent = String(content ?? '');
  const normalizedExt = normalizeExt(ext);
  const isMarkdown = getLanguageDir(normalizedExt) === 'markdown';
  const query = normalizeSymbolQuery(symbolQuery, { isMarkdown });
  const lines = splitLines(rawContent);
  const totalLines = lines.length;
  const charCount = rawContent.length;
  const rawTokens = estimateTokens(rawContent);
  const filePath = options.filePath || null;
  const fileLabel = options.displayPath || filePath || `<text${normalizedExt || ''}>`;
  const lineNumbers = Boolean(options.lineNumbers);

  const rawItems = parseRawSkeletonItems(lines, normalizedExt, options);
  const qualifiedItems = buildQualifiedItems(rawItems, normalizedExt);
  const skeletonText = formatSkeletonOutline(rawItems, totalLines);

  const matchedItems = matchQualifiedItems(qualifiedItems, query, normalizedExt);

  if (matchedItems.length > 0) {
    const matches = matchedItems.map((it) => {
      const sliceContent = formatSliceLines(lines, it.startLine, it.endLine, lineNumbers);
      return {
        kind: it.kind,
        name: it.name,
        qualifiedName: it.qualifiedName,
        signature: it.signature,
        startLine: it.startLine,
        endLine: it.endLine,
        lineCount: Math.max(0, it.endLine - it.startLine + 1),
        depth: it.depth || 0,
        ...(typeof it.level === 'number' ? { level: it.level } : {}),
        content: sliceContent,
      };
    });

    const formatted = formatSliceSuccess(fileLabel, matches, {
      includeFileHeader: options.includeFileHeader !== false,
    });
    const sliceTokens = estimateTokens(formatted);
    const savedTokens = Math.max(0, rawTokens - sliceTokens);
    const savedPercent =
      rawTokens > 0 ? Number(((savedTokens / rawTokens) * 100).toFixed(1)) : 0;
    const elapsedMs = Number((performance.now() - t0).toFixed(2));

    return {
      mode: 'slice',
      ok: true,
      found: true,
      filePath,
      ext: normalizedExt,
      query,
      totalLines,
      charCount,
      rawTokens,
      sliceTokens,
      savedTokens,
      savedPercent,
      matchCount: matches.length,
      matches,
      elapsedMs,
      formatted,
      text: formatted,
    };
  }

  const suggestions = rankSymbolSuggestions(qualifiedItems, query, options.maxSuggestions || 5);
  const availableSymbols = qualifiedItems.map((it) => ({
    kind: it.kind,
    name: it.name,
    qualifiedName: it.qualifiedName,
    signature: it.signature,
    startLine: it.startLine,
    endLine: it.endLine,
    depth: it.depth || 0,
    ...(typeof it.level === 'number' ? { level: it.level } : {}),
  }));

  const formatted = formatSliceNotFound(
    fileLabel,
    query || String(symbolQuery ?? ''),
    totalLines,
    suggestions,
    skeletonText
  );
  const elapsedMs = Number((performance.now() - t0).toFixed(2));

  return {
    mode: 'slice',
    ok: false,
    found: false,
    filePath,
    ext: normalizedExt,
    query,
    totalLines,
    charCount,
    rawTokens,
    matchCount: 0,
    matches: [],
    suggestions,
    availableSymbols,
    skeletonText,
    elapsedMs,
    formatted,
    text: formatted,
  };
}

function locateSymbol(filePathOrTarget, symbolQuery, options = {}) {
  const parsed = parseSliceTarget(filePathOrTarget, symbolQuery);
  if (!parsed.filePath) {
    throw new Error('Missing target file path for symbol lookup.');
  }
  const resolved = path.resolve(parsed.filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Target file does not exist: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`Symbol lookup requires a file path, got directory: ${resolved}`);
  }

  const content = fs.readFileSync(resolved, 'utf8');
  const ext = normalizeExt(resolved);
  const lines = splitLines(content);
  const totalLines = lines.length;
  const rawItems = parseRawSkeletonItems(lines, ext, options);
  const qualifiedItems = buildQualifiedItems(rawItems, ext);
  const skeletonText = formatSkeletonOutline(rawItems, totalLines);
  const matchedItems = matchQualifiedItems(qualifiedItems, parsed.symbol, ext);

  if (matchedItems.length > 0) {
    const matches = matchedItems.map((it) => ({
      kind: it.kind,
      name: it.name,
      qualifiedName: it.qualifiedName,
      signature: it.signature,
      startLine: it.startLine,
      endLine: it.endLine,
      lineCount: Math.max(0, it.endLine - it.startLine + 1),
      depth: it.depth || 0,
      ...(typeof it.level === 'number' ? { level: it.level } : {}),
    }));
    return {
      ok: true,
      found: true,
      filePath: resolved,
      ext,
      query: parsed.symbol,
      totalLines,
      matchCount: matches.length,
      matches,
    };
  }

  const suggestions = rankSymbolSuggestions(
    qualifiedItems,
    parsed.symbol,
    options.maxSuggestions || 5
  );
  const availableSymbols = qualifiedItems.map((it) => ({
    kind: it.kind,
    name: it.name,
    qualifiedName: it.qualifiedName,
    signature: it.signature,
    startLine: it.startLine,
    endLine: it.endLine,
    depth: it.depth || 0,
    ...(typeof it.level === 'number' ? { level: it.level } : {}),
  }));

  return {
    ok: false,
    found: false,
    filePath: resolved,
    ext,
    query: parsed.symbol,
    totalLines,
    matchCount: 0,
    matches: [],
    suggestions,
    availableSymbols,
    skeletonText,
  };
}

function sliceSymbol(filePathOrTarget, symbolQuery, options = {}) {
  const parsed = parseSliceTarget(filePathOrTarget, symbolQuery);
  if (!parsed.filePath) {
    throw new Error('Missing target file path for symbol slice.');
  }
  if (!parsed.symbol) {
    throw new Error(
      'Missing symbol query. Pass "<file>#<symbol>" or provide a symbol argument.'
    );
  }
  const resolved = path.resolve(parsed.filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Target file does not exist: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`Symbol slice requires a file path, got directory: ${resolved}`);
  }

  const content = fs.readFileSync(resolved, 'utf8');
  const ext = normalizeExt(resolved);
  return sliceSymbolFromText(content, ext, parsed.symbol, {
    ...options,
    filePath: resolved,
    displayPath: options.displayPath || resolved,
  });
}

module.exports = {
  normalizeSymbolQuery,
  parseSliceTarget,
  buildQualifiedItems,
  matchQualifiedItems,
  rankSymbolSuggestions,
  locateSymbol,
  sliceSymbol,
  sliceSymbolFromText,
};
