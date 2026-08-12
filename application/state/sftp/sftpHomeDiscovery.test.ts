import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSftpHomeCandidates,
  buildSftpListFallbackPaths,
  isProvisionalSftpHomeDir,
  isProvisionalSftpHomeDiscovery,
  shouldSuppressSftpHomeCandidateProbe,
} from "./sftpHomeDiscovery.ts";

test("filesystem root from realpath is provisional and must not suppress candidate probing", () => {
  assert.equal(isProvisionalSftpHomeDiscovery({ homeDir: "/", provisional: true }), true);
  assert.equal(shouldSuppressSftpHomeCandidateProbe({ homeDir: "/", provisional: true }), false);
  // Legacy path-only inference when bridge omits metadata
  assert.equal(isProvisionalSftpHomeDir("/"), true);
  assert.equal(shouldSuppressSftpHomeCandidateProbe({ homeDir: "/" }), false);
});

test("authoritative HOME=/ from exec must suppress candidate probing", () => {
  assert.equal(isProvisionalSftpHomeDiscovery({ homeDir: "/", provisional: false }), false);
  assert.equal(shouldSuppressSftpHomeCandidateProbe({ homeDir: "/", provisional: false }), true);
});

test("concrete homes from exec or realpath still suppress candidate probing", () => {
  assert.equal(isProvisionalSftpHomeDiscovery({ homeDir: "/home/deploy", provisional: false }), false);
  assert.equal(shouldSuppressSftpHomeCandidateProbe({ homeDir: "/home/deploy" }), true);
  assert.equal(shouldSuppressSftpHomeCandidateProbe({ homeDir: "/root", provisional: false }), true);
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
    buildSftpListFallbackPaths({ startPath: "/", homeDir: "/", username: "ops", provisionalHome: true }),
    ["/home/ops", "/root"],
  );
});

test("list fallback for provisional root recovers /home/<user> after failed /", () => {
  const paths = buildSftpListFallbackPaths({
    startPath: "/",
    homeDir: "/",
    username: "deploy",
    provisionalHome: true,
  });
  assert.deepEqual(paths, ["/home/deploy", "/root"]);
  assert.ok(paths.includes("/home/deploy"));
});

test("list fallback for authoritative HOME=/ does not redirect to /home/<user>", () => {
  assert.deepEqual(
    buildSftpListFallbackPaths({
      startPath: "/",
      homeDir: "/",
      username: "deploy",
      provisionalHome: false,
    }),
    [],
  );
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
