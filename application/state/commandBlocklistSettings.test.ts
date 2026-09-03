import assert from 'node:assert/strict';
import test from 'node:test';
import commandBlocklistTable from '../../lib/commandBlocklist.json';
import { migrateLegacyCommandBlocklist } from './commandBlocklistSettings';

const legacyDefaults = [
  ...commandBlocklistTable.common,
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
