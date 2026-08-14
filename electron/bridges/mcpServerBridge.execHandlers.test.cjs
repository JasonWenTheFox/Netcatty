"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { createBackgroundJobApi } = require("./mcpServerBridge/backgroundJobs.cjs");
const { createExecHandlerApi } = require("./mcpServerBridge/execHandlers.cjs");
const { PROBE_OUTPUT_MARKER } = require("./ai/sessionShellKind.cjs");
const { execViaPty, execViaRawPty } = require("./ai/ptyExec.cjs");

class FakePty extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
  }

  write(data) {
    this.writes.push(String(data));
  }
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createDeferredShellProbeConn(stdout = `${PROBE_OUTPUT_MARKER}/usr/bin/fish\n`) {
  let execCallback = null;
  const conn = {
    exec(_command, callback) {
      execCallback = callback;
    },
  };
  return {
    conn,
    release() {
      assert.equal(typeof execCallback, "function", "probe should be waiting for ssh exec callback");
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.close = () => stream.emit("close");
      execCallback(null, stream);
      queueMicrotask(() => {
        stream.emit("data", Buffer.from(stdout));
        stream.emit("close");
      });
    },
  };
}

function createExecHandlerTestContext({ sessions, backgroundJobs }) {
  const ctx = {
    sessions,
    backgroundJobs,
    activeSessionSftpOps: new Map(),
    closingTerminalSessions: new Map(),
    activeSessionExecutions: new Map(),
    activePtyExecs: new Map(),
    crypto,
    sftpBridge: {},
    BACKGROUND_JOB_RETENTION_MS: 10 * 60 * 1000,
    DEFAULT_BACKGROUND_JOB_POLL_INTERVAL_MS: 30 * 1000,
    MAX_BACKGROUND_JOB_OUTPUT_CHARS: 256 * 1024,
    SESSION_CLOSE_CLEANUP_TIMEOUT_MS: 20,
    DEFAULT_BACKGROUND_JOB_TIMEOUT_MS: 60 * 60 * 1000,
    commandTimeoutMs: 5000,
    activeSftpOpSeq: 0,
    debugLog() {},
    getSessionMeta() {
      return {};
    },
    checkCommandSafety() {
      return { blocked: false };
    },
    beginChatExecution() {
      return { ok: true, release() {} };
    },
    execViaPty,
    execViaRawPty,
    getFreshIdlePrompt() {
      return "";
    },
    echoCommandToSession() {},
    validateSessionScope() {
      return null;
    },
  };
  Object.assign(ctx, createBackgroundJobApi(ctx));
  return ctx;
}

test("SFTP cancellation targets one terminal session and waits for cleanup", async () => {
  const ctx = createExecHandlerTestContext({ sessions: new Map(), backgroundJobs: new Map() });
  const events = [];
  ctx.registerSftpOp("chat-1", "session-1", async () => {
    await nextTick();
    events.push("session-1-clean");
  });
  ctx.registerSftpOp("chat-2", "session-1", () => {
    events.push("session-1-other-scope-clean");
  });
  ctx.registerSftpOp("chat-1", "session-2", () => {
    events.push("session-2-clean");
  });

  await ctx.cancelSftpOpsForTerminalSession("session-1");

  assert.deepEqual(events, ["session-1-other-scope-clean", "session-1-clean"]);
  assert.equal(ctx.activeSessionSftpOps.size, 1);
});

test("terminal close does not hang on stalled SFTP cleanup", async () => {
  const ctx = createExecHandlerTestContext({ sessions: new Map(), backgroundJobs: new Map() });
  ctx.activeSessionSftpOps.set("sftp-stalled", {
    chatSessionId: "chat-1",
    sessionId: "session-1",
    cancel: () => new Promise(() => {}),
  });

  const startedAt = Date.now();
  await ctx.cancelSftpOpsForTerminalSession("session-1");

  assert.ok(Date.now() - startedAt < 200, "session close cleanup should be bounded");
  assert.equal(ctx.activeSessionSftpOps.size, 0);
});

test("SFTP operations that start while a terminal is closing are cancelled immediately", () => {
  const ctx = createExecHandlerTestContext({ sessions: new Map(), backgroundJobs: new Map() });
  let cancelled = false;
  ctx.beginTerminalSessionClose("session-1");

  ctx.registerSftpOp("chat-1", "session-1", () => {
    cancelled = true;
  });

  assert.equal(cancelled, true);
  assert.equal(ctx.activeSessionSftpOps.size, 0);
  ctx.endTerminalSessionClose("session-1");
});

