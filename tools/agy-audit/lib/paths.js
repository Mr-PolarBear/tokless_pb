'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const PRODUCT_SOURCES = [
  { key: 'app', label: 'Antigravity App', dirName: 'antigravity' },
  { key: 'cli', label: 'Antigravity CLI', dirName: 'antigravity-cli' },
  { key: 'ide', label: 'Antigravity IDE', dirName: 'antigravity-ide' },
];

function getAntigravitySourceEntries(options = {}) {
  const customDir = options.dataDir || process.env.AGY_DATA_DIR;
  if (customDir) {
    const resolved = path.resolve(String(customDir));
    if (!fs.existsSync(resolved)) {
      throw new Error(`Antigravity directory not found at: ${resolved}`);
    }
    return [{ key: 'custom', label: 'Custom', dir: resolved }];
  }

  const sourceOpt = String(options.source || 'all').trim().toLowerCase();
  const validSources = new Set(['all', ...PRODUCT_SOURCES.map((s) => s.key)]);
  if (!validSources.has(sourceOpt)) {
    throw new Error(`Invalid --source "${options.source}". Expected one of: all, cli, app, ide.`);
  }

  const home = options.homeDir || os.homedir();
  const targets =
    sourceOpt === 'all' ? PRODUCT_SOURCES : PRODUCT_SOURCES.filter((s) => s.key === sourceOpt);
  const checked = [];
  const existing = [];

  for (const src of targets) {
    const dir = path.join(home, '.gemini', src.dirName);
    checked.push(dir);
    if (fs.existsSync(dir)) {
      existing.push({ key: src.key, label: src.label, dir });
    }
  }

  if (existing.length === 0) {
    throw new Error(`Antigravity directory not found at: ${checked.join(' or ')}`);
  }
  return existing;
}

function getAntigravityDirs(options = {}) {
  return getAntigravitySourceEntries(options).map((e) => e.dir);
}

function getAntigravityDir(options = {}) {
  return getAntigravityDirs(options)[0];
}

function getBrainRoots(options = {}) {
  return getAntigravityDirs(options)
    .map((dir) => path.join(dir, 'brain'))
    .filter((dir) => fs.existsSync(dir));
}

function getSummariesDbPaths(options = {}) {
  return getAntigravityDirs(options)
    .map((dir) => path.join(dir, 'conversation_summaries.db'))
    .filter((dbPath) => fs.existsSync(dbPath));
}

function getSummariesDbPath(options = {}) {
  const paths = getSummariesDbPaths(options);
  return paths[0] || path.join(getAntigravityDir(options), 'conversation_summaries.db');
}

function isSafeSingleDirName(name) {
  if (!name || name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  return path.basename(name) === name;
}

function openSqliteReadOnly(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    try {
      return new DatabaseSync(dbPath, { readOnly: true });
    } catch (_) {
      const normalized = path.resolve(dbPath).replace(/\\/g, '/');
      const prefix = normalized.startsWith('/') ? 'file:' : 'file:///';
      const fileUri = `${prefix}${encodeURI(normalized)}?mode=ro&immutable=1`;
      return new DatabaseSync(fileUri, { readOnly: true });
    }
  } catch (_) {
    try {
      const Database = require('better-sqlite3');
      return new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch (_) {
      return null;
    }
  }
}

function parseWorkspaceUris(rawUris) {
  if (!rawUris) return '';
  try {
    const list = JSON.parse(rawUris);
    if (Array.isArray(list)) {
      return list.map((u) => decodeURIComponent(String(u)).replace(/^file:\/\/\/?/, '')).join(', ');
    }
  } catch (_) {
    // Fallback to plain URI string
  }
  try {
    return decodeURIComponent(String(rawUris)).replace(/^file:\/\/\/?/, '');
  } catch (_) {
    return String(rawUris);
  }
}

function rowToMeta(row) {
  if (!row) return null;
  return {
    conversationId: row.conversation_id,
    title: row.title || '',
    workspace: parseWorkspaceUris(row.workspace_uris),
    lastModifiedTime: row.last_modified_time,
    stepCount: row.step_count || 0,
    status: row.status,
  };
}

function loadAllConversationMeta(rootDir) {
  const map = new Map();
  const dbPath = path.join(rootDir, 'conversation_summaries.db');
  const db = openSqliteReadOnly(dbPath);
  if (!db) return map;
  try {
    const rows = db
      .prepare(
        `SELECT conversation_id, title, step_count, last_modified_time, workspace_uris, status
         FROM conversation_summaries`
      )
      .all();
    for (const row of rows) {
      if (row && row.conversation_id) {
        map.set(row.conversation_id, rowToMeta(row));
      }
    }
  } catch (_) {
    // Ignore SQLite read error
  } finally {
    try {
      db.close();
    } catch (_) {}
  }
  return map;
}

function cleanUserPromptTitle(rawContent) {
  if (typeof rawContent !== 'string') return '';
  const stripped = rawContent
    .replace(/<ADDITIONAL_METADATA>[\s\S]*$/i, '')
    .replace(/<\/?USER_REQUEST>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return '';
  return stripped.length > 60 ? stripped.slice(0, 57) + '...' : stripped;
}

function extractFallbackTitleFromTranscript(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(65536);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    if (bytesRead <= 0) return '';
    const text = buf.subarray(0, bytesRead).toString('utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (_) {
        continue;
      }
      if (parsed && parsed.type === 'USER_INPUT' && typeof parsed.content === 'string') {
        const cleaned = cleanUserPromptTitle(parsed.content);
        if (cleaned) return cleaned;
      }
    }
  } catch (_) {
    // Ignore fallback read failure
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (_) {}
    }
  }
  return '';
}

