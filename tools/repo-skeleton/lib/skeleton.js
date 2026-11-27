'use strict';

const fs = require('fs');
const path = require('path');
const { estimateTokens, splitLines, formatInt } = require('./core/lexer');
const { SUPPORTED_EXTS, getLanguageHandler } = require('./core/registry');
const { IGNORED_DIRS, resolveMaxDepth, walkDirectory } = require('./core/dir-walker');
const {
  parseSliceTarget,
  buildQualifiedItems,
  locateSymbol,
  sliceSymbol,
  sliceSymbolFromText,
} = require('./symbol-slice');

function formatSkeletonItems(result, options = {}) {
  const { includeHeader = false } = options;
  const lines = [];

  if (includeHeader) {
    const charCount = result.charCount ?? result.rawChars ?? 0;
    lines.push(
      `${result.filePath} (${result.totalLines} 行 · ${formatInt(charCount)} 字 | ~${result.rawTokens} → ~${result.skeletonTokens} tokens, -${result.savedPercent}%)`
    );
  }

  if (result.items.length === 0) {
    lines.push(`(未识别到函数/类/接口签名，全文件共 ${result.totalLines} 行)`);
  } else {
    for (const item of result.items) {
      const indent = '  '.repeat(item.depth || 0);
      lines.push(`${indent}[L${item.startLine}-L${item.endLine}] ${item.signature}`);
    }
  }

  return lines.join('\n');
}

function generateFileSkeleton(filePath, options = {}) {
  const resolved = path.resolve(filePath);
  const content = fs.readFileSync(resolved, 'utf8');
  const ext = path.extname(resolved).toLowerCase();
  const lines = splitLines(content);
  const totalLines = lines.length;
  const charCount = content.length;

  let items = [];
  const handler = getLanguageHandler(ext);
  if (handler) {
    items =
      typeof handler === 'function'
        ? handler(lines, ext, options)
        : handler.parse(lines, ext, options);
  }

  const rawTokens = estimateTokens(content);
  const bodyOnly = formatSkeletonItems(
    { filePath: resolved, totalLines, charCount, items },
    { includeHeader: false }
  );
  const skeletonTokens = estimateTokens(bodyOnly);
  const savedTokens = Math.max(0, rawTokens - skeletonTokens);
  const savedPercent = rawTokens > 0 ? Number(((savedTokens / rawTokens) * 100).toFixed(1)) : 0;

  const result = {
    filePath: resolved,
    ext,
    lineCount: totalLines,
    totalLines,
    charCount,
    rawChars: charCount,
    rawTokens,
    skeletonLines: bodyOnly.split('\n').length,
    skeletonChars: bodyOnly.length,
    skeletonTokens,
    savedTokens,
    savedPercent,
    items,
  };

  result.formatted = formatSkeletonItems(result, options);
  return result;
}

function scanFileLightweight(filePath) {
  const resolved = path.resolve(filePath);
  const content = fs.readFileSync(resolved, 'utf8');
  const ext = path.extname(resolved).toLowerCase();
  const totalLines = splitLines(content).length;
  const charCount = content.length;
  const rawTokens = estimateTokens(content);
  return {
    filePath: resolved,
    ext,
    lineCount: totalLines,
    totalLines,
    charCount,
    rawChars: charCount,
    rawTokens,
  };
}

function scanDirectorySkeleton(dirPath, options = {}) {
  const isMap = Boolean(options.map);
  const maxDepth = resolveMaxDepth(options, isMap ? 8 : 2);
  const root = path.resolve(dirPath);
  const files = [];

  walkDirectory(root, {
    maxDepth,
    exclude: options.exclude,
    extensions: SUPPORTED_EXTS,
    respectGitignore: options.respectGitignore,
    onFile(entry) {
      try {
        if (isMap) {
          const statItem = scanFileLightweight(entry.fullPath);
          files.push({
            relPath: entry.relPath,
            ...statItem,
          });
        } else {
          const skel = generateFileSkeleton(entry.fullPath, { includeHeader: false });
          files.push({
            relPath: entry.relPath,
            ...skel,
          });
        }
      } catch (_) {
        // 陷阱: 遇到无权限或损坏软链单文件时静默跳过，防止中断整个仓库目录树遍历
      }
    },
  });

  let totalLines = 0;
  let totalChars = 0;
  let totalRawTokens = 0;
  let totalSkeletonTokens = 0;
  for (const f of files) {
    totalLines += f.totalLines;
    totalChars += f.charCount;
    totalRawTokens += f.rawTokens;
    if (!isMap) {
      totalSkeletonTokens += f.skeletonTokens;
    }
  }

  if (isMap) {
    return {
      root,
      depth: maxDepth,
      map: true,
      fileCount: files.length,
      totalLines,
      totalChars,
      totalRawTokens,
      files,
    };
  }

  const totalSavedTokens = Math.max(0, totalRawTokens - totalSkeletonTokens);
  const totalSavedPercent =
    totalRawTokens > 0 ? Number(((totalSavedTokens / totalRawTokens) * 100).toFixed(1)) : 0;

  return {
    root,
    depth: maxDepth,
    fileCount: files.length,
    totalLines,
    totalChars,
    totalRawTokens,
    totalSkeletonTokens,
    totalSavedTokens,
    totalSavedPercent,
    files,
  };
}

