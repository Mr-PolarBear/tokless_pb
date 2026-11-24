'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

function getAntigravityDirs() {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.gemini', 'antigravity'),
    path.join(home, '.gemini', 'antigravity-cli')
  ];
  const existing = candidates.filter(dir => fs.existsSync(dir));
  if (existing.length === 0) {
    throw new Error(`Antigravity directory not found at: ${candidates.join(' or ')}`);
  }
  return existing;
}

function getAntigravityDir() {
  return getAntigravityDirs()[0];
}

function getBrainRoots() {
  return getAntigravityDirs()
    .map(dir => path.join(dir, 'brain'))
    .filter(dir => fs.existsSync(dir));
}

function getSummariesDbPaths() {
  return getAntigravityDirs()
    .map(dir => path.join(dir, 'conversation_summaries.db'))
    .filter(dbPath => fs.existsSync(dbPath));
}

function getSummariesDbPath() {
  const paths = getSummariesDbPaths();
  return paths[0] || path.join(getAntigravityDir(), 'conversation_summaries.db');
}

function isSafeSingleDirName(name) {
  if (!name || name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  return path.basename(name) === name;
}

function getConversationBrainDir(conversationId) {
  if (typeof conversationId !== 'string' || !isSafeSingleDirName(conversationId.trim())) {
    throw new Error(`Invalid conversation ID: "${conversationId}"`);
  }
  const cleanId = conversationId.trim();
  const roots = getBrainRoots();
  for (const root of roots) {
    const resolvedRoot = path.resolve(root);
    const candidate = path.resolve(resolvedRoot, cleanId);
    if (path.dirname(candidate) !== resolvedRoot) {
      throw new Error(`Conversation path escapes brain directory: "${conversationId}"`);
    }
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  const fallbackRoot = path.resolve(getAntigravityDir(), 'brain');
  const resolved = path.resolve(fallbackRoot, cleanId);
  if (path.dirname(resolved) !== fallbackRoot) {
    throw new Error(`Conversation path escapes brain directory: "${conversationId}"`);
  }
  return resolved;
}

function findTranscriptInBrainDir(brainDir, allowDirectFiles = false) {
  const candidates = [
    { filePath: path.join(brainDir, '.system_generated', 'logs', 'transcript_full.jsonl'), logType: 'transcript_full.jsonl' },
    { filePath: path.join(brainDir, '.system_generated', 'logs', 'transcript.jsonl'), logType: 'transcript.jsonl' }
  ];
  if (allowDirectFiles) {
    candidates.push(
      { filePath: path.join(brainDir, 'transcript_full.jsonl'), logType: 'transcript_full.jsonl' },
      { filePath: path.join(brainDir, 'transcript.jsonl'), logType: 'transcript.jsonl' }
    );
  }
  for (const item of candidates) {
    if (fs.existsSync(item.filePath) && fs.statSync(item.filePath).isFile()) {
      return {
        filePath: item.filePath,
        logType: item.logType,
        bytes: fs.statSync(item.filePath).size
      };
    }
  }
  return null;
}

function extractConversationIdFromPath(targetPath, fallbackName) {
  const parts = path.resolve(targetPath).split(path.sep).filter(Boolean);
  const brainIdx = parts.lastIndexOf('brain');
  if (brainIdx >= 0 && brainIdx + 1 < parts.length) {
    return parts[brainIdx + 1];
  }
  return fallbackName;
}

function looksLikePath(input) {
  return input.includes('/') || input.includes('\\') || input.endsWith('.jsonl') || input === '.' || input === '..';
}

function resolveSessionTarget(idOrPrefixOrPath) {
  if (!idOrPrefixOrPath || typeof idOrPrefixOrPath !== 'string') {
    throw new Error('Conversation ID, prefix, or path is required.');
  }
  const trimmed = idOrPrefixOrPath.trim();
  if (!trimmed) {
    throw new Error('Conversation ID, prefix, or path is empty.');
  }

  const candidatePath = path.resolve(trimmed);
  if (fs.existsSync(candidatePath)) {
    const stat = fs.statSync(candidatePath);
    if (stat.isFile() && candidatePath.toLowerCase().endsWith('.jsonl')) {
      const conversationId = extractConversationIdFromPath(candidatePath, path.basename(candidatePath, '.jsonl'));
      return {
        conversationId,
        transcriptInfo: {
          filePath: candidatePath,
          logType: path.basename(candidatePath),
          bytes: stat.size
        }
      };
    }
    if (stat.isDirectory()) {
      const info = findTranscriptInBrainDir(candidatePath, true);
      if (info || looksLikePath(trimmed)) {
        const conversationId = extractConversationIdFromPath(candidatePath, path.basename(candidatePath));
        return {
          conversationId,
          transcriptInfo: info
        };
      }
    }
  }

  const conversationId = resolveConversationId(trimmed);
  return {
    conversationId,
    transcriptInfo: getTranscriptInfo(conversationId)
  };
}

function resolveConversationId(idOrPrefix) {
  if (!idOrPrefix || typeof idOrPrefix !== 'string') {
    throw new Error('Conversation ID or prefix is required.');
  }
  const trimmed = idOrPrefix.trim();
  const query = trimmed.toLowerCase();
  if (!query) {
    throw new Error('Conversation ID or prefix is empty.');
  }
  if (!isSafeSingleDirName(trimmed)) {
    throw new Error(`Invalid conversation ID or prefix: "${idOrPrefix}"`);
  }

  const brainRoots = getBrainRoots();

  // 陷阱: 沙箱环境下 fs.readdirSync(brainRoot) 可能被 EPERM 拦截，完整会话 ID 先做 stat 直连命中
  for (const brainRoot of brainRoots) {
    const resolvedBrainRoot = path.resolve(brainRoot);
    for (const candidate of new Set([trimmed, query])) {
      const directDir = path.resolve(resolvedBrainRoot, candidate);
      if (path.dirname(directDir) !== resolvedBrainRoot) continue;
      try {
        if (fs.existsSync(directDir) && fs.statSync(directDir).isDirectory()) {
          return candidate;
        }
      } catch (_) {}
    }
  }

  const prefixMatches = new Set();
  for (const brainRoot of brainRoots) {
    const entries = fs.readdirSync(brainRoot, { withFileTypes: true });
    const exact = entries.find(e => e.isDirectory() && e.name.toLowerCase() === query);
    if (exact) return exact.name;

    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.toLowerCase().startsWith(query)) {
        prefixMatches.add(entry.name);
      }
    }
  }

  const matches = Array.from(prefixMatches);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`Ambiguous conversation ID prefix "${idOrPrefix}" (${matches.length} matches): ${matches.slice(0, 5).join(', ')}`);
  }

  const dbMatches = new Set();
  for (const dbPath of getSummariesDbPaths()) {
    try {
      const Database = require('better-sqlite3');
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const rows = db.prepare(
        `SELECT conversation_id FROM conversation_summaries WHERE conversation_id = ? OR conversation_id LIKE ? LIMIT 10`
      ).all(idOrPrefix, `${idOrPrefix}%`);
      db.close();
      for (const row of rows) {
        if (row.conversation_id.toLowerCase() === query) {
          return row.conversation_id;
        }
        dbMatches.add(row.conversation_id);
      }
    } catch {
    }
  }

  const dbIds = Array.from(dbMatches);
  if (dbIds.length === 1) return dbIds[0];
  if (dbIds.length > 1) {
    throw new Error(`Ambiguous conversation ID prefix "${idOrPrefix}" in DB: ${dbIds.slice(0, 5).join(', ')}`);
  }

  return idOrPrefix;
}

