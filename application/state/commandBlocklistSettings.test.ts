import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addCommandBlocklistSyncMarker,
  COMMAND_BLOCKLIST_SYNC_MARKER,
  hasCommandBlocklistSyncMarker,
  migrateLegacyCommandBlocklist,
} from '../../domain/commandBlocklist';
import commandBlocklistTable from '../../lib/commandBlocklist.json';

const legacyDefaults = [
  ...commandBlocklistTable.common,
  ...commandBlocklistTable.posixNative,
  ...commandBlocklistTable.posix,
];

test('untouched legacy defaults gain the PowerShell group once', () => {
  assert.deepEqual(
    migrateLegacyCommandBlocklist(legacyDefaults),
    [...legacyDefaults, ...commandBlocklistTable.powershell],
  );
});

test('customized legacy settings preserve removed defaults', () => {
  const customized = legacyDefaults.slice(1);
  assert.deepEqual(migrateLegacyCommandBlocklist(customized), customized);
  assert.deepEqual(migrateLegacyCommandBlocklist([]), []);
});

test('legacy settings keep user additions while gaining new defaults', () => {
  const customized = [...legacyDefaults, 'company-forbidden-command'];
  assert.deepEqual(
    migrateLegacyCommandBlocklist(customized),
    [...customized, ...commandBlocklistTable.powershell],
  );
});

test('the sync marker preserves PowerShell customizations without adding a visible row', () => {
  const removedOne = addCommandBlocklistSyncMarker([
    ...legacyDefaults,
    ...commandBlocklistTable.powershell.slice(1),
  ]);
  const removedAll = addCommandBlocklistSyncMarker(legacyDefaults);
  const editedAll = addCommandBlocklistSyncMarker([
    ...legacyDefaults,
    ...commandBlocklistTable.powershell.map((pattern) => `edited:${pattern}`),
  ]);

  assert.equal(removedAll.length, legacyDefaults.length);
  assert.equal(removedAll.includes(COMMAND_BLOCKLIST_SYNC_MARKER), false);
  assert.equal(hasCommandBlocklistSyncMarker(removedAll), true);
  assert.deepEqual(
    migrateLegacyCommandBlocklist(removedOne),
    [...legacyDefaults, ...commandBlocklistTable.powershell.slice(1)],
  );
  assert.deepEqual(migrateLegacyCommandBlocklist(removedAll), legacyDefaults);
  assert.deepEqual(
    migrateLegacyCommandBlocklist(editedAll),
    [
      ...legacyDefaults,
      ...commandBlocklistTable.powershell.map((pattern) => `edited:${pattern}`),
    ],
  );
  assert.equal(new RegExp(COMMAND_BLOCKLIST_SYNC_MARKER).test('any command'), false);
});

test('the marked carrier rule keeps the original regular-expression behavior', () => {
  const original = commandBlocklistTable.common[1];
  const marked = addCommandBlocklistSyncMarker(legacyDefaults).find(
    (pattern) => pattern !== original && pattern.includes(COMMAND_BLOCKLIST_SYNC_MARKER),
  );

  assert.ok(marked);
  for (const command of ['shutdown now', 'sudo reboot', 'echo safe', 'Write-Host now']) {
    assert.equal(new RegExp(marked, 'i').test(command), new RegExp(original, 'i').test(command));
  }
});

test('an actual legacy list with one future PowerShell rule gains the remaining defaults', () => {
  const legacyCustomized = [...legacyDefaults, commandBlocklistTable.powershell[0]];
  assert.deepEqual(
    migrateLegacyCommandBlocklist(legacyCustomized),
    [...legacyDefaults, ...commandBlocklistTable.powershell],
  );
});