function formatDirectoryMap(dirResult, options = {}) {
  const lines = [];
  const elapsedPart =
    typeof options.elapsedMs === 'number' ? `, 耗时 ${options.elapsedMs}ms` : '';
  const totalChars = dirResult.totalChars ?? 0;

  lines.push(
    `目录地图: ${dirResult.root} (共 ${dirResult.fileCount} 个文件 | ${formatInt(dirResult.totalLines)} 行 | ${formatInt(totalChars)} 字 | 估算 ${formatInt(dirResult.totalRawTokens)} tokens${elapsedPart})`
  );

  for (const file of dirResult.files) {
    const fileLines = file.lineCount ?? file.totalLines ?? 0;
    const fileChars = file.charCount ?? file.rawChars ?? 0;
    lines.push(`${file.relPath} (${fileLines} 行 | ${formatInt(fileChars)} 字)`);
  }

  return lines.join('\n');
}

function formatDirectorySkeleton(dirResult, options = {}) {
  const lines = [];
  const elapsedPart =
    typeof options.elapsedMs === 'number' ? `, 耗时 ${options.elapsedMs}ms` : '';
  const totalChars = dirResult.totalChars ?? 0;

  lines.push(`目录: ${dirResult.root} (深度 <= ${dirResult.depth})`);
  lines.push(
    `统计: 共 ${dirResult.fileCount} 个文件, ${dirResult.totalLines} 行 · ${formatInt(totalChars)} 字 | 全文估算 ${dirResult.totalRawTokens} tokens → 骨架估算 ${dirResult.totalSkeletonTokens} tokens (节省 ${dirResult.totalSavedPercent}%${elapsedPart})`
  );

  for (const file of dirResult.files) {
    const fileChars = file.charCount ?? file.rawChars ?? 0;
    lines.push('');
    lines.push(
      `## ${file.relPath} (${file.totalLines} 行 | ${formatInt(fileChars)} 字 | ${file.rawTokens} → ${file.skeletonTokens} tokens, -${file.savedPercent}%)`
    );
    if (!file.items || file.items.length === 0) {
      lines.push('  (无显式函数/类签名)');
    } else {
      for (const item of file.items) {
        const indent = '  '.repeat(item.depth || 0);
        lines.push(`${indent}[L${item.startLine}-L${item.endLine}] ${item.signature}`);
      }
    }
  }

  return lines.join('\n');
}

function generateRepoMap(targetPath, options = {}) {
  return generateSkeleton(targetPath, { ...options, map: true });
}

function generateSkeleton(targetPath, options = {}) {
  if (options.symbol !== undefined && options.symbol !== null && String(options.symbol).trim() !== '') {
    return sliceSymbol(targetPath, options.symbol, options);
  }
  const resolved = path.resolve(targetPath);
  const stat = fs.statSync(resolved);
  const t0 = performance.now();
  const isMap = Boolean(options.map);

  if (stat.isFile()) {
    if (isMap) {
      const item = scanFileLightweight(resolved);
      const relPath = path.basename(resolved);
      const elapsedMs = Number((performance.now() - t0).toFixed(2));
      const text = `${relPath} (${item.totalLines} 行 | ${formatInt(item.charCount)} 字)`;
      return {
        mode: 'map',
        elapsedMs,
        root: path.dirname(resolved),
        depth: 0,
        map: true,
        fileCount: 1,
        totalLines: item.totalLines,
        totalChars: item.charCount,
        totalRawTokens: item.rawTokens,
        files: [{ relPath, ...item }],
        formatted: text,
        text,
      };
    }

    const result = generateFileSkeleton(resolved, {
      includeHeader: Boolean(options.includeHeader),
    });
    const elapsedMs = Number((performance.now() - t0).toFixed(2));
    const text = [
      `文件: ${result.filePath}`,
      `统计: 总行数 ${result.totalLines} 行 · ${formatInt(result.charCount)} 字 | 全文估算 ${result.rawTokens} tokens → 骨架估算 ${result.skeletonTokens} tokens (节省 ${result.savedPercent}%, 耗时 ${elapsedMs}ms)`,
      '---',
      result.formatted,
    ].join('\n');
    return {
      mode: 'file',
      elapsedMs,
      ...result,
      text,
    };
  }

  if (stat.isDirectory()) {
    if (isMap) {
      const result = scanDirectorySkeleton(resolved, { ...options, map: true });
      const elapsedMs = Number((performance.now() - t0).toFixed(2));
      const formatted = formatDirectoryMap(result, { elapsedMs });
      return {
        mode: 'map',
        elapsedMs,
        ...result,
        formatted,
        text: formatted,
      };
    }

    const result = scanDirectorySkeleton(resolved, options);
    const elapsedMs = Number((performance.now() - t0).toFixed(2));
    const formatted = formatDirectorySkeleton(result, { elapsedMs });
    return {
      mode: 'directory',
      elapsedMs,
      ...result,
      formatted,
      text: formatted,
    };
  }

  throw new Error(`Unsupported target type: ${resolved}`);
}

module.exports = {
  IGNORED_DIRS,
  SUPPORTED_EXTS,
  walkDirectory,
  estimateTokens,
  scanFileLightweight,
  generateFileSkeleton,
  scanDirectorySkeleton,
  formatSkeletonItems,
  formatDirectorySkeleton,
  formatDirectoryMap,
  generateRepoMap,
  generateSkeleton,
  parseSliceTarget,
  buildQualifiedItems,
  locateSymbol,
  sliceSymbol,
  sliceSymbolFromText,
};
