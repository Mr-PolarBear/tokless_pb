'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { estimateTokens } = require('./analyzer');

const CONFIG_DIR_NAMES = ['.agents', '.agent', '_agents', '_agent'];

function parseFrontmatterTrigger(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^\s*trigger\s*:\s*['"]?([A-Za-z0-9_-]+)['"]?\s*$/i);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

function canonicalDocKey(filePath) {
  try {
    const rp = fs.realpathSync(filePath);
    return process.platform === 'win32' ? rp.toLowerCase() : rp;
  } catch (_) {
    const resolved = path.resolve(filePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
}

// Baseline per-step schema token estimates
const DEFAULT_BUILTIN_TOOLS_EST_TOKENS = 4200;
const DEFAULT_SUBAGENT_READONLY_EST_TOKENS = 900;
const HEAVY_MCP_EST_TOKENS = 3000;
const STANDARD_MCP_EST_TOKENS = 1500;
const HEAVY_MCP_NAME_RE = /chrome|devtools|playwright|puppeteer|browser|github|gitlab|atlassian|jira|confluence|linear|figma|notion|supabase|postgres|mysql|sqlite|databricks|looker/i;

const KNOWN_TOOL_EST_TOKENS = {
  read_file: 220,
  view_file: 220,
  write_file: 260,
  edit_file: 280,
  run_command: 320,
  manage_task: 220,
  search_web: 160,
  ask_question: 220,
  swarm: 580,
  run_workflow: 360
};

function stripJsonCommentsAndTrailingCommas(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let out = '';
  let inStr = false;
  let quote = '';
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (inStr) {
      out += ch;
      if (ch === '\\' && i + 1 < raw.length) {
        out += raw[++i];
      } else if (ch === quote) {
        inStr = false;
      }
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < raw.length && raw[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(stripJsonCommentsAndTrailingCommas(raw));
  } catch {
    return null;
  }
}

function parseAgentMarkdown(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const norm = raw.replace(/\r\n/g, '\n');
  let frontmatterText = '';
  let bodyText = norm;

  const fmMatch = norm.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (fmMatch) {
    frontmatterText = fmMatch[1];
    bodyText = fmMatch[2];
  }

  const fm = {};
  if (frontmatterText) {
    const lines = frontmatterText.split('\n');
    let currentListKey = null;
    for (const line of lines) {
      const listItemMatch = line.match(/^\s*-\s+(.+?)\s*$/);
      if (listItemMatch && currentListKey) {
        if (!Array.isArray(fm[currentListKey])) fm[currentListKey] = [];
        fm[currentListKey].push(listItemMatch[1].replace(/^['"]|['"]$/g, '').trim());
        continue;
      }
      const kvMatch = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (!kvMatch) continue;
      const key = kvMatch[1];
      const valRaw = kvMatch[2].trim();
      currentListKey = null;

      if (valRaw === '') {
        currentListKey = key;
        fm[key] = [];
      } else if (valRaw.startsWith('[') && valRaw.endsWith(']')) {
        const inner = valRaw.slice(1, -1).trim();
        fm[key] = inner
          ? inner.split(',').map(s => s.replace(/^['"]|['"]$/g, '').trim()).filter(Boolean)
          : [];
      } else if (valRaw === 'true') {
        fm[key] = true;
      } else if (valRaw === 'false') {
        fm[key] = false;
      } else {
        fm[key] = valRaw.replace(/^['"]|['"]$/g, '');
      }
    }
  }

  return { frontmatter: fm, bodyText };
}

function estimateToolsSchemaTokens(toolsField, isMainAgent) {
  if (Array.isArray(toolsField)) {
    if (toolsField.length === 0) return 0;
    return toolsField.reduce((sum, name) => sum + (KNOWN_TOOL_EST_TOKENS[name] || 240), 0);
  }
  return isMainAgent ? DEFAULT_BUILTIN_TOOLS_EST_TOKENS : DEFAULT_SUBAGENT_READONLY_EST_TOKENS;
}

function collectMcpServersFromFile(filePath, scope, displaySource, outList) {
  const parsed = readJsonSafe(filePath);
  if (!parsed || typeof parsed !== 'object') return;
  const serversMap = parsed.mcpServers && typeof parsed.mcpServers === 'object'
    ? parsed.mcpServers
    : null;
  if (!serversMap) return;

  for (const [serverName, cfg] of Object.entries(serversMap)) {
    if (!cfg || typeof cfg !== 'object') continue;
    const enabled = cfg.disabled !== true;
    const transport = cfg.url || cfg.serverUrl ? 'http' : 'stdio';
    const isHeavy = HEAVY_MCP_NAME_RE.test(serverName) ||
      (typeof cfg.command === 'string' && HEAVY_MCP_NAME_RE.test(cfg.command)) ||
      (Array.isArray(cfg.args) && cfg.args.some(a => HEAVY_MCP_NAME_RE.test(String(a))));
    const tier = isHeavy ? 'heavy' : 'standard';
    const estTokensPerStep = enabled ? (isHeavy ? HEAVY_MCP_EST_TOKENS : STANDARD_MCP_EST_TOKENS) : 0;

    outList.push({
      name: serverName,
      scope,
      source: displaySource,
      transport,
      enabled,
      tier,
      estTokensPerStep
    });
  }
}

function auditMcpAndTools(rootDir, options = {}) {
  const homeDir = options.homeDir ? path.resolve(options.homeDir) : os.homedir();
  const mcpServers = [];

  // 1. Global ~/.gemini/config/mcp_config.json
  const globalMcpPath = path.join(homeDir, '.gemini', 'config', 'mcp_config.json');
  collectMcpServersFromFile(
    globalMcpPath,
    'global',
    '~/.gemini/config/mcp_config.json',
    mcpServers
  );

  // 2. Global enabled plugins ~/.gemini/config/plugins/*/mcp_config.json
  const globalConfig = readJsonSafe(path.join(homeDir, '.gemini', 'config', 'config.json')) || {};
  const pluginStateMap = (globalConfig.plugins && typeof globalConfig.plugins === 'object')
    ? globalConfig.plugins
    : {};
  const pluginsDir = path.join(homeDir, '.gemini', 'config', 'plugins');
  if (fs.existsSync(pluginsDir) && fs.statSync(pluginsDir).isDirectory()) {
    for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const pDir = path.join(pluginsDir, entry.name);
      const manifest = readJsonSafe(path.join(pDir, 'plugin.json'));
      const userOverride = pluginStateMap[entry.name];
      const isEnabled = userOverride && typeof userOverride.enabled === 'boolean'
        ? userOverride.enabled
        : !(manifest && manifest.disabled === true);
      if (!isEnabled) continue;

      collectMcpServersFromFile(
        path.join(pDir, 'mcp_config.json'),
        'plugin',
        `~/.gemini/config/plugins/${entry.name}/mcp_config.json`,
        mcpServers
      );
    }
  }

  // 3. Workspace MCP configs (.mcp.json, .agents/.agent/_agents/_agent mcp_config.json & workspace plugins, plugin root)
  const workspaceMcpCandidates = [{ p: path.join(rootDir, '.mcp.json'), label: '.mcp.json' }];
  const agentDirs = [];
  for (const cfgName of CONFIG_DIR_NAMES) {
    const cfgDir = path.join(rootDir, cfgName);
    if (!fs.existsSync(cfgDir) || !fs.statSync(cfgDir).isDirectory()) continue;
    workspaceMcpCandidates.push({
      p: path.join(cfgDir, 'mcp_config.json'),
      label: `${cfgName}/mcp_config.json`,
    });
    agentDirs.push(path.join(cfgDir, 'agents'));

    const wsPluginsDir = path.join(cfgDir, 'plugins');
    if (fs.existsSync(wsPluginsDir) && fs.statSync(wsPluginsDir).isDirectory()) {
      for (const pEntry of fs.readdirSync(wsPluginsDir, { withFileTypes: true })) {
        if (!pEntry.isDirectory()) continue;
        const pRoot = path.join(wsPluginsDir, pEntry.name);
        workspaceMcpCandidates.push({
          p: path.join(pRoot, 'mcp_config.json'),
          label: `${cfgName}/plugins/${pEntry.name}/mcp_config.json`,
        });
        agentDirs.push(path.join(pRoot, 'agents'));
      }
    }
  }
  if (fs.existsSync(path.join(rootDir, 'plugin.json'))) {
    workspaceMcpCandidates.push({ p: path.join(rootDir, 'mcp_config.json'), label: 'mcp_config.json' });
    agentDirs.push(path.join(rootDir, 'agents'));
  }
  for (const item of workspaceMcpCandidates) {
    collectMcpServersFromFile(item.p, 'workspace', item.label, mcpServers);
  }

  const enabledMcpServers = mcpServers.filter(s => s.enabled);
  const activeMcpEstTokensPerStep = enabledMcpServers.reduce((sum, s) => sum + s.estTokensPerStep, 0);
  const defaultToolAndMcpPerStep = DEFAULT_BUILTIN_TOOLS_EST_TOKENS + activeMcpEstTokensPerStep;
  const est30StepSnowballTokens = defaultToolAndMcpPerStep * 30;

  // 4. Scan project agent definitions (.agents/.agent/_agents/_agent/agents/*.md and plugin agents/*.md)

  const agents = [];
  const seenAgentPaths = new Set();
  for (const aDir of agentDirs) {
    if (!fs.existsSync(aDir) || !fs.statSync(aDir).isDirectory()) continue;
    for (const entry of fs.readdirSync(aDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      const fullPath = path.resolve(aDir, entry.name);
      if (seenAgentPaths.has(fullPath)) continue;
      seenAgentPaths.add(fullPath);

      const { frontmatter, bodyText } = parseAgentMarkdown(fullPath);
      const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
      const agentName = frontmatter.name || path.basename(entry.name, '.md');
      const inheritMcp = frontmatter.inheritMcp === false ? false : true;
      const isMainAgent = frontmatter.mainAgent !== false;
      const hasExplicitTools = Array.isArray(frontmatter.tools);
      const toolsList = hasExplicitTools ? frontmatter.tools : null;
      const toolCount = hasExplicitTools ? toolsList.length : null;
      const toolsEstTokens = estimateToolsSchemaTokens(toolsList, isMainAgent);
      const mcpEstTokens = inheritMcp ? activeMcpEstTokensPerStep : 0;
      const promptEstTokens = estimateTokens(bodyText.trim().length);
      const toolAndMcpPerStep = toolsEstTokens + mcpEstTokens;
      const savedPerStepTokens = Math.max(0, defaultToolAndMcpPerStep - toolAndMcpPerStep);

      agents.push({
        name: agentName,
        relativePath: relPath,
        inheritMcp,
        mainAgent: Boolean(frontmatter.mainAgent),
        subagent: frontmatter.subagent !== false,
        hasExplicitTools,
        tools: toolsList,
        toolCount,
        toolsEstTokens,
        mcpEstTokens,
        promptEstTokens,
        toolAndMcpPerStep,
        totalPerStepEstTokens: toolAndMcpPerStep + promptEstTokens,
        savedPerStepTokens
      });
    }
  }

  const slimAgents = agents.filter(a => !a.inheritMcp);
  const mcpInheritingAgents = agents.filter(a => a.inheritMcp);
  const suggestions = [];

  if (enabledMcpServers.length > 0 && slimAgents.length === 0) {
    suggestions.push(
      `检测到 ${enabledMcpServers.length} 个已启用 MCP Server（按全量 Eager Schema 上界估算每步额外注入约 ${activeMcpEstTokensPerStep.toLocaleString('en-US')} Token，30 步滚雪球约 ${(activeMcpEstTokensPerStep * 30).toLocaleString('en-US')} Token），且当前项目尚未配置净身角色。建议在 .agents/agents/ 下定义 inheritMcp: false 与最小 tools 清单的专属角色（或直接运行 agy --agent tokless-coder / tokless-reviewer）卸除无关 MCP 底座税。`
    );
  } else if (agents.length === 0) {
    suggestions.push(
      `默认全量内置工具底座每步约占 ${DEFAULT_BUILTIN_TOOLS_EST_TOKENS.toLocaleString('en-US')} Token（30 步累计约 ${(DEFAULT_BUILTIN_TOOLS_EST_TOKENS * 30).toLocaleString('en-US')} Cache Read）。高频纯代码子代理建议挂载 inheritMcp: false + tools: [read_file, write_file, edit_file, run_command]（省 ~70% 工具底座），纯文本润色/摘要子代理建议设 tools: []（0 工具底座税）。`
    );
  }

  if (enabledMcpServers.length > 0 && mcpInheritingAgents.length > 0) {
    const names = mcpInheritingAgents.map(a => a.name).join(', ');
    suggestions.push(
      `角色 [${names}] 当前开启或默认继承了 MCP (inheritMcp: true)，按全量 Eager Schema 上界估算每步多付约 ${activeMcpEstTokensPerStep.toLocaleString('en-US')} Token；若该角色无需调用浏览器或外部 MCP 工具，建议显式加上 inheritMcp: false。`
    );
  }

  return {
    builtinDefaultToolsEstTokensPerStep: DEFAULT_BUILTIN_TOOLS_EST_TOKENS,
    totalMcpCount: mcpServers.length,
    enabledMcpCount: enabledMcpServers.length,
    activeMcpEstTokensPerStep,
    defaultSessionEstTokensPerStep: defaultToolAndMcpPerStep,
    est30StepSnowballTokens,
    mcpServers,
    agents,
    suggestions
  };
}

function findFileCaseInsensitive(dir, targetName) {
  if (!fs.existsSync(dir)) return null;
  const exact = path.join(dir, targetName);
  if (fs.existsSync(exact) && fs.statSync(exact).isFile()) {
    return exact;
  }
  const lower = targetName.toLowerCase();
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const match = entries.find(e => e.isFile() && e.name.toLowerCase() === lower);
  return match ? path.join(dir, match.name) : null;
}

function inspectDocFile(filePath, rootDir, category, loadMode) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.length === 0 ? 0 : content.split(/\r?\n/).length;
  const chars = content.length;
  const bytes = Buffer.byteLength(content, 'utf8');
  const estTokens = estimateTokens(chars);
  const relPath = path.relative(rootDir, filePath).replace(/\\/g, '/');

  let effectiveLoadMode = loadMode;
  let effectiveCategory = category;
  if (category === 'rule') {
    const trigger = parseFrontmatterTrigger(content);
    if (trigger === 'model_decision' || trigger === 'glob') {
      effectiveLoadMode = 'Progressive Disclosure';
      effectiveCategory = `rule (${trigger})`;
    }
  }

  const isAlwaysOn = effectiveLoadMode === 'Always-On';

  return {
    relativePath: relPath,
    absolutePath: filePath,
    category: effectiveCategory,
    loadMode: effectiveLoadMode,
    lines,
    chars,
    bytes,
    estTokens,
    est30StepTokens: isAlwaysOn ? estTokens * 30 : null
  };
}

function auditProject(dirPath, options = {}) {
  if (!dirPath) {
    throw new Error('Project directory path is required.');
  }
  const rootDir = path.resolve(dirPath);
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    throw new Error(`Project directory not found: ${rootDir}`);
  }

  const files = [];
  const seenDocPaths = new Set();
  const pushDoc = (filePath, category, loadMode) => {
    const resolved = path.resolve(filePath);
    const key = canonicalDocKey(resolved);
    if (seenDocPaths.has(key)) return;
    seenDocPaths.add(key);
    files.push(inspectDocFile(resolved, rootDir, category, loadMode));
  };

  // 1. Root AGENTS.md & GEMINI.md (Always-On)
  const agentsPath = findFileCaseInsensitive(rootDir, 'AGENTS.md');
  if (agentsPath) {
    pushDoc(agentsPath, 'AGENTS.md', 'Always-On');
  }

  const geminiPath = findFileCaseInsensitive(rootDir, 'GEMINI.md');
  if (geminiPath) {
    pushDoc(geminiPath, 'GEMINI.md', 'Always-On');
  }

  // 2 & 3. .agents / .agent / _agents / _agent rules, skills, and workspace plugins (plus root plugin layout)
  const rulesDirs = [];
  const skillsDirs = [];
  for (const cfgName of CONFIG_DIR_NAMES) {
    const cfgDir = path.join(rootDir, cfgName);
    if (!fs.existsSync(cfgDir) || !fs.statSync(cfgDir).isDirectory()) continue;
    rulesDirs.push(path.join(cfgDir, 'rules'));
    skillsDirs.push(path.join(cfgDir, 'skills'));

    const pluginsDir = path.join(cfgDir, 'plugins');
    if (fs.existsSync(pluginsDir) && fs.statSync(pluginsDir).isDirectory()) {
      for (const pEntry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
        if (!pEntry.isDirectory()) continue;
        const pRoot = path.join(pluginsDir, pEntry.name);
        rulesDirs.push(path.join(pRoot, 'rules'));
        skillsDirs.push(path.join(pRoot, 'skills'));
      }
    }
  }
  if (fs.existsSync(path.join(rootDir, 'plugin.json'))) {
    rulesDirs.push(path.join(rootDir, 'rules'));
    skillsDirs.push(path.join(rootDir, 'skills'));
  }

  for (const rulesDir of rulesDirs) {
    if (fs.existsSync(rulesDir) && fs.statSync(rulesDir).isDirectory()) {
      for (const entry of fs.readdirSync(rulesDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          pushDoc(path.join(rulesDir, entry.name), 'rule', 'Always-On');
        }
      }
    }
  }

  for (const skillsDir of skillsDirs) {
    if (fs.existsSync(skillsDir) && fs.statSync(skillsDir).isDirectory()) {
      for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const skillFile = findFileCaseInsensitive(path.join(skillsDir, entry.name), 'SKILL.md');
          if (skillFile) {
            pushDoc(skillFile, 'skill', 'Progressive Disclosure');
          }
        }
      }
    }
  }

  const alwaysOnFiles = files.filter(f => f.loadMode === 'Always-On');
  const skillFiles = files.filter(f => f.loadMode === 'Progressive Disclosure');

  const sum = arr => ({
    count: arr.length,
    lines: arr.reduce((s, f) => s + f.lines, 0),
    chars: arr.reduce((s, f) => s + f.chars, 0),
    bytes: arr.reduce((s, f) => s + f.bytes, 0),
    estTokens: arr.reduce((s, f) => s + f.estTokens, 0)
  });

  const mcpAndToolTax = auditMcpAndTools(rootDir, options);
  const alwaysOnSummary = sum(alwaysOnFiles);

  return {
    projectDir: rootDir,
    projectName: path.basename(rootDir),
    summary: {
      totalFiles: files.length,
      alwaysOn: {
        ...alwaysOnSummary,
        est30StepTokens: alwaysOnSummary.estTokens * 30
      },
      progressiveDisclosure: sum(skillFiles),
      enabledMcpCount: mcpAndToolTax.enabledMcpCount,
      defaultToolAndMcpPerStepTokens: mcpAndToolTax.defaultSessionEstTokensPerStep,
      agentRoleCount: mcpAndToolTax.agents.length
    },
    files,
    mcpAndToolTax
  };
}

module.exports = {
  auditProject,
  auditMcpAndTools,
  parseAgentMarkdown
};
