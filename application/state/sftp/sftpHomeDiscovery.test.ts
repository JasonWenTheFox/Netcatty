import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSftpHomeCandidates,
  buildSftpListFallbackPaths,
  isProvisionalSftpHomeDir,
  shouldSuppressSftpHomeCandidateProbe,
} from "./sftpHomeDiscovery.ts";

test("filesystem root from realpath is provisional and must not suppress candidate probing", () => {
  assert.equal(isProvisionalSftpHomeDir("/"), true);
  assert.equal(shouldSuppressSftpHomeCandidateProbe("/"), false);
});

test("concrete homes from exec or realpath still suppress candidate probing", () => {
  assert.equal(isProvisionalSftpHomeDir("/home/deploy"), false);
  assert.equal(shouldSuppressSftpHomeCandidateProbe("/home/deploy"), true);
  assert.equal(shouldSuppressSftpHomeCandidateProbe("/root"), true);
});

test("home candidates prefer /home/<user> then /root", () => {
  assert.deepEqual(buildSftpHomeCandidates("deploy"), ["/home/deploy", "/root"]);
  assert.deepEqual(buildSftpHomeCandidates("root"), ["/root"]);
  assert.deepEqual(buildSftpHomeCandidates(""), ["/root"]);
  assert.deepEqual(buildSftpHomeCandidates(null), ["/root"]);
});

test("list fallback keeps virtual root behavior when start is already /", () => {
  // JumpServer-style: start and home are /, no extra root retry.
  assert.deepEqual(
    buildSftpListFallbackPaths({ startPath: "/", homeDir: "/", username: "ops" }),
    ["/home/ops", "/root"],
  );
});

test("list fallback for provisional root recovers /home/<user> after failed /", () => {
  const paths = buildSftpListFallbackPaths({
    startPath: "/",
    homeDir: "/",
    username: "deploy",
  });
  assert.deepEqual(paths, ["/home/deploy", "/root"]);
  assert.ok(paths.includes("/home/deploy"));
});

test("list fallback for concrete home still tries / after homeDir", () => {
  assert.deepEqual(
    buildSftpListFallbackPaths({
      startPath: "/var/stale",
      homeDir: "/home/deploy",
      username: "deploy",
    }),
    ["/home/deploy", "/"],
  );
});
