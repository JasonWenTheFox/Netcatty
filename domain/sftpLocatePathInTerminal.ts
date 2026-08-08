import { resolveInteractiveTerminalCdIntent } from "./sessionRestore";

export type LocateSftpPathInTerminalContext = {
  path?: string | null;
  sessionId?: string | null;
  sessionStatus?: string | null;
  sessionHostId?: string | null;
  sftpHostId?: string | null;
  sftpIsLocal?: boolean;
  protocol?: string | null;
  shellType?: string | null;
  isNetworkDevice?: boolean;
  moshEnabled?: boolean;
  etEnabled?: boolean;
};

/** Whether the SFTP current path can be sent as `cd` to the linked terminal. */
export function canLocateSftpPathInTerminal(
  options: LocateSftpPathInTerminalContext,
): boolean {
  if (!options.sessionId || options.sessionStatus !== "connected") return false;
  if (options.isNetworkDevice) return false;
  if (!resolveInteractiveTerminalCdIntent(options.path)) return false;

  const protocol = options.protocol ?? "ssh";
  if (protocol === "telnet" || protocol === "serial") return false;
  if (protocol === "local" && (options.shellType === "powershell" || options.shellType === "cmd")) {
    return false;
  }

  if (options.sftpIsLocal) {
    return protocol === "local";
  }

  if (!options.sftpHostId || !options.sessionHostId) return false;
  if (options.sftpHostId !== options.sessionHostId) return false;

  return protocol === "ssh" || protocol === "local" || protocol === undefined;
}

/** Session write payload for locating the SFTP path in the linked terminal. */
export function resolveLocateSftpPathInTerminalAction(
  options: LocateSftpPathInTerminalContext,
): { sessionId: string; data: string } | null {
  if (!canLocateSftpPathInTerminal(options) || !options.sessionId) return null;
  const intent = resolveInteractiveTerminalCdIntent(options.path);
  if (!intent) return null;
  return { sessionId: options.sessionId, data: `${intent.command}\r` };
}
