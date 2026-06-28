'use strict';
const { spawn } = require('child_process');

/**
 * Create an isolated mkvmerge runner that tracks its own active process so it
 * can be cancelled. Each app/service gets its own runner instance.
 */
function createRunner() {
  let activeProcess = null;

  function runWithProgress(bin, args, onProgress, onLog) {
    return new Promise((resolve, reject) => {
      const proc = spawn(bin, args);
      activeProcess = proc;
      let stderr = '';
      proc.stdout.on('data', d => {
        for (const line of d.toString().split('\n')) {
          const m = line.match(/#GUI#progress\s+(\d+)%/);
          if (m) onProgress?.(parseInt(m[1]) / 100);
          else if (line.trim() && !line.startsWith('#GUI#')) onLog?.(line.trim());
        }
      });
      proc.stderr.on('data', d => { stderr += d; onLog?.(d.toString().trim()); });
      proc.on('close', code => {
        activeProcess = null;
        // mkvmerge returns 1 for warnings (e.g. track statistics) — treat as success.
        if (code === 0 || code === 1) resolve();
        else reject(new Error(`mkvmerge exited ${code}. ${stderr.slice(0, 200)}`));
      });
      proc.on('error', e => { activeProcess = null; reject(e); });
    });
  }

  function cancel() {
    if (activeProcess) { activeProcess.kill('SIGTERM'); activeProcess = null; return true; }
    return false;
  }

  return { runWithProgress, cancel };
}

module.exports = { createRunner };
