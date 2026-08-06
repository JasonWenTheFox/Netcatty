import assert from "node:assert/strict";
import test from "node:test";

import type { SftpFileEntry } from "../../../domain/models";
import { compareDirectoryTraversalPaths } from "../../../domain/sftpDirectoryCheckpoint";
import { discoverTransferTree } from "./transferDirectoryDiscovery";

const directoryEntry = (name: string): SftpFileEntry => ({
  name,
  type: "directory",
  size: 0,
  sizeFormatted: "0 B",
  lastModified: 0,
  lastModifiedFormatted: "",
});

const fileEntry = (name: string, size = 1, lastModified = 1_700_000_000): SftpFileEntry => ({
  name,
  type: "file",
  size,
  sizeFormatted: `${size} B`,
  lastModified,
  lastModifiedFormatted: "",
});

test("discoverTransferTree returns a stable flat file list with bounded listings", async () => {
  const previousWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    netcatty: {
      realpathSftp: async (_sftpId: string, remotePath: string) => remotePath,
    },
  };

  let active = 0;
  let maxActive = 0;
  const listRemoteFiles = async (_sftpId: string, path: string): Promise<SftpFileEntry[]> => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
    if (path === "/source") {
      return [directoryEntry("a"), directoryEntry("b"), fileEntry("root.txt")];
    }
    if (path === "/source/a") return [fileEntry("a1.txt"), fileEntry("a2.txt")];
    if (path === "/source/b") return [fileEntry("b1.txt")];
    return [];
  };

  try {
    const counts: number[] = [];
    const result = await discoverTransferTree({
      sourcePath: "/source",
      targetPath: "/target",
      sourceIsLocal: false,
      sourceSftpId: "sftp-1",
      sourceEncoding: "auto",
      listLocalFiles: async () => [],
      listRemoteFiles,
      listingConcurrency: 2,
      onDiscoveredFiles: (total) => counts.push(total),
    });

    assert.deepEqual(
      result.files.map((file) => file.sourcePath),
      [...result.files.map((file) => file.sourcePath)].sort((left, right) =>
        compareDirectoryTraversalPaths(left, right)
      ),
      "pre-scan file order must match resume comparator",
    );
    assert.deepEqual(
      result.files.map((file) => file.sourcePath).sort(),
      ["/source/a/a1.txt", "/source/a/a2.txt", "/source/b/b1.txt", "/source/root.txt"],
    );
    assert.deepEqual(
      result.directories.map((dir) => dir.sourcePath).sort(),
      ["/source", "/source/a", "/source/b"],
    );
    assert.equal(counts.at(-1), 4);
    assert.equal(result.omittedSymlinkDirectoryErrors, 0);
    assert.ok(maxActive >= 2, `expected parallel listings, got ${maxActive}`);
    assert.ok(maxActive <= 2, `listing concurrency exceeded: ${maxActive}`);
  } finally {
    (globalThis as { window?: unknown }).window = previousWindow;
  }
});

test("discoverTransferTree skips symlink directory cycles across BFS waves", async () => {
  const previousWindow = (globalThis as { window?: unknown }).window;
  const listCalls = new Map<string, number>();
  (globalThis as { window?: unknown }).window = {
    netcatty: {
      realpathSftp: async (_sftpId: string, remotePath: string) => (
        remotePath === "/source/loop" ? "/source" : remotePath
      ),
    },
  };

  const listRemoteFiles = async (_sftpId: string, path: string): Promise<SftpFileEntry[]> => {
    listCalls.set(path, (listCalls.get(path) ?? 0) + 1);
    if (path === "/source") {
      return [
        directoryEntry("child"),
        { ...directoryEntry("loop"), type: "symlink", linkTarget: "directory" },
        fileEntry("root.txt"),
      ];
    }
    if (path === "/source/child") return [fileEntry("nested.txt")];
    throw new Error(`unexpected list of ${path}`);
  };

  try {
    const result = await discoverTransferTree({
      sourcePath: "/source",
      targetPath: "/target",
      sourceIsLocal: false,
      sourceSftpId: "sftp-1",
      sourceEncoding: "auto",
      followSymlinks: true,
      listLocalFiles: async () => [],
      listRemoteFiles,
      listingConcurrency: 4,
    });

    assert.equal(listCalls.has("/source/loop"), false);
    assert.equal(listCalls.get("/source"), 1);
    assert.equal(listCalls.get("/source/child"), 1);
    assert.deepEqual(
      result.files.map((file) => file.sourcePath).sort(),
      ["/source/child/nested.txt", "/source/root.txt"],
    );
    assert.deepEqual(
      result.directories.map((dir) => dir.sourcePath).sort(),
      ["/source", "/source/child"],
      "cyclic symlink dirs must not appear in the creation plan",
    );
    assert.equal(result.omittedSymlinkDirectoryErrors, 0);
  } finally {
    (globalThis as { window?: unknown }).window = previousWindow;
  }
});

