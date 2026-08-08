import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { filterSftpEntriesByName } from './utils.ts';

const entry = (name: string) => ({ name });

test('SFTP name filter returns all entries when term is empty', () => {
  const files = [entry('..'), entry('README.md'), entry('src')];
  assert.deepEqual(filterSftpEntriesByName(files, '   '), files);
});

test('SFTP name filter matches case-insensitively and keeps parent entry', () => {
  const files = [entry('..'), entry('README.md'), entry('src'), entry('read-notes.txt')];
  assert.deepEqual(
    filterSftpEntriesByName(files, 'Read').map(({ name }) => name),
    ['..', 'README.md', 'read-notes.txt'],
  );
});

test('SFTP name filter hides non-matching siblings including directories', () => {
  const files = [entry('config'), entry('logs'), entry('app.js')];
  assert.deepEqual(
    filterSftpEntriesByName(files, 'log').map(({ name }) => name),
    ['logs'],
  );
});

test('SFTP tree view applies the shared name filter to visible rows', () => {
  const treeSource = readFileSync(new URL('./SftpPaneTreeView.tsx', import.meta.url), 'utf8');
  assert.match(treeSource, /filterSftpEntriesByName/);
  assert.match(treeSource, /pane\.filter/);
});
