import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { filterSftpEntriesByName, filterSftpTreeEntriesByName } from './utils.ts';

const entry = (name: string, type: 'file' | 'directory' = 'file') => ({ name, type });
const isDirectory = (e: { type: string }) => e.type === 'directory';

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

test('SFTP tree filter keeps loaded ancestors of matching children', () => {
  const childrenByPath = new Map<string, ReturnType<typeof entry>[]>([
    ['/project/src', [entry('README.md'), entry('utils.ts'), entry('components', 'directory')]],
    ['/project/src/components', [entry('Button.tsx'), entry('readme-local.txt')]],
  ]);
  const root = [
    entry('src', 'directory'),
    entry('logs', 'directory'),
    entry('app.js'),
  ];
  assert.deepEqual(
    filterSftpTreeEntriesByName(root, 'readme', {
      parentPath: '/project',
      joinPath: (parent, name) => `${parent}/${name}`,
      isDirectory,
      getChildren: (path) => childrenByPath.get(path),
    }).map(({ name }) => name),
    ['src'],
  );
  assert.deepEqual(
    filterSftpTreeEntriesByName(childrenByPath.get('/project/src')!, 'readme', {
      parentPath: '/project/src',
      joinPath: (parent, name) => `${parent}/${name}`,
      isDirectory,
      getChildren: (path) => childrenByPath.get(path),
    }).map(({ name }) => name),
    ['README.md', 'components'],
  );
});

test('SFTP tree filter hides unloaded non-matching directories', () => {
  const root = [entry('src', 'directory'), entry('README.md')];
  assert.deepEqual(
    filterSftpTreeEntriesByName(root, 'readme', {
      parentPath: '/project',
      joinPath: (parent, name) => `${parent}/${name}`,
      isDirectory,
      getChildren: () => undefined,
    }).map(({ name }) => name),
    ['README.md'],
  );
});

test('SFTP tree filter does not keep ancestors for hidden-only descendant matches', () => {
  // getChildren must apply the same hidden-file policy as visible rows; otherwise a
  // dotfile match can keep a parent folder while the matching child stays invisible.
  const childrenByPath = new Map<string, ReturnType<typeof entry>[]>([
    ['/project/src', [entry('.readme'), entry('utils.ts')]],
  ]);
  const root = [entry('src', 'directory')];
  assert.deepEqual(
    filterSftpTreeEntriesByName(root, 'readme', {
      parentPath: '/project',
      joinPath: (parent, name) => `${parent}/${name}`,
      isDirectory,
      getChildren: (path) => {
        const children = childrenByPath.get(path);
        if (!children) return undefined;
        return children.filter((child) => !child.name.startsWith('.'));
      },
    }).map(({ name }) => name),
    [],
  );
});

test('SFTP tree filter does not keep ancestors for collapsed descendant matches', () => {
  // Collapsed directories keep children in cache, but buildTree does not render
  // them. getChildren must treat collapsed paths as unavailable or the parent
  // stays visible with no matching row.
  const childrenByPath = new Map<string, ReturnType<typeof entry>[]>([
    ['/project/src', [entry('README.md'), entry('utils.ts')]],
  ]);
  const expandedPaths = new Set<string>();
  const root = [entry('src', 'directory'), entry('app.js')];
  assert.deepEqual(
    filterSftpTreeEntriesByName(root, 'readme', {
      parentPath: '/project',
      joinPath: (parent, name) => `${parent}/${name}`,
      isDirectory,
      getChildren: (path) => {
        if (!expandedPaths.has(path)) return undefined;
        return childrenByPath.get(path);
      },
    }).map(({ name }) => name),
    [],
  );
  expandedPaths.add('/project/src');
  assert.deepEqual(
    filterSftpTreeEntriesByName(root, 'readme', {
      parentPath: '/project',
      joinPath: (parent, name) => `${parent}/${name}`,
      isDirectory,
      getChildren: (path) => {
        if (!expandedPaths.has(path)) return undefined;
        return childrenByPath.get(path);
      },
    }).map(({ name }) => name),
    ['src'],
  );
});

test('SFTP tree view applies the tree name filter to visible rows', () => {
  const treeSource = readFileSync(new URL('./SftpPaneTreeView.tsx', import.meta.url), 'utf8');
  assert.match(
    treeSource,
    /sortSftpEntries\(\s*filterSftpTreeEntriesByName\(\s*filterHiddenFiles\(entries, pane\.showHiddenFiles\),\s*pane\.filter,/s,
  );
  assert.match(treeSource, /pane\.showHiddenFiles\}:\$\{pane\.filter\}/);
  assert.match(
    treeSource,
    /getChildren:\s*\(entryPath\)\s*=>\s*\{[\s\S]*?expandedPaths\.has\(entryPath\)[\s\S]*?filterHiddenFiles\([\s\S]*?pane\.showHiddenFiles/,
  );
  assert.match(
    treeSource,
    /prevExpandedPathsRef[\s\S]*?sortedChildrenCacheRef\.current\.clear\(\)/,
  );
});

test('SFTP tree child reload invalidates sorted cache so filter reapplies', () => {
  // After expand/reload, childrenCache is replaced. Ancestor visibility also
  // depends on those descendants, so the sorted cache must be cleared broadly
  // (not only for the loaded path) or parents stay hidden.
  const treeSource = readFileSync(new URL('./SftpPaneTreeView.tsx', import.meta.url), 'utf8');
  const loadFn = treeSource.match(
    /const loadChildrenForPath = useCallback\(async \(entryPath: string\) => \{[\s\S]*?\n {2}\}, \[\]\);/,
  );
  assert.ok(loadFn, 'expected loadChildrenForPath callback');
  const setIdx = loadFn[0].indexOf('childrenCacheRef.current.set(entryPath, children)');
  const clearIdx = loadFn[0].indexOf('sortedChildrenCacheRef.current.clear()');
  assert.ok(setIdx >= 0, 'expected childrenCache write on successful load');
  assert.ok(clearIdx > setIdx, 'sorted cache must clear after childrenCache write');
});
