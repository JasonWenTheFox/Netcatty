import assert from 'node:assert/strict';
import test from 'node:test';

import {
  approvalCommandWasUnwrapped,
  extractApprovalExecutionContext,
  extractDisplayCommand,
  MAX_TOOL_COMMAND_TOOLTIP_CHARS,
  truncateToolCommandTooltip,
} from './tool-call';

// Codex (SDK) emits command_execution.command as a STRING that wraps the real
// command in `<shell> -lc '<full>'`. Under Skills + CLI the real command is a
// netcatty-tool-cli call. The title must unwrap the shell layer first, else the
// outer quote leaks (the "netcatty: \"" / "netcatty: …md\"" garbage titles).

test('unwraps a /bin/zsh -lc string wrapper (codex SDK shape)', () => {
  assert.equal(
    extractDisplayCommand({ command: `/bin/zsh -lc 'echo "hi"'` }),
    'echo "hi"',
  );
});

test('codex Skills+CLI exec: unwrap shell + netcatty-cli -> remote command', () => {
  assert.equal(
    extractDisplayCommand({
      command: `/bin/zsh -lc '"/abs/netcatty-tool-cli" exec --session X -- "uptime"'`,
    }),
    'uptime',
  );
});

test('codex Skills+CLI session subcommand -> friendly title', () => {
  assert.equal(
    extractDisplayCommand({
      command: `/bin/zsh -lc '"/abs/netcatty-tool-cli" session --session X'`,
    }),
    'netcatty: inspect session',
  );
});

test('raw (unwrapped) netcatty-tool-cli exec still works', () => {
  assert.equal(
    extractDisplayCommand({ command: `"/abs/netcatty-tool-cli" exec --session X -- "uptime"` }),
    'uptime',
  );
});

test('netcatty-tool-cli env -> list sessions', () => {
  assert.equal(extractDisplayCommand({ command: 'netcatty-tool-cli env' }), 'netcatty: list sessions');
});

test('array shell-wrap shape still unwraps (regression)', () => {
  assert.equal(
    extractDisplayCommand({ command: ['zsh', '-lc', 'ls -la /tmp'] }),
    'ls -la /tmp',
  );
});

test('plain command passes through unchanged', () => {
  assert.equal(extractDisplayCommand({ command: 'ls -la /tmp' }), 'ls -la /tmp');
});

test('limits long command tooltips to a compact single-line preview', () => {
  const tooltip = truncateToolCommandTooltip(`  echo first\n${'x'.repeat(300)}  `);
  assert.equal(tooltip.length, MAX_TOOL_COMMAND_TOOLTIP_CHARS);
  assert.equal(tooltip.endsWith('…'), true);
  assert.equal(tooltip.includes('\n'), false);
});

test('empty / missing args -> null', () => {
  assert.equal(extractDisplayCommand(undefined), null);
  assert.equal(extractDisplayCommand({ command: '' }), null);
});

test('extractApprovalExecutionContext surfaces session/cwd/shell without rewriting command', () => {
  assert.deepEqual(
    extractApprovalExecutionContext({
      sessionId: 'term-1',
      cwd: '/var/log',
      command: ['zsh', '-lc', 'df -h | sort'],
    }),
    { sessionId: 'term-1', cwd: '/var/log', shell: 'zsh' },
  );
  assert.deepEqual(
    extractApprovalExecutionContext({
      command: `/bin/bash -lc 'uptime'`,
    }),
    { sessionId: undefined, cwd: undefined, shell: 'bash' },
  );
  assert.equal(extractApprovalExecutionContext({ path: '/tmp' }), null);
});

test('extractApprovalExecutionContext reads --session from netcatty-tool-cli wrappers', () => {
  assert.deepEqual(
    extractApprovalExecutionContext({
      command: `/bin/zsh -lc '"/abs/netcatty-tool-cli" exec --session term-9 --chat-session chat-1 -- "uptime"'`,
    }),
    { sessionId: 'term-9', cwd: undefined, shell: 'zsh' },
  );
});

test('approvalCommandWasUnwrapped detects Skills+CLI display unwrap', () => {
  const args = {
    command: `/bin/zsh -lc '"/abs/netcatty-tool-cli" exec --session X -- "uptime"'`,
  };
  const display = extractDisplayCommand(args);
  assert.equal(display, 'uptime');
  assert.equal(approvalCommandWasUnwrapped(args, display), true);
  assert.equal(approvalCommandWasUnwrapped({ command: 'uptime' }, 'uptime'), false);
});
