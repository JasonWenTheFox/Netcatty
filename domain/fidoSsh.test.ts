import test from "node:test";
import assert from "node:assert/strict";

import {
  SK_ECDSA_NISTP256,
  SK_SSH_ED25519,
  detectFidoSshKeyType,
  extractOpenSshPublicKeyType,
  isSkPrivateKey,
  isSkPublicKey,
  requiresFidoSshAgentAuth,
} from "./fidoSsh.ts";

const skEdPub =
  "sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAABHNzaDo= user@fido";

const skEcdsaPub =
  "sk-ecdsa-sha2-nistp256@openssh.com AAAAInNrLWVjZHNhLXNoYTItbmlzdHAyNTZAb3BlbnNzaC5jb20AAAAIbmlzdHAyNTYAAABBBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAABHNzaDo= user@fido";

test("extractOpenSshPublicKeyType recognizes sk algorithms", () => {
  assert.equal(extractOpenSshPublicKeyType(skEdPub), SK_SSH_ED25519);
  assert.equal(extractOpenSshPublicKeyType(skEcdsaPub), SK_ECDSA_NISTP256);
  assert.equal(extractOpenSshPublicKeyType("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJust test"), "ssh-ed25519");
  assert.equal(isSkPublicKey(skEdPub), true);
  assert.equal(isSkPublicKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJust test"), false);
});

test("detectFidoSshKeyType maps vault and OpenSSH types", () => {
  assert.equal(detectFidoSshKeyType({ type: "ED25519-SK" }), "ED25519-SK");
  assert.equal(detectFidoSshKeyType({ publicKey: skEdPub }), "ED25519-SK");
  assert.equal(detectFidoSshKeyType({ publicKey: skEcdsaPub }), "ECDSA-SK");
  assert.equal(detectFidoSshKeyType({ type: "ED25519", publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJust test" }), undefined);
});

test("isSkPrivateKey detects OpenSSH sk key handles", () => {
  // Minimal fake OpenSSH private key body containing the sk type string after base64.
  const body = Buffer.from(`openssh-key-v1\0\0\0\0\0none\0\0\0\0\0\0\0\0\0\x01${SK_SSH_ED25519}`).toString("base64");
  const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\n`;
  assert.equal(isSkPrivateKey(pem), true);
  assert.equal(isSkPrivateKey("-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----"), false);
  assert.equal(requiresFidoSshAgentAuth({ publicKey: skEdPub }), true);
  assert.equal(requiresFidoSshAgentAuth({ privateKey: pem }), true);
  assert.equal(requiresFidoSshAgentAuth({ type: "ED25519", privateKey: "soft-key" }), false);
});
