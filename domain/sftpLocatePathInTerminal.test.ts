import test from "node:test";
import assert from "node:assert/strict";

import {
  canLocateSftpPathInTerminal,
  resolveLocateSftpPathInTerminalAction,
} from "./sftpLocatePathInTerminal.ts";

const base = {
  path: "/home/user/project",
  sessionId: "sess-1",
  sessionStatus: "connected" as const,
  sessionHostId: "host-1",
  sftpHostId: "host-1",
  sftpIsLocal: false,
  protocol: "ssh" as const,
  shellType: "posix" as const,
  isNetworkDevice: false,
};

test("canLocateSftpPathInTerminal allows connected SSH sessions on the same host", () => {
  assert.equal(canLocateSftpPathInTerminal(base), true);
});

test("canLocateSftpPathInTerminal allows mosh/et interactive cd (unlike silent restore)", () => {
  assert.equal(canLocateSftpPathInTerminal({ ...base, moshEnabled: true }), true);
  assert.equal(canLocateSftpPathInTerminal({ ...base, etEnabled: true }), true);
});

test("canLocateSftpPathInTerminal rejects missing session, disconnected session, or host mismatch", () => {
  assert.equal(canLocateSftpPathInTerminal({ ...base, sessionId: null }), false);
  assert.equal(canLocateSftpPathInTerminal({ ...base, sessionStatus: "disconnected" }), false);
  assert.equal(canLocateSftpPathInTerminal({ ...base, sftpHostId: "other-host" }), false);
});

test("canLocateSftpPathInTerminal rejects network devices, telnet/serial, and Windows local shells", () => {
  assert.equal(canLocateSftpPathInTerminal({ ...base, isNetworkDevice: true }), false);
  assert.equal(canLocateSftpPathInTerminal({ ...base, protocol: "telnet" }), false);
  assert.equal(canLocateSftpPathInTerminal({ ...base, protocol: "serial" }), false);
  assert.equal(
    canLocateSftpPathInTerminal({
      ...base,
      protocol: "local",
      shellType: "powershell",
      sftpIsLocal: true,
      sessionHostId: "local-1",
      sftpHostId: "local-1",
    }),
    false,
  );
});

test("canLocateSftpPathInTerminal rejects ineligible paths", () => {
  assert.equal(canLocateSftpPathInTerminal({ ...base, path: "" }), false);
  assert.equal(canLocateSftpPathInTerminal({ ...base, path: "C:\\Users\\alice" }), false);
  assert.equal(canLocateSftpPathInTerminal({ ...base, path: "relative/path" }), false);
});

test("resolveLocateSftpPathInTerminalAction builds a quoted cd payload", () => {
  assert.deepEqual(
    resolveLocateSftpPathInTerminalAction({
      ...base,
      path: "/srv/app dir",
    }),
    {
      sessionId: "sess-1",
      data: "cd -- '/srv/app dir'\r",
    },
  );
});

test("resolveLocateSftpPathInTerminalAction returns null when locate is unavailable", () => {
  assert.equal(
    resolveLocateSftpPathInTerminalAction({
      ...base,
      sessionStatus: "connecting",
    }),
    null,
  );
});
