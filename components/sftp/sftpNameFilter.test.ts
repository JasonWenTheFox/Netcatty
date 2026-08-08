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
  assert.match(
    treeSource,
    /sortSftpEntries\(\s*filterSftpEntriesByName\(\s*filterHiddenFiles\(entries, pane\.showHiddenFiles\),\s*pane\.filter,\s*\),/s,
  );
  assert.match(treeSource, /pane\.showHiddenFiles\}:\$\{pane\.filter\}/);
});

test('SFTP tree child reload invalidates sorted cache so filter reapplies', () => {
  // After expand/reload, childrenCache is replaced. If sortedChildrenCache still
  // holds the pre-reload filtered list, newly loaded names that match the search
  // stay invisible until some unrelated cache clear.
  const treeSource = readFileSync(new URL('./SftpPaneTreeView.tsx', import.meta.url), 'utf8');
  const loadFn = treeSource.match(
    /const loadChildrenForPath = useCallback\(async \(entryPath: string\) => \{[\s\S]*?\n  \}, \[\]\);/,
  );
  assert.ok(loadFn, 'expected loadChildrenForPath callback');
  const setIdx = loadFn[0].indexOf('childrenCacheRef.current.set(entryPath, children)');
  const deleteIdx = loadFn[0].indexOf('sortedChildrenCacheRef.current.delete(entryPath)');
  assert.ok(setIdx >= 0, 'expected childrenCache write on successful load');
  assert.ok(deleteIdx > setIdx, 'sorted cache must clear after childrenCache write');
});
