import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SFTP_DIRECTORY_LISTING_CONCURRENCY,
  DEFAULT_SFTP_FILE_TRANSFER_CONCURRENCY,
  DEFAULT_SFTP_FOLDER_PRESCAN,
  DEFAULT_SFTP_SKIP_UNCHANGED,
  resolveSftpDirectoryListingConcurrency,
  resolveSftpFolderPrescanEnabled,
  resolveSftpSkipUnchangedEnabled,
  resolveSftpTransferConcurrency,
  runBoundedConcurrency,
  runSftpTransferWorkers,
} from "./transferConcurrency";

test("defaults folder file transfers to two concurrent files", () => {
  assert.equal(resolveSftpTransferConcurrency(() => null), DEFAULT_SFTP_FILE_TRANSFER_CONCURRENCY);
  assert.equal(DEFAULT_SFTP_FILE_TRANSFER_CONCURRENCY, 2);
});

test("defaults directory listing fanout to four concurrent readdirs", () => {
  assert.equal(
    resolveSftpDirectoryListingConcurrency(() => null),
    DEFAULT_SFTP_DIRECTORY_LISTING_CONCURRENCY,
  );
  assert.equal(DEFAULT_SFTP_DIRECTORY_LISTING_CONCURRENCY, 4);
});

test("defaults folder pre-scan and skip-unchanged to enabled", () => {
  assert.equal(resolveSftpFolderPrescanEnabled(() => null), DEFAULT_SFTP_FOLDER_PRESCAN);
  assert.equal(resolveSftpSkipUnchangedEnabled(() => null), DEFAULT_SFTP_SKIP_UNCHANGED);
  assert.equal(DEFAULT_SFTP_FOLDER_PRESCAN, true);
  assert.equal(DEFAULT_SFTP_SKIP_UNCHANGED, true);
  assert.equal(resolveSftpFolderPrescanEnabled(() => false), false);
  assert.equal(resolveSftpSkipUnchangedEnabled(() => false), false);
});

test("keeps explicit folder transfer concurrency within the supported range", () => {
  assert.equal(resolveSftpTransferConcurrency(() => 1), 1);
  assert.equal(resolveSftpTransferConcurrency(() => 16), 16);
  assert.equal(resolveSftpTransferConcurrency(() => 0), DEFAULT_SFTP_FILE_TRANSFER_CONCURRENCY);
  assert.equal(resolveSftpTransferConcurrency(() => 17), DEFAULT_SFTP_FILE_TRANSFER_CONCURRENCY);
});

test("keeps directory listing concurrency within the supported range", () => {
  assert.equal(resolveSftpDirectoryListingConcurrency(() => 1), 1);
  assert.equal(resolveSftpDirectoryListingConcurrency(() => 8), 8);
  assert.equal(
    resolveSftpDirectoryListingConcurrency(() => 0),
    DEFAULT_SFTP_DIRECTORY_LISTING_CONCURRENCY,
  );
  assert.equal(
    resolveSftpDirectoryListingConcurrency(() => 9),
    DEFAULT_SFTP_DIRECTORY_LISTING_CONCURRENCY,
  );
});

test("limits default multi-file transfer scheduling to two concurrent workers", async () => {
  let active = 0;
  let maxActive = 0;

  await runSftpTransferWorkers([1, 2, 3, 4], () => null, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  });

  assert.equal(maxActive, 2);
});

test("runBoundedConcurrency respects an explicit limit", async () => {
  let active = 0;
  let maxActive = 0;
  await runBoundedConcurrency([1, 2, 3, 4, 5, 6], 3, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  });
  assert.equal(maxActive, 3);
});

test("beforeClaim runs before claiming the next queue index", async () => {
  const events: string[] = [];
  let paused = true;

  const run = runSftpTransferWorkers(
    ["a", "b"],
    () => 1,
    async (item) => {
      events.push(`work:${item}`);
    },
    {
      beforeClaim: async () => {
        events.push("claim-gate");
        while (paused) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      },
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, ["claim-gate"]);
  paused = false;
  await run;
  assert.deepEqual(events, ["claim-gate", "work:a", "claim-gate", "work:b"]);
});
