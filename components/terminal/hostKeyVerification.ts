import type { Host, KnownHost } from "../../types";
import type { HostKeyInfo } from "./TerminalHostKeyVerification";
import { createKnownHostFromHostKeyInfo as createKnownHostFromHostKeyInfoDomain } from "../../domain/knownHosts";

export type HostKeyVerificationRequest = {
  hostname: string;
  port?: number;
  keyType: string;
  fingerprint: string;
  publicKey?: string;
  status?: "unknown" | "changed";
  knownHostId?: string;
  knownFingerprint?: string;
};

export const toHostKeyInfo = (request: HostKeyVerificationRequest): HostKeyInfo => ({
  hostname: request.hostname,
  port: request.port,
  keyType: request.keyType,
  fingerprint: request.fingerprint,
  publicKey: request.publicKey,
  status: request.status,
  knownHostId: request.knownHostId,
  knownFingerprint: request.knownFingerprint,
});

export const createKnownHostFromHostKeyInfo = (
  hostKeyInfo: HostKeyInfo,
  host: Pick<Host, "port">,
  now = Date.now(),
  idSuffix = Math.random().toString(36).slice(2, 11),
): KnownHost => createKnownHostFromHostKeyInfoDomain(hostKeyInfo, {
  defaultPort: host.port,
  now,
  idSuffix,
});