test("overlapping closes keep SFTP blocked until the last close finishes", () => {
  const ctx = createExecHandlerTestContext({ sessions: new Map(), backgroundJobs: new Map() });
  ctx.beginTerminalSessionClose("session-1");
  ctx.beginTerminalSessionClose("session-1");
  ctx.endTerminalSessionClose("session-1");

  let cancelled = false;
  ctx.registerSftpOp("chat-1", "session-1", () => {
    cancelled = true;
  });
  assert.equal(cancelled, true);

  ctx.endTerminalSessionClose("session-1");
  ctx.registerSftpOp("chat-1", "session-1", () => {});
  assert.equal(ctx.activeSessionSftpOps.size, 1);
});

test("terminal close cancels and removes background jobs for that terminal", async () => {
  let cancelCount = 0;
  let settleJob;
  const resultPromise = new Promise((resolve) => {
    settleJob = resolve;
  });
  const backgroundJobs = new Map([
    ["job-1", {
      sessionId: "session-1",
      status: "running",
      handle: {
        cancel: () => { cancelCount += 1; },
        resultPromise,
      },
    }],
    ["job-2", { sessionId: "session-2", status: "running", handle: {} }],
  ]);
  const ctx = createExecHandlerTestContext({ sessions: new Map(), backgroundJobs });
  ctx.activeSessionExecutions.set("session-1", { kind: "job", token: "token-1" });

  ctx.cancelBackgroundJobsForTerminalSession("session-1");
  assert.equal(cancelCount, 1);
  assert.equal(backgroundJobs.get("job-1").status, "stopping");

  const settling = ctx.settleBackgroundJobsForTerminalSession("session-1");
  assert.equal(backgroundJobs.has("job-1"), true);
  settleJob({ error: "Cancelled" });
  await settling;

  assert.equal(backgroundJobs.has("job-1"), false);
  assert.equal(backgroundJobs.has("job-2"), true);
  assert.equal(ctx.activeSessionExecutions.has("session-1"), false);
});

test("MCP terminal_start chat cancel during shellKind probe aborts before PTY write", async () => {
  const pty = new FakePty();
  const deferred = createDeferredShellProbeConn();
  const sessions = new Map([
    ["ssh-fish", {
      protocol: "ssh",
      stream: pty,
      conn: deferred.conn,
    }],
  ]);
  const backgroundJobs = new Map();
  const ctx = createExecHandlerTestContext({ sessions, backgroundJobs });
  const api = createExecHandlerApi(ctx);

  const pendingStart = api.handleJobStart({
    sessionId: "ssh-fish",
    command: "sleep 999",
    chatSessionId: "chat-cancel-probe",
  });
  await nextTick();

  assert.equal(backgroundJobs.size, 1, "job should be registered while probe is pending");
  ctx.cancelBackgroundJobsForSession("chat-cancel-probe");

  deferred.release();
  const started = await pendingStart;

  assert.equal(started.ok, false);
  assert.equal(started.error, "Cancelled");
  assert.equal(started.status, "cancelled");
  assert.equal(
    pty.writes.filter((entry) => entry.includes("__NCMCP_")).length,
    0,
    "cancelled pending start must not type a wrapper into the PTY",
  );
  const [job] = backgroundJobs.values();
  assert.equal(job.status, "cancelled");
  assert.equal(job.pendingShellProbe, false);
  assert.equal(ctx.activeSessionExecutions.size, 0);
});

