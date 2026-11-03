// Preserve the original full plugin and all of its host patches. A LAN
// acceptance copy must not let its management actions restart the live host,
// upgrade shared dependencies, or discover/modify unrelated CLI/Desktop installs.
// These operations remain explicitly unavailable until their managed-host
// lifecycle has passed independent recovery tests. Never return a fake success.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

export async function installStagingManagementGuard() {
  const root = resolve('cloud/official/node_modules/dsh-purge/lib');
  const files = {
    'core.js': ['backupAll', 'revertAll', 'applyPatches', 'applyPatchesAllHosts',
      'revertAllHosts', 'patchAllShims', 'revertAllShims', 'sanitizeDesktopCommandRuntimes',
      'repairOfficialCliAfterUnpack', 'resolveOfficialAiBase', 'silenceCmdFlash'],
    'uninstall.js': ['uninstallPurge'],
    'host.js': ['scheduleRestart', 'scheduleCleanupRestart'],
    'update.js': ['applyUpdate', 'switchChannel', 'switchVersion', 'handleUpdateOp', 'autoUpdateIfNeeded'],
  };
  for (const [name, functions] of Object.entries(files)) {
    const path = join(root, name);
    let text = await readFile(path, 'utf8');
    const before = text;
    for (const name of functions) {
      const marker = `/* novel-stage-guard:${name} */`;
      if (text.includes(marker)) continue;
      const pattern = new RegExp(`export (?:async )?function ${name}\\([^\\n]*\\) \\{`, 'g');
      const matches = [...text.matchAll(pattern)];
      assert.equal(matches.length, 1, 'Original plugin management seam changed: ' + name);
      const at = matches[0].index + matches[0][0].length;
      text = text.slice(0, at) + '\n  ' + marker +
        '\n  if (process.env.NOVEL_STAGE_MANAGEMENT_LOCK === "locked") throw new Error("局域网验收版暂不执行宿主应用、恢复、卸载或重启；正式服务未改变。请勿将此提示视为操作成功。");' +
        text.slice(at);
    }
    if (text !== before) await writeFile(path, text);
  }
}
