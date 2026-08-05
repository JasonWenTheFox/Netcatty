import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  cancelApprovalTimeout,
  clearAllPendingApprovals,
  onApprovalCleared,
  requestApproval,
  resolveApproval,
} from './approvalGate';

function stubNow(startMs: number): { advance: (deltaMs: number) => void; restore: () => void } {
  const realNow = Date.now;
  let now = startMs;
  Date.now = () => now;
  return {
    advance: (deltaMs: number) => {
      now += deltaMs;
    },
    restore: () => {
      Date.now = realNow;
    },
  };
}

test('cancelApprovalTimeout keeps the absolute Catty deadline armed', async () => {
  clearAllPendingApprovals();
  const cleared: string[] = [];
  const unsub = onApprovalCleared((ids) => {
    cleared.push(...ids);
  });
  const clock = stubNow(1_000_000);

  try {
    const toolCallId = `timeout-absolute-${Date.now()}`;
    const approvalPromise = requestApproval(
      toolCallId,
      'terminal_execute',
      { sessionId: 's1', command: 'echo hi' },
      'chat-1',
      100,
    );

    // Jump close to the absolute ceiling, then cancel idle. Remaining absolute ~30ms.
    clock.advance(70);
    cancelApprovalTimeout(toolCallId);

    await delay(15);
    assert.equal(cleared.includes(toolCallId), false, 'must stay pending before absolute expiry');

    const outcome = await Promise.race([
      approvalPromise.then((approved) => ({ approved })),
      delay(120).then(() => ({ approved: 'timeout-wait' as const })),
    ]);
    assert.deepEqual(outcome, { approved: false });
    assert.ok(cleared.includes(toolCallId));
  } finally {
    clock.restore();
    unsub();
    clearAllPendingApprovals();
  }
});

test('cancelApprovalTimeout still allows explicit approve before absolute Catty expiry', async () => {
  clearAllPendingApprovals();
  const clock = stubNow(2_000_000);

  try {
    const toolCallId = `timeout-approve-${Date.now()}`;
    const approvalPromise = requestApproval(
      toolCallId,
      'sftp_write',
      { path: '/tmp/x' },
      'chat-1',
      200,
    );

    cancelApprovalTimeout(toolCallId);
    resolveApproval(toolCallId, true);
    assert.equal(await approvalPromise, true);
  } finally {
    clock.restore();
    clearAllPendingApprovals();
  }
});

test('idle approval timeout still auto-denies when the user never reviews', async () => {
  clearAllPendingApprovals();
  const cleared: string[] = [];
  const unsub = onApprovalCleared((ids) => {
    cleared.push(...ids);
  });

  const toolCallId = `timeout-fire-${Date.now()}`;
  const approved = await requestApproval(
    toolCallId,
    'terminal_execute',
    { sessionId: 's1', command: 'echo hi' },
    'chat-1',
    30,
  );

  assert.equal(approved, false);
  assert.ok(cleared.includes(toolCallId));

  unsub();
  clearAllPendingApprovals();
});

test('cancelApprovalTimeout asks main to drop Codex App Server interaction timers', () => {
  clearAllPendingApprovals();
  const calls: string[] = [];
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    netcatty: {
      cancelCodexAppServerInteractionTimeout: async (id: string) => {
        calls.push(id);
        return { ok: true, cancelled: true };
      },
    },
  };

  try {
    const toolCallId = `codex_interaction_1_${Date.now()}`;
    cancelApprovalTimeout(toolCallId);
    assert.deepEqual(calls, [toolCallId]);
  } finally {
    (globalThis as { window?: unknown }).window = previous;
    clearAllPendingApprovals();
  }
});
