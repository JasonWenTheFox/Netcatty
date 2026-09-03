import assert from 'node:assert/strict';
import test from 'node:test';
import commandBlocklistTable from '../../lib/commandBlocklist.json';
import {
  COMMAND_BLOCKLIST_SYNC_MARKER,
  migrateLegacyCommandBlocklist,
} from './commandBlocklistSettings';

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

test('the in-list sync marker preserves PowerShell customizations through old clients', () => {
  const removedOne = [
    ...legacyDefaults,
    ...commandBlocklistTable.powershell.slice(1),
    COMMAND_BLOCKLIST_SYNC_MARKER,
  ];
  const removedAll = [...legacyDefaults, COMMAND_BLOCKLIST_SYNC_MARKER];
  const editedAll = [
    ...legacyDefaults,
    ...commandBlocklistTable.powershell.map((pattern) => `edited:${pattern}`),
    COMMAND_BLOCKLIST_SYNC_MARKER,
  ];

  assert.deepEqual(migrateLegacyCommandBlocklist(removedOne), removedOne.slice(0, -1));
  assert.deepEqual(migrateLegacyCommandBlocklist(removedAll), legacyDefaults);
  assert.deepEqual(migrateLegacyCommandBlocklist(editedAll), editedAll.slice(0, -1));
  assert.equal(new RegExp(COMMAND_BLOCKLIST_SYNC_MARKER).test('any command'), false);
});

test('an actual legacy list with one future PowerShell rule gains the remaining defaults', () => {
  const legacyCustomized = [...legacyDefaults, commandBlocklistTable.powershell[0]];
  assert.deepEqual(
    migrateLegacyCommandBlocklist(legacyCustomized),
    [...legacyDefaults, ...commandBlocklistTable.powershell],
  );
});
