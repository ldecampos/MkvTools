import { createRequire } from 'module';
import { describe, test, expect } from 'vitest';
import process from 'process';

const require = createRequire(import.meta.url);
const { createRunner } = require('../src/procRunner.js');

// Use the current Node.js binary so these tests work with no extra tools installed.
const NODE = process.execPath;

// ── cancel when idle ──────────────────────────────────────────────────────────

describe('cancel', () => {
  test('returns false when no process is running', () => {
    const runner = createRunner();
    expect(runner.cancel()).toBe(false);
  });

  test('calling cancel twice is safe', () => {
    const runner = createRunner();
    expect(runner.cancel()).toBe(false);
    expect(runner.cancel()).toBe(false);
  });
});

// ── runWithProgress – exit codes ──────────────────────────────────────────────

describe('runWithProgress – exit codes', () => {
  test('resolves on exit code 0', async () => {
    const runner = createRunner();
    await expect(runner.runWithProgress(NODE, ['-e', 'process.exit(0)'])).resolves.toBeUndefined();
  });

  test('resolves on exit code 1 (mkvmerge warning — not a failure)', async () => {
    const runner = createRunner();
    await expect(runner.runWithProgress(NODE, ['-e', 'process.exit(1)'])).resolves.toBeUndefined();
  });

  test('rejects on exit code 2', async () => {
    const runner = createRunner();
    await expect(runner.runWithProgress(NODE, ['-e', 'process.exit(2)'])).rejects.toThrow('mkvmerge exited 2');
  });

  test('rejects when the binary does not exist', async () => {
    const runner = createRunner();
    await expect(
      runner.runWithProgress('/nonexistent/binary', [])
    ).rejects.toThrow();
  });
});

// ── runWithProgress – progress parsing ───────────────────────────────────────

describe('runWithProgress – progress parsing', () => {
  test('calls onProgress with a fraction (0–1) for #GUI#progress lines', async () => {
    const runner = createRunner();
    const captured = [];
    const script = `
      process.stdout.write('#GUI#progress 0%\\n');
      process.stdout.write('#GUI#progress 50%\\n');
      process.stdout.write('#GUI#progress 100%\\n');
    `;
    await runner.runWithProgress(NODE, ['-e', script], p => captured.push(p));
    expect(captured).toEqual([0, 0.5, 1]);
  });

  test('does not call onProgress for non-progress stdout lines', async () => {
    const runner = createRunner();
    const captured = [];
    const script = `process.stdout.write('Some mkvmerge log line\\n');`;
    await runner.runWithProgress(NODE, ['-e', script], p => captured.push(p));
    expect(captured).toHaveLength(0);
  });

  test('calls onLog for non-#GUI# stdout lines', async () => {
    const runner = createRunner();
    const logs = [];
    const script = `process.stdout.write('Track 1: video\\n');`;
    await runner.runWithProgress(NODE, ['-e', script], null, l => logs.push(l));
    expect(logs).toContain('Track 1: video');
  });

  test('ignores #GUI# prefixed lines that are not progress', async () => {
    const runner = createRunner();
    const logs = [];
    const script = `process.stdout.write('#GUI#begin\\n');`;
    await runner.runWithProgress(NODE, ['-e', script], null, l => logs.push(l));
    expect(logs.some(l => l.includes('#GUI#'))).toBe(false);
  });
});

// ── cancel during run ─────────────────────────────────────────────────────────

describe('cancel during run', () => {
  test('cancel returns true and the promise rejects', async () => {
    const runner = createRunner();
    // A long-running script
    const script = `setTimeout(() => {}, 30000);`;
    const promise = runner.runWithProgress(NODE, ['-e', script]);
    // Give the process time to start before cancelling
    await new Promise(r => setTimeout(r, 50));
    const wasCancelled = runner.cancel();
    expect(wasCancelled).toBe(true);
    await expect(promise).rejects.toThrow();
  });

  test('cancel resets state — returns false after the process is gone', async () => {
    const runner = createRunner();
    const script = `setTimeout(() => {}, 30000);`;
    const promise = runner.runWithProgress(NODE, ['-e', script]);
    await new Promise(r => setTimeout(r, 50));
    runner.cancel();
    try { await promise; } catch (_) { /* expected */ }
    expect(runner.cancel()).toBe(false);
  });
});

// ── isolation between runners ─────────────────────────────────────────────────

describe('runner isolation', () => {
  test('two runners are independent — cancelling one does not affect the other', async () => {
    const runnerA = createRunner();
    const runnerB = createRunner();
    const promiseA = runnerA.runWithProgress(NODE, ['-e', `setTimeout(() => {}, 30000);`]);
    const promiseB = runnerB.runWithProgress(NODE, ['-e', `process.exit(0);`]);
    await new Promise(r => setTimeout(r, 50));
    runnerA.cancel();
    // B should complete normally
    await expect(promiseB).resolves.toBeUndefined();
    try { await promiseA; } catch (_) { /* expected from cancel */ }
  });
});