function getConversationBrainDir(conversationId, options = {}) {
  if (typeof conversationId !== 'string' || !isSafeSingleDirName(conversationId.trim())) {
    throw new Error(`Invalid conversation ID: "${conversationId}"`);
  }
  const cleanId = conversationId.trim();
  const roots = getBrainRoots(options);
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
  const fallbackRoot = path.resolve(getAntigravityDir(options), 'brain');
  const resolved = path.resolve(fallbackRoot, cleanId);
  if (path.dirname(resolved) !== fallbackRoot) {
    throw new Error(`Conversation path escapes brain directory: "${conversationId}"`);
  }
  return resolved;
}

function findTranscriptInBrainDir(brainDir, allowDirectFiles = false) {
  const candidates = [
    {
      filePath: path.join(brainDir, '.system_generated', 'logs', 'transcript_full.jsonl'),
      logType: 'transcript_full.jsonl',
    },
    {
      filePath: path.join(brainDir, '.system_generated', 'logs', 'transcript.jsonl'),
      logType: 'transcript.jsonl',
    },
  ];
  if (allowDirectFiles) {
    candidates.push(
      { filePath: path.join(brainDir, 'transcript_full.jsonl'), logType: 'transcript_full.jsonl' },
      { filePath: path.join(brainDir, 'transcript.jsonl'), logType: 'transcript.jsonl' }
    );
  }
  for (const item of candidates) {
    if (fs.existsSync(item.filePath) && fs.statSync(item.filePath).isFile()) {
      const stat = fs.statSync(item.filePath);
      return {
        filePath: item.filePath,
        logType: item.logType,
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
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

function inferSourceFromPath(targetPath) {
  const resolved = path.resolve(targetPath);
  const parts = resolved.split(path.sep).filter(Boolean);
  const brainIdx = parts.lastIndexOf('brain');
  if (brainIdx > 0) {
    const productDirName = parts[brainIdx - 1];
    const matched = PRODUCT_SOURCES.find((s) => s.dirName === productDirName);
    if (matched) {
      return { source: matched.key, sourceLabel: matched.label };
    }
  }
  return { source: 'file', sourceLabel: 'Direct File' };
}

function looksLikePath(input) {
  return (
    input.includes('/') ||
    input.includes('\\') ||
    input.endsWith('.jsonl') ||
    input === '.' ||
    input === '..'
  );
}

function listSessions(options = {}) {
  const entries = getAntigravitySourceEntries(options);
  const rawLimit = options.limit;
  const limit =
    rawLimit === 0 || rawLimit === Infinity || rawLimit === null
      ? Infinity
      : Number.isInteger(rawLimit) && rawLimit > 0
        ? rawLimit
        : 10;

  const sessions = [];
  for (const srcEntry of entries) {
    const brainRoot = path.join(srcEntry.dir, 'brain');
    if (!fs.existsSync(brainRoot)) continue;

    const metaMap = loadAllConversationMeta(srcEntry.dir);
    let dirEntries = [];
    try {
      dirEntries = fs.readdirSync(brainRoot, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    for (const dirEnt of dirEntries) {
      if (!dirEnt.isDirectory()) continue;
      const conversationId = dirEnt.name;
      const brainDir = path.join(brainRoot, conversationId);
      const transcript = findTranscriptInBrainDir(brainDir, false);
      if (!transcript) continue;

      const dbMeta = metaMap.get(conversationId) || null;
      const title =
        (dbMeta && dbMeta.title) ||
        extractFallbackTitleFromTranscript(transcript.filePath) ||
        'Untitled Session';

      sessions.push({
        conversationId,
        shortId: conversationId.slice(0, 8),
        source: srcEntry.key,
        sourceLabel: srcEntry.label,
        rootDir: srcEntry.dir,
        filePath: transcript.filePath,
        logType: transcript.logType,
        bytes: transcript.bytes,
        mtimeMs: transcript.mtimeMs,
        mtimeIso: new Date(transcript.mtimeMs).toISOString(),
        title,
        workspace: (dbMeta && dbMeta.workspace) || '',
      });
    }
  }

  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs || a.conversationId.localeCompare(b.conversationId));
  return Number.isFinite(limit) ? sessions.slice(0, limit) : sessions;
}

function resolveSessionTarget(idOrPrefixOrPath, options = {}) {
  if (!idOrPrefixOrPath || typeof idOrPrefixOrPath !== 'string') {
    throw new Error('Conversation ID, prefix, "latest", or path is required.');
  }
  const trimmed = idOrPrefixOrPath.trim();
  if (!trimmed) {
    throw new Error('Conversation ID, prefix, "latest", or path is empty.');
  }

  const candidatePath = path.resolve(trimmed);
  if (fs.existsSync(candidatePath)) {
    const stat = fs.statSync(candidatePath);
    if (stat.isFile() && candidatePath.toLowerCase().endsWith('.jsonl')) {
      const conversationId = extractConversationIdFromPath(
        candidatePath,
        path.basename(candidatePath, '.jsonl')
      );
      const srcInfo = inferSourceFromPath(candidatePath);
      return {
        conversationId,
        source: srcInfo.source,
        sourceLabel: srcInfo.sourceLabel,
        transcriptInfo: {
          filePath: candidatePath,
          logType: path.basename(candidatePath),
          bytes: stat.size,
          mtimeMs: stat.mtimeMs,
        },
      };
    }
    if (stat.isDirectory()) {
      const info = findTranscriptInBrainDir(candidatePath, true);
      if (info || looksLikePath(trimmed)) {
        const conversationId = extractConversationIdFromPath(
          candidatePath,
          path.basename(candidatePath)
        );
        const srcInfo = inferSourceFromPath(candidatePath);
        return {
          conversationId,
          source: srcInfo.source,
          sourceLabel: srcInfo.sourceLabel,
          transcriptInfo: info,
        };
      }
    }
  }

  const latestMatch = trimmed.match(/^latest(?:~(\d+))?$/i);
  if (latestMatch) {
    const offset = latestMatch[1] ? parseInt(latestMatch[1], 10) : 0;
    const sessions = listSessions({ ...options, limit: offset + 1 });
    if (sessions.length <= offset) {
      throw new Error(`No transcript session found for "${trimmed}".`);
    }
    const picked = sessions[offset];
    return {
      conversationId: picked.conversationId,
      source: picked.source,
      sourceLabel: picked.sourceLabel,
      rootDir: picked.rootDir,
      transcriptInfo: {
        filePath: picked.filePath,
        logType: picked.logType,
        bytes: picked.bytes,
        mtimeMs: picked.mtimeMs,
      },
    };
  }

  const conversationId = resolveConversationId(trimmed, options);
  const transcriptInfo = getTranscriptInfo(conversationId, options);
  const srcInfo = transcriptInfo
    ? inferSourceFromPath(transcriptInfo.filePath)
    : { source: 'unknown', sourceLabel: '' };
  return {
    conversationId,
    source: srcInfo.source,
    sourceLabel: srcInfo.sourceLabel,
    transcriptInfo,
  };
}

function resolveConversationId(idOrPrefix, options = {}) {
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

  const brainRoots = getBrainRoots(options);

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
    const exact = entries.find((e) => e.isDirectory() && e.name.toLowerCase() === query);
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
    throw new Error(
      `Ambiguous conversation ID prefix "${idOrPrefix}" (${matches.length} matches): ${matches.slice(0, 5).join(', ')}`
    );
  }

  const dbMatches = new Set();
  for (const dbPath of getSummariesDbPaths(options)) {
    const db = openSqliteReadOnly(dbPath);
    if (!db) continue;
    try {
      const rows = db
        .prepare(
          `SELECT conversation_id FROM conversation_summaries WHERE conversation_id = ? OR conversation_id LIKE ? LIMIT 10`
        )
        .all(idOrPrefix, `${idOrPrefix}%`);
      for (const row of rows) {
        if (row.conversation_id.toLowerCase() === query) {
          return row.conversation_id;
        }
        dbMatches.add(row.conversation_id);
      }
    } catch (_) {
    } finally {
      try {
        db.close();
      } catch (_) {}
    }
  }

  const dbIds = Array.from(dbMatches);
  if (dbIds.length === 1) return dbIds[0];
  if (dbIds.length > 1) {
    throw new Error(
      `Ambiguous conversation ID prefix "${idOrPrefix}" in DB: ${dbIds.slice(0, 5).join(', ')}`
    );
  }

  return idOrPrefix;
}

function getTranscriptInfo(conversationId, options = {}) {
  if (typeof conversationId !== 'string' || !isSafeSingleDirName(conversationId.trim())) {
    throw new Error(`Invalid conversation ID: "${conversationId}"`);
  }
  const cleanId = conversationId.trim();
  const roots = getBrainRoots(options);
  for (const logName of ['transcript_full.jsonl', 'transcript.jsonl']) {
    for (const root of roots) {
      const brainDir = path.join(root, cleanId);
      const logPath = path.join(brainDir, '.system_generated', 'logs', logName);
      if (fs.existsSync(logPath) && fs.statSync(logPath).isFile()) {
        const stat = fs.statSync(logPath);
        return {
          filePath: logPath,
          logType: logName,
          bytes: stat.size,
          mtimeMs: stat.mtimeMs,
        };
      }
    }
  }
  return null;
}

function getConversationDbPaths(conversationId, options = {}) {
  if (!conversationId || typeof conversationId !== 'string' || !isSafeSingleDirName(conversationId.trim())) {
    return [];
  }
  const cleanId = conversationId.trim();
  try {
    return getAntigravityDirs(options)
      .map((dir) => path.join(dir, 'conversations', `${cleanId}.db`))
      .filter((dbPath) => fs.existsSync(dbPath) && fs.statSync(dbPath).isFile());
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
          lazyTools: [],
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

function computeMcpPreambleChars(mcpBlockText) {
  if (!mcpBlockText || typeof mcpBlockText !== 'string') return 0;
  const withoutFence = mcpBlockText.replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length));
  const m = withoutFence.match(/^#\s+[A-Za-z0-9._:@/-]+$/m);
  if (!m || typeof m.index !== 'number') return mcpBlockText.length;
  return m.index;
}

function findBestMcpBlockInText(text, anchorIdx = -1) {
  if (!text) return null;
  const re = /<mcp_servers>\r?\nEach MCP server has a directory[\s\S]*?<\/mcp_servers>/g;
  let bestMatch = null;
  let bestDist = Infinity;
  let m;
  while ((m = re.exec(text)) !== null) {
    const prevChars = text.slice(Math.max(0, m.index - 40), m.index);
    if (prevChars.includes('\\n') || prevChars.includes('\\"')) continue;
    if (anchorIdx < 0) return m[0];
    const dist = Math.abs(m.index - anchorIdx);
    if (dist < bestDist) {
      bestDist = dist;
      bestMatch = m[0];
    }
  }
  return bestMatch;
}

function detectMcpBridgeToolMask(text) {
  if (!text) return 0;
  let mask = 0;
  if (text.includes('Call a lazy-loaded MCP tool')) mask |= 1;
  if (text.includes('Lists the available resources from an MCP server')) mask |= 2;
  if (text.includes('Retrieves a specified resource')) mask |= 4;
  return mask;
}

function countBits3(mask) {
  return (mask & 1) + ((mask >> 1) & 1) + ((mask >> 2) & 1);
}

function readChunkUtf8(fd, offset, length) {
  const buf = Buffer.alloc(length);
  const bytesRead = fs.readSync(fd, buf, 0, length, offset);
  return buf.subarray(0, bytesRead).toString('utf8');
}

function inspectSessionMountedMcp(conversationId, transcriptFilePath, options = {}) {
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
  for (const p of getConversationDbPaths(conversationId, options)) {
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
      const windowRadius = 65536;
      let offset = 0;
      let sawMarker = false;
      let bestMatch = null;
      let fallbackMatch = null;
      let bridgeToolMask = 0;

      while (offset < stat.size) {
        const len = Math.min(chunkSize, stat.size - offset);
        const text = readChunkUtf8(fd, offset, len);

        if (bridgeToolMask !== 7) {
          bridgeToolMask |= detectMcpBridgeToolMask(text);
        }
        if (!fallbackMatch) {
          const direct = findBestMcpBlockInText(text, -1);
          if (direct) fallbackMatch = direct;
        }

        let searchFrom = 0;
        while (!bestMatch) {
          const idx = text.indexOf(marker, searchFrom);
          if (idx === -1) break;
          sawMarker = true;
          const absPos = offset + idx;
          const winStart = Math.max(0, absPos - windowRadius);
          const winEnd = Math.min(stat.size, absPos + windowRadius);
          const foundWindow = readChunkUtf8(fd, winStart, winEnd - winStart);
          const relMarkerIdx = foundWindow.indexOf(marker);
          if (bridgeToolMask !== 7) {
            bridgeToolMask |= detectMcpBridgeToolMask(foundWindow);
          }
          const nearMatch = findBestMcpBlockInText(foundWindow, relMarkerIdx);
          if (nearMatch) {
            bestMatch = nearMatch;
            break;
          }
          searchFrom = idx + marker.length;
        }

        if (bestMatch && bridgeToolMask === 7) break;
        if (offset + len >= stat.size) break;
        offset += chunkSize - overlap;
      }

      fs.closeSync(fd);
      fd = null;

      const resolvedMatch = bestMatch || fallbackMatch;
      if (!sawMarker && !resolvedMatch) {
        continue;
      }

      const servers = resolvedMatch ? parseMountedMcpBlock(resolvedMatch) : [];
      return {
        detectedFromSessionDb: true,
        servers,
        mcpBlockChars: resolvedMatch ? resolvedMatch.length : 0,
        mcpPreambleChars: resolvedMatch ? computeMcpPreambleChars(resolvedMatch) : 0,
        bridgeToolDeclCount: countBits3(bridgeToolMask),
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
    servers: [],
    mcpBlockChars: 0,
    mcpPreambleChars: 0,
    bridgeToolDeclCount: 0,
  };
}

function getConversationMeta(conversationId, options = {}) {
  for (const dbPath of getSummariesDbPaths(options)) {
    const db = openSqliteReadOnly(dbPath);
    if (!db) continue;
    try {
      const row = db
        .prepare(
          `SELECT conversation_id, title, step_count, last_modified_time, workspace_uris, status
           FROM conversation_summaries WHERE conversation_id = ? LIMIT 1`
        )
        .get(conversationId);
      if (!row) continue;

      return {
        conversationId: row.conversation_id,
        title: row.title || '',
        workspace: parseWorkspaceUris(row.workspace_uris),
        lastModifiedTime: row.last_modified_time,
        stepCount: row.step_count || 0,
        status: row.status,
      };
    } catch (_) {
    } finally {
      try {
        db.close();
      } catch (_) {}
    }
  }
  return null;
}

module.exports = {
  PRODUCT_SOURCES,
  isSafeSingleDirName,
  getAntigravityDir,
  getAntigravityDirs,
  getAntigravitySourceEntries,
  getBrainRoots,
  getSummariesDbPath,
  getSummariesDbPaths,
  getConversationBrainDir,
  getConversationDbPaths,
  resolveSessionTarget,
  resolveConversationId,
  listSessions,
  getTranscriptInfo,
  getConversationMeta,
  extractFallbackTitleFromTranscript,
  cleanUserPromptTitle,
  inspectSessionMountedMcp,
};
