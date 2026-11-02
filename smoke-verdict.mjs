/**
 * smoke-verdict.mjs — reading the smoke test's own report.
 *
 * test-extension.mjs prints a `VERDICT {json}` line as its last act. Both
 * callers (auto-build's single-site run and the batch app) decide from that
 * rather than from the exit status, because on Windows the runtime can crash
 * while closing a keep-alive socket *after* a run that passed every check — and
 * a crash is not a broken extension. Treating that crash as a failure used to
 * drop working sources, which is worse than the bug it was guarding against.
 */

const PREFIX = 'VERDICT '

/** The last VERDICT line in a test run's output, or null when there wasn't one. */
export function readVerdict(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.startsWith(PREFIX))
  if (!lines.length) return null
  try {
    const v = JSON.parse(lines[lines.length - 1].slice(PREFIX.length))
    const passed = Number(v.passed) || 0
    const failed = Number(v.failed) || 0
    return { passed, failed, checks: v.checks || null }
  } catch {
    return null
  }
}

/**
 * { passed, total, allOk } for one smoke run, decided from what the test
 * reported, not from how its process ended. No report at all means the test
 * died before it could say anything, which is not proof of a working source.
 */
export function smokeResult(text, exitCode) {
  const verdict = readVerdict(text)
  if (verdict) {
    const total = verdict.passed + verdict.failed
    return { passed: verdict.passed, total, allOk: total > 0 && verdict.failed === 0 }
  }
  const m = /(\d+)\/(\d+) checks passed/.exec(String(text || ''))
  if (m) {
    const passed = Number(m[1])
    const total = Number(m[2])
    return { passed, total, allOk: total > 0 && passed === total }
  }
  return { passed: 0, total: 0, allOk: false, exitCode: exitCode ?? null }
}

/** Test output with the machine-readable line removed, for human logs. */
export function stripVerdict(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((l) => !l.startsWith(PREFIX))
    .join('\n')
}
