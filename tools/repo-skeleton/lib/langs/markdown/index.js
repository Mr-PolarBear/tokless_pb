'use strict';

const ID = 'markdown';
const EXTENSIONS = ['.md', '.mdx', '.markdown'];

function parse(lines, ext = '.md', options = {}) {
  if (ext && typeof ext === 'object') {
    options = ext;
    ext = '.md';
  }
  const lineOffset = options.lineOffset || 0;
  const headings = [];
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      const len = fenceMatch[1].length;
      if (!inFence) {
        inFence = true;
        fenceChar = marker;
        fenceLen = len;
      } else if (marker === fenceChar && len >= fenceLen && /^(`+|~+)\s*$/.test(trimmed)) {
        inFence = false;
        fenceChar = '';
        fenceLen = 0;
      }
      continue;
    }
    if (inFence) continue;

    const hMatch = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (hMatch) {
      headings.push({
        level: hMatch[1].length,
        signature: `${hMatch[1]} ${hMatch[2].trim()}`,
        name: hMatch[2].trim(),
        startIdx: i,
      });
    }
  }

  if (headings.length === 0) return [];
  const minLevel = Math.min(...headings.map((h) => h.level));

  return headings.map((h, idx) => {
    let endIdx = lines.length - 1;
    for (let next = idx + 1; next < headings.length; next++) {
      if (headings[next].level <= h.level) {
        endIdx = headings[next].startIdx - 1;
        break;
      }
    }
    while (endIdx > h.startIdx && !lines[endIdx].trim()) {
      endIdx--;
    }
    return {
      kind: 'heading',
      name: h.name,
      signature: h.signature,
      startLine: h.startIdx + 1 + lineOffset,
      endLine: endIdx + 1 + lineOffset,
      depth: h.level - minLevel,
      level: h.level,
    };
  });
}

module.exports = {
  id: ID,
  extensions: EXTENSIONS,
  parse,
};
