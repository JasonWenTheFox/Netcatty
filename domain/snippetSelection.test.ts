import assert from 'node:assert/strict';
import test from 'node:test';
import type { Host, Snippet } from './models';
import {
  collectSnippetDeleteIds,
  deleteSelectedSnippetsFromVault,
  rebaseSnippetVaultWrite,
} from './snippetSelection.ts';

test('collectSnippetDeleteIds merges id and ids payloads', () => {
  assert.deepEqual(
    [...collectSnippetDeleteIds({ id: 'a', ids: ['b', 'a', ''] })].sort(),
    ['a', 'b'],
  );
  assert.equal(collectSnippetDeleteIds(undefined).size, 0);
  assert.equal(collectSnippetDeleteIds({ ids: [] }).size, 0);
});

test('deleteSelectedSnippetsFromVault removes host bindings for every selected snippet', () => {
  const snippets: Snippet[] = [
    { id: 'login', label: 'Login', command: 'echo login', kind: 'script' },
    {
      id: 'connect',
      label: 'Connect',
      command: 'echo connect',
      kind: 'script',
      trigger: 'onConnect',
      targets: ['host-a', 'host-b'],
    },
    {
      id: 'keep',
      label: 'Keep',
      command: 'echo keep',
      kind: 'script',
      trigger: 'onConnect',
      targets: ['host-a'],
    },
  ];
  const hosts: Host[] = [
    {
      id: 'host-a',
      name: 'Host A',
      host: 'host-a.example.com',
      port: 22,
      username: 'root',
      loginScriptId: 'login',
      connectScriptIds: ['connect', 'keep'],
    },
    {
      id: 'host-b',
      name: 'Host B',
      host: 'host-b.example.com',
      port: 22,
      username: 'root',
      connectScriptIds: ['connect'],
    },
  ];

  const result = deleteSelectedSnippetsFromVault(
    snippets,
    hosts,
    new Set(['login', 'connect', 'missing']),
  );

  assert.deepEqual(result.snippets.map((snippet) => snippet.id), ['keep']);
  assert.equal(result.deletedCount, 2);
  assert.equal(result.hosts[0].loginScriptId, undefined);
  assert.deepEqual(result.hosts[0].connectScriptIds, ['keep']);
  assert.deepEqual(result.hosts[1].connectScriptIds, []);
  assert.equal(hosts[0].loginScriptId, 'login');
  assert.deepEqual(hosts[0].connectScriptIds, ['connect', 'keep']);
});

test('rebaseSnippetVaultWrite does not resurrect snippets deleted on disk', () => {
  const base: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a' },
    { id: 'b', label: 'B', command: 'echo b' },
  ];
  const ours: Snippet[] = [
    { id: 'a', label: 'A edited', command: 'echo a2' },
    { id: 'b', label: 'B', command: 'echo b' },
  ];
  // Concurrent bulk-delete removed B before our queued save ran.
  const theirs: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a' },
  ];

  const merged = rebaseSnippetVaultWrite({ base, ours, theirs });
  assert.deepEqual(merged.map((snippet) => snippet.id), ['a']);
  assert.equal(merged[0]?.label, 'A edited');
});

test('rebaseSnippetVaultWrite keeps concurrent disk additions and local additions', () => {
  const base: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a' },
  ];
  const ours: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a' },
    { id: 'local', label: 'Local', command: 'echo local' },
  ];
  const theirs: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a' },
    { id: 'remote', label: 'Remote', command: 'echo remote' },
  ];

  const merged = rebaseSnippetVaultWrite({ base, ours, theirs });
  assert.deepEqual(merged.map((snippet) => snippet.id).sort(), ['a', 'local', 'remote']);
});

test('rebaseSnippetVaultWrite keeps local deletes even when disk still has the row', () => {
  const base: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a' },
    { id: 'b', label: 'B', command: 'echo b' },
  ];
  const ours: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a' },
  ];
  const theirs: Snippet[] = [
    { id: 'a', label: 'A', command: 'echo a' },
    { id: 'b', label: 'B edited elsewhere', command: 'echo b2' },
  ];

  const merged = rebaseSnippetVaultWrite({ base, ours, theirs });
  assert.deepEqual(merged.map((snippet) => snippet.id), ['a']);
});
