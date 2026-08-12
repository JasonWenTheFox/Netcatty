const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");

const { createFileOpsApi } = require("./fileOps.cjs");

function createExecStream(stdoutText) {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.close = () => {};
  stream.destroy = () => {};
  queueMicrotask(() => {
    stream.emit("data", Buffer.from(stdoutText));
    stream.emit("close");
  });
  return stream;
}

test("home discovery accepts a virtual SFTP root when SSH exec is unavailable", async () => {
  const channel = {};
  const api = createFileOpsApi({
    sftpClients: new Map([["jumpserver", { sftp: channel }]]),
    throwIfAborted() {},
    requireSftpChannel: async () => channel,
    realpathAsync: async (resolvedChannel, remotePath) => {
      assert.equal(resolvedChannel, channel);
      assert.equal(remotePath, ".");
      return "/";
    },
  });

  const result = await api.getSftpHomeDir(null, { sftpId: "jumpserver" });

  assert.deepEqual(result, { success: true, homeDir: "/", provisional: true });
});

test("home discovery marks concrete realpath homes as non-provisional", async () => {
  const channel = {};
  const api = createFileOpsApi({
    sftpClients: new Map([["sftp", { sftp: channel }]]),
    throwIfAborted() {},
    requireSftpChannel: async () => channel,
    realpathAsync: async () => "/home/deploy",
  });

  const result = await api.getSftpHomeDir(null, { sftpId: "sftp" });

  assert.deepEqual(result, {
    success: true,
    homeDir: "/home/deploy",
    provisional: false,
  });
});

test("authoritative echo ~ of / is not provisional", async () => {
  const sshClient = {
    exec(_command, callback) {
      callback(null, createExecStream("/\n"));
    },
  };
  const api = createFileOpsApi({
    sftpClients: new Map([["root-home", { client: sshClient }]]),
    throwIfAborted() {},
    requireSftpChannel: async () => {
      throw new Error("realpath must not run when echo ~ succeeds");
    },
    realpathAsync: async () => {
      throw new Error("realpath must not run when echo ~ succeeds");
    },
  });

  const result = await api.getSftpHomeDir(null, { sftpId: "root-home" });

  assert.deepEqual(result, { success: true, homeDir: "/", provisional: false });
});

test("authoritative echo ~ of a concrete home is not provisional", async () => {
  const sshClient = {
    exec(_command, callback) {
      callback(null, createExecStream("/home/deploy\n"));
    },
  };
  const api = createFileOpsApi({
    sftpClients: new Map([["user-home", { client: sshClient }]]),
    throwIfAborted() {},
    requireSftpChannel: async () => {
      throw new Error("realpath must not run when echo ~ succeeds");
    },
    realpathAsync: async () => {
      throw new Error("realpath must not run when echo ~ succeeds");
    },
  });

  const result = await api.getSftpHomeDir(null, { sftpId: "user-home" });

  assert.deepEqual(result, {
    success: true,
    homeDir: "/home/deploy",
    provisional: false,
  });
});