function getTranscriptInfo(conversationId) {
  if (typeof conversationId !== 'string' || !isSafeSingleDirName(conversationId.trim())) {
    throw new Error(`Invalid conversation ID: "${conversationId}"`);
  }
  const cleanId = conversationId.trim();
  const roots = getBrainRoots();
  for (const logName of ['transcript_full.jsonl', 'transcript.jsonl']) {
    for (const root of roots) {
      const brainDir = path.join(root, cleanId);
      const logPath = path.join(brainDir, '.system_generated', 'logs', logName);
      if (fs.existsSync(logPath) && fs.statSync(logPath).isFile()) {
        return {
          filePath: logPath,
          logType: logName,
          bytes: fs.statSync(logPath).size
        };
      }
    }
  }
  return null;
}

function getConversationDbPaths(conversationId) {
  if (!conversationId || typeof conversationId !== 'string' || !isSafeSingleDirName(conversationId.trim())) {
    return [];
  }
  const cleanId = conversationId.trim();
  try {
    return getAntigravityDirs()
      .map(dir => path.join(dir, 'conversations', `${cleanId}.db`))
      .filter(dbPath => fs.existsSync(dbPath) && fs.statSync(dbPath).isFile());
  } catch {
    return [];
  }
}

function parseMountedMcpBlock(mcpBlockText) {
  const withoutFence = mcpBlockText.replace(/```[\s\S]*?```/g, '');
  const servers = new Map();
  let curServer = null;
  let curMode = null;

  for (const line of withoutFence.split(/\r?\n/)) {
    const trimmed = line.trim();
    const h = trimmed.match(/^#\s+([A-Za-z0-9._:@/-]+)$/);
    if (h) {
      curServer = h[1];
      if (!servers.has(curServer)) {
        servers.set(curServer, {
          name: curServer,
          prefix: `mcp_${curServer}_`,
          eagerTools: [],
          lazyTools: []
        });
      }
      curMode = null;
    } else if (curServer && trimmed === 'Eager:') {
      curMode = 'eager';
    } else if (curServer && trimmed === 'Lazy:') {
      curMode = 'lazy';
    } else if (curServer && curMode && /^[A-Za-z0-9._-]+$/.test(trimmed)) {
      const entry = servers.get(curServer);
      if (curMode === 'eager') entry.eagerTools.push(trimmed);
      else entry.lazyTools.push(trimmed);
    }
  }
  return Array.from(servers.values());
}

function readChunkUtf8(fd, offset, length) {
  const buf = Buffer.alloc(length);
  const bytesRead = fs.readSync(fd, buf, 0, length, offset);
  return buf.subarray(0, bytesRead).toString('utf8');
}

function inspectSessionMountedMcp(conversationId, transcriptFilePath) {
  const candidateDbs = [];
  if (transcriptFilePath && isSafeSingleDirName(String(conversationId || '').trim())) {
    const parts = path.resolve(transcriptFilePath).split(path.sep);
    const brainIdx = parts.lastIndexOf('brain');
    if (brainIdx > 0) {
      const agyRoot = parts.slice(0, brainIdx).join(path.sep);
      const siblingDb = path.join(agyRoot, 'conversations', `${conversationId.trim()}.db`);
      if (fs.existsSync(siblingDb) && fs.statSync(siblingDb).isFile()) {
        candidateDbs.push(siblingDb);
      }
    }
  }
  for (const p of getConversationDbPaths(conversationId)) {
    if (!candidateDbs.includes(p)) candidateDbs.push(p);
  }

  for (const dbPath of candidateDbs) {
    let fd = null;
    try {
      const stat = fs.statSync(dbPath);
      if (stat.size <= 0) continue;
      fd = fs.openSync(dbPath, 'r');

      const marker = `Conversation ID: ${conversationId}`;
      const chunkSize = 2 * 1024 * 1024;
      const overlap = 65536;
      let offset = 0;
      let foundWindow = null;
      let relMarkerIdx = -1;

      while (offset < stat.size) {
        const len = Math.min(chunkSize, stat.size - offset);
        const text = readChunkUtf8(fd, offset, len);
        const idx = text.indexOf(marker);
        if (idx !== -1) {
          const winStart = Math.max(0, offset + idx - 49152);
          const winEnd = Math.min(stat.size, offset + idx + 49152);
          foundWindow = readChunkUtf8(fd, winStart, winEnd - winStart);
          relMarkerIdx = foundWindow.indexOf(marker);
          break;
        }
        if (offset + len >= stat.size) break;
        offset += chunkSize - overlap;
      }

      fs.closeSync(fd);
      fd = null;

      if (!foundWindow || relMarkerIdx === -1) {
        continue;
      }

      const re = /<mcp_servers>\r?\nEach MCP server has a directory[\s\S]*?<\/mcp_servers>/g;
      let bestMatch = null;
      let bestDist = Infinity;
      let m;
      while ((m = re.exec(foundWindow)) !== null) {
        const prevChars = foundWindow.slice(Math.max(0, m.index - 40), m.index);
        if (prevChars.includes('\\n') || prevChars.includes('\\"')) continue;
        const dist = Math.abs(m.index - relMarkerIdx);
        if (dist < bestDist) {
          bestDist = dist;
          bestMatch = m[0];
        }
      }

      const servers = bestMatch ? parseMountedMcpBlock(bestMatch) : [];
      return {
        detectedFromSessionDb: true,
        servers
      };
    } catch {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
    }
  }

  return {
    detectedFromSessionDb: false,
    servers: []
  };
}

function getConversationMeta(conversationId) {
  for (const dbPath of getSummariesDbPaths()) {
    try {
      const Database = require('better-sqlite3');
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const row = db.prepare(
        `SELECT conversation_id, title, step_count, last_modified_time, workspace_uris, status
         FROM conversation_summaries WHERE conversation_id = ? LIMIT 1`
      ).get(conversationId);
      db.close();
      if (!row) continue;

      let workspace = '';
      if (row.workspace_uris) {
        try {
          const list = JSON.parse(row.workspace_uris);
          if (Array.isArray(list)) {
            workspace = list.map(u => decodeURIComponent(u).replace(/^file:\/\/\/?/, '')).join(', ');
          }
        } catch {
          workspace = decodeURIComponent(row.workspace_uris).replace(/^file:\/\/\/?/, '');
        }
      }
      return {
        conversationId: row.conversation_id,
        title: row.title || 'Untitled Session',
        workspace,
        lastModifiedTime: row.last_modified_time,
        stepCount: row.step_count || 0,
        status: row.status
      };
    } catch {}
  }
  return null;
}

/**
 * 按最近更新时间降序列出本地有效会话（供无 conversationId 的全局面板兜底定位最近活跃会话）
 */
function listSessions(limit = 10) {
  const maxItems = Math.max(1, Number(limit) || 10);
  const seen = new Map();
  for (const brainRoot of getBrainRoots()) {
    let entries = [];
    try {
      entries = fs.readdirSync(brainRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSafeSingleDirName(entry.name)) continue;
      const brainDir = path.join(brainRoot, entry.name);
      const info = findTranscriptInBrainDir(brainDir);
      if (!info) continue;
      try {
        const mtimeMs = fs.statSync(info.filePath).mtimeMs;
        const prev = seen.get(entry.name);
        if (!prev || mtimeMs > prev.mtimeMs) {
          seen.set(entry.name, { id: entry.name, filePath: info.filePath, mtimeMs });
        }
      } catch {}
    }
  }
  return Array.from(seen.values())
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxItems);
}

module.exports = {
  isSafeSingleDirName,
  getAntigravityDir,
  getAntigravityDirs,
  getBrainRoots,
  getSummariesDbPath,
  getSummariesDbPaths,
  getConversationBrainDir,
  getConversationDbPaths,
  resolveSessionTarget,
  resolveConversationId,
  getTranscriptInfo,
  getConversationMeta,
  inspectSessionMountedMcp,
  listSessions
};