test("MCP raw exec refuses awaiting network-device input without writing", async () => {
  const pty = new FakePty();
  const sessions = new Map([["device-1", {
    protocol: "ssh",
    stream: pty,
    _awaitingPrimaryPromptAfterUserSubmit: true,
  }]]);
  const ctx = createExecHandlerTestContext({ sessions, backgroundJobs: new Map() });
  ctx.getSessionMeta = () => ({ protocol: "ssh", deviceType: "network" });
  const api = createExecHandlerApi(ctx);

  const result = await api.handleExec({
    sessionId: "device-1",
    command: "show version",
    chatSessionId: "chat-1",
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /unsubmitted terminal input/i);
  assert.deepEqual(pty.writes, []);
});

test("MCP raw exec refuses awaiting serial input without writing", async () => {
  const serialPort = new FakePty();
  const sessions = new Map([["serial-1", {
    protocol: "serial",
    serialPort,
    _awaitingPrimaryPromptAfterUserSubmit: true,
  }]]);
  const ctx = createExecHandlerTestContext({ sessions, backgroundJobs: new Map() });
  ctx.getSessionMeta = () => ({ protocol: "serial" });
  const api = createExecHandlerApi(ctx);

  const result = await api.handleExec({
    sessionId: "serial-1",
    command: "show version",
    chatSessionId: "chat-1",
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /terminal input/i);
  assert.deepEqual(serialPort.writes, []);
});

test("MCP serial exec refuses active file transfer without writing", async () => {
  const serialPort = new FakePty();
  const sessions = new Map([["serial-transfer", {
    protocol: "serial",
    serialPort,
    zmodemSentry: { isActive: () => true },
  }]]);
  const ctx = createExecHandlerTestContext({ sessions, backgroundJobs: new Map() });
  ctx.getSessionMeta = () => ({ protocol: "serial" });
  const api = createExecHandlerApi(ctx);
  const result = await api.handleExec({
    sessionId: "serial-transfer",
    command: "show version",
    chatSessionId: "chat-1",
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /file transfer/i);
  assert.deepEqual(serialPort.writes, []);
});

test("MCP shell exec refuses verified pending input without writing", async () => {
  const pty = new FakePty();
  pty.write = function write(data) {
    const text = String(data);
    this.writes.push(text);
    if (text === "i") {
      queueMicrotask(() => this.emit("data", Buffer.from("i")));
    } else if (text === "\x03") {
      queueMicrotask(() => this.emit("data", Buffer.from("^C\r\nuser@host:~$")));
    } else {
      const marker = text.match(/(__NCMCP_[A-Za-z0-9_]+__)/)?.[1];
      if (marker) {
        queueMicrotask(() => this.emit("data", Buffer.from(`${marker}_S\r\nok\r\n${marker}_E:0\r\n`)));
      }
    }
  };
  const session = {
    protocol: "local",
    stream: pty,
    shellKind: "posix",
    lastIdlePrompt: "user@host:~$",
    _promptTrackTail: "user@host:~$ls",
    _hasPendingUserInput: true,
    _pendingInputSafetyProbe: async () => true,
  };
  const ctx = createExecHandlerTestContext({
    sessions: new Map([["shell-1", session]]),
    backgroundJobs: new Map(),
  });
  const api = createExecHandlerApi(ctx);

  const result = await api.handleExec({
    sessionId: "shell-1",
    command: "uname -a",
    chatSessionId: "chat-1",
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /terminal input may still be active/i);
  assert.deepEqual(pty.writes, []);
  assert.equal(session._hasPendingUserInput, true);
});

test("MCP shell exec refuses when user input changes during foreground verification", async () => {
  const pty = new FakePty();
  let releaseProbe;
  const probe = new Promise((resolve) => { releaseProbe = resolve; });
  const session = {
    protocol: "local",
    stream: pty,
    shellKind: "posix",
    lastIdlePrompt: "user@host:~$",
    _promptTrackTail: "user@host:~$ls",
    _hasPendingUserInput: true,
    _userInputRevision: 1,
    _pendingInputSafetyProbe: () => probe,
  };
  const ctx = createExecHandlerTestContext({
    sessions: new Map([["shell-race", session]]),
    backgroundJobs: new Map(),
  });
  const api = createExecHandlerApi(ctx);

  const pending = api.handleExec({
    sessionId: "shell-race",
    command: "uname -a",
    chatSessionId: "chat-1",
  });
  await nextTick();
  session._hasPendingUserInput = false;
  session._userInputRevision = 2;
  releaseProbe(false);
  const result = await pending;

  assert.equal(result.ok, false);
  assert.match(result.error, /input changed/i);
  assert.deepEqual(pty.writes, []);
});

test("MCP terminal_start refuses when user input changes during verification", async () => {
  const pty = new FakePty();
  let releaseProbe;
  const probe = new Promise((resolve) => { releaseProbe = resolve; });
  const session = {
    protocol: "local",
    stream: pty,
    shellKind: "posix",
    _hasPendingUserInput: true,
    _userInputRevision: 1,
    _pendingInputSafetyProbe: () => probe,
  };
  const backgroundJobs = new Map();
  const ctx = createExecHandlerTestContext({
    sessions: new Map([["shell-race", session]]),
    backgroundJobs,
  });
  const api = createExecHandlerApi(ctx);

  const pending = api.handleJobStart({
    sessionId: "shell-race",
    command: "sleep 1",
    chatSessionId: "chat-1",
  });
  await nextTick();
  session._hasPendingUserInput = false;
  session._userInputRevision = 2;
  releaseProbe(false);
  const result = await pending;

  assert.equal(result.ok, false);
  assert.match(result.error, /input changed/i);
  assert.deepEqual(pty.writes, []);
});