test("discoverTransferTree copies sibling symlink aliases to distinct targets", async () => {
  const previousWindow = (globalThis as { window?: unknown }).window;
  const listCalls = new Map<string, number>();
  (globalThis as { window?: unknown }).window = {
    netcatty: {
      realpathSftp: async (_sftpId: string, remotePath: string) => {
        if (remotePath === "/source/alias-a" || remotePath === "/source/alias-b") {
          return "/shared";
        }
        return remotePath;
      },
    },
  };

  const listRemoteFiles = async (_sftpId: string, path: string): Promise<SftpFileEntry[]> => {
    listCalls.set(path, (listCalls.get(path) ?? 0) + 1);
    if (path === "/source") {
      return [
        { ...directoryEntry("alias-a"), type: "symlink", linkTarget: "directory" },
        { ...directoryEntry("alias-b"), type: "symlink", linkTarget: "directory" },
      ];
    }
    if (path === "/source/alias-a" || path === "/source/alias-b") {
      return [fileEntry("shared.txt")];
    }
    throw new Error(`unexpected list of ${path}`);
  };

  try {
    const result = await discoverTransferTree({
      sourcePath: "/source",
      targetPath: "/target",
      sourceIsLocal: false,
      sourceSftpId: "sftp-1",
      sourceEncoding: "auto",
      followSymlinks: true,
      listLocalFiles: async () => [],
      listRemoteFiles,
      listingConcurrency: 4,
    });

    assert.equal(listCalls.get("/source/alias-a"), 1);
    assert.equal(listCalls.get("/source/alias-b"), 1);
    assert.deepEqual(
      result.files.map((file) => file.targetPath).sort(),
      ["/target/alias-a/shared.txt", "/target/alias-b/shared.txt"],
    );
  } finally {
    (globalThis as { window?: unknown }).window = previousWindow;
  }
});

test("discoverTransferTree counts max-depth symlink directory omissions as errors", async () => {
  const previousWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    netcatty: {
      realpathSftp: async (_sftpId: string, remotePath: string) => remotePath,
    },
  };

  const listRemoteFiles = async (_sftpId: string, path: string): Promise<SftpFileEntry[]> => {
    const depth = path === "/source"
      ? 0
      : path.startsWith("/source/")
        ? path.slice("/source/".length).split("/").filter(Boolean).length
        : -1;
    if (depth < 0 || depth > 32) throw new Error(`unexpected list of ${path}`);
    const nextLink = { ...directoryEntry("deep"), type: "symlink" as const, linkTarget: "directory" as const };
    if (depth === 0) {
      return [
        nextLink,
        {
          name: "link.txt",
          type: "symlink",
          linkTarget: "file",
          size: 3,
          sizeFormatted: "3 B",
          lastModified: 1_700_000_000,
          lastModifiedFormatted: "",
        },
      ];
    }
    return [nextLink];
  };

  try {
    const result = await discoverTransferTree({
      sourcePath: "/source",
      targetPath: "/target",
      sourceIsLocal: false,
      sourceSftpId: "sftp-1",
      sourceEncoding: "auto",
      followSymlinks: true,
      listLocalFiles: async () => [],
      listRemoteFiles,
      listingConcurrency: 2,
    });

    assert.equal(result.omittedSymlinkDirectoryErrors, 1);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0]?.isSymlink, true);
    assert.equal(result.files[0]?.name, "link.txt");
  } finally {
    (globalThis as { window?: unknown }).window = previousWindow;
  }
});
