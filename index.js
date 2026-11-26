'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const skeleton = require('./lib/skeleton');
const slice = require('./lib/slice');
const audit = require('./lib/audit');
const readGuard = require('./lib/read-guard');

const PACKAGE_ROOT = __dirname;

function detectGlobalPlugin(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const candidates = [
    path.join(homeDir, '.gemini', 'config', 'plugins', 'tokless'),
    path.join(homeDir, '.gemini', 'config', 'plugins', 'agy-tokless'),
  ];

  for (const pluginDir of candidates) {
    const manifestPath = path.join(pluginDir, 'plugin.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const enabled = manifest.disabled !== true;
        return { installed: true, enabled, pluginDir, manifestPath };
      } catch (_) {
        return { installed: true, enabled: true, pluginDir, manifestPath };
      }
    }
  }

  const defaultDir = candidates[1];
  return {
    installed: false,
    enabled: false,
    pluginDir: defaultDir,
    manifestPath: path.join(defaultDir, 'plugin.json'),
  };
}

module.exports = {
  PACKAGE_ROOT,
  detectGlobalPlugin,
  skeleton,
  slice,
  audit,
  readGuard,
  IGNORED_DIRS: skeleton.IGNORED_DIRS,
  SUPPORTED_EXTS: skeleton.SUPPORTED_EXTS,
  scanFileLightweight: skeleton.scanFileLightweight,
  generateFileSkeleton: skeleton.generateFileSkeleton,
  scanDirectorySkeleton: skeleton.scanDirectorySkeleton,
  formatSkeletonItems: skeleton.formatSkeletonItems,
  formatDirectorySkeleton: skeleton.formatDirectorySkeleton,
  formatDirectoryMap: skeleton.formatDirectoryMap,
  generateRepoMap: skeleton.generateRepoMap,
  generateSkeleton: skeleton.generateSkeleton,
  parseSliceTarget: skeleton.parseSliceTarget,
  buildQualifiedItems: skeleton.buildQualifiedItems,
  locateSymbol: skeleton.locateSymbol,
  sliceSymbol: skeleton.sliceSymbol,
  sliceSymbolFromText: skeleton.sliceSymbolFromText,
  estimateTokens: audit.estimateTokens,
  listSessions: audit.listSessions,
  analyzeSession: audit.analyzeSession,
  compareSessions: audit.compareSessions,
  auditProject: audit.auditProject,
  auditMcpAndTools: audit.auditMcpAndTools,
  parseAgentMarkdown: audit.parseAgentMarkdown,
  formatSessionMarkdown: audit.formatSessionMarkdown,
  formatSessionListMarkdown: audit.formatSessionListMarkdown,
  formatCompareMarkdown: audit.formatCompareMarkdown,
  formatProjectMarkdown: audit.formatProjectMarkdown,
  COMPACTION_THRESHOLD_256K: audit.COMPACTION_THRESHOLD_256K,
  COMPACTION_THRESHOLD_512K: audit.COMPACTION_THRESHOLD_512K,
  GUARDED_CODE_EXTS: readGuard.GUARDED_CODE_EXTS,
  READ_GUARD_SCRIPT_PATH: readGuard.READ_GUARD_SCRIPT_PATH,
  HOOKS_CONFIG_PATH: readGuard.HOOKS_CONFIG_PATH,
  PLUGIN_MANIFEST_PATH: readGuard.PLUGIN_MANIFEST_PATH,
  evaluateReadGuard: readGuard.evaluateReadGuard,
  checkReadGuard: readGuard.checkReadGuard,
  formatHookResponse: readGuard.formatHookResponse,
  buildPreToolUseHookConfig: readGuard.buildPreToolUseHookConfig,
  buildClaudePreToolUseHookConfig: readGuard.buildClaudePreToolUseHookConfig,
  getMaxLinesThreshold: readGuard.getMaxLinesThreshold,
};
