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

test('cancelApprovalTimeout keeps the approval pending past the idle timer', async () => {
  clearAllPendingApprovals();
  const cleared: string[] = [];
  const unsub = onApprovalCleared((ids) => {
    cleared.push(...ids);
  });

  const toolCallId = `timeout-cancel-${Date.now()}`;
  let settled: boolean | undefined;
  const approvalPromise = requestApproval(
    toolCallId,
    'terminal_execute',
    { sessionId: 's1', command: 'echo hi' },
    'chat-1',
    40,
  ).then((approved) => {
    settled = approved;
    return approved;
  });

  cancelApprovalTimeout(toolCallId);
  await delay(80);

  assert.equal(settled, undefined, 'timeout must not auto-resolve after cancel');
  assert.deepEqual(cleared, []);

  resolveApproval(toolCallId, false);
  assert.equal(await approvalPromise, false);

  unsub();
  clearAllPendingApprovals();
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
