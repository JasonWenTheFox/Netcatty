"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { parseSsOutput, parseNetstatOutput, parseListeningPorts } = require("./portOps.cjs");

test("parseSsOutput reads tcp/udp listeners and process fields", () => {
  const sample = `
Netid State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process
tcp   LISTEN 0      128          0.0.0.0:22         0.0.0.0:*    users:(("sshd",pid=1234,fd=3))
tcp   LISTEN 0      511                *:80               *:*    users:(("nginx",pid=99,fd=6))
udp   UNCONN 0      0            127.0.0.1:53         0.0.0.0:*    users:(("systemd-resolve",pid=500,fd=12))
tcp6  LISTEN 0      128             [::]:443            [::]:*    users:(("nginx",pid=99,fd=7))
`;
  const ports = parseSsOutput(sample);
  assert.equal(ports.length, 4);
  assert.deepEqual(
    ports.find((p) => p.port === 22),
    {
      id: "tcp|*|22|1234",
      protocol: "tcp",
      address: "*",
      port: 22,
      pid: 1234,
      processName: "sshd",
    },
  );
  assert.equal(ports.find((p) => p.port === 80)?.processName, "nginx");
  assert.equal(ports.find((p) => p.port === 53)?.protocol, "udp");
  assert.equal(ports.find((p) => p.port === 443)?.protocol, "tcp6");
});

test("parseNetstatOutput maps pid/program", () => {
  const sample = `
Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name
tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      1234/sshd
tcp6       0      0 :::80                   :::*                    LISTEN      99/nginx
udp        0      0 127.0.0.1:53            0.0.0.0:*                           500/systemd-resolve
`;
  const ports = parseNetstatOutput(sample);
  assert.equal(ports.length, 3);
  assert.equal(ports.find((p) => p.port === 22)?.processName, "sshd");
  assert.equal(ports.find((p) => p.port === 80)?.address, "*");
});

test("parseListeningPorts prefers ss section markers", () => {
  const stdout = `
__NC_PORTS_BEGIN__
__NC_SS__
tcp   LISTEN 0      128          0.0.0.0:22         0.0.0.0:*    users:(("sshd",pid=1,fd=3))
__NC_PORTS_END__
`;
  const ports = parseListeningPorts(stdout);
  assert.equal(ports.length, 1);
  assert.equal(ports[0].port, 22);
});
