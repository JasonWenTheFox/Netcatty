/**
 * Low-cost retry for progressive / external drag-drop file uploads.
 *
 * These rows use sourceConnectionId "external" and never have dual-pane
 * endpoints, so the generic processTransfer retry path silently no-ops.
 * Retry re-opens a single startStreamTransfer with the stored local path.
 */

import type { TransferTask } from "../../../domain/models";
import type { TransferConnectionLease } from "./transferConnectionPool";

export function isExternalDragDropFileUpload(
  task: Pick<
    TransferTask,
    | "origin"
    | "direction"
    | "sourceConnectionId"
    | "isDirectory"
    | "sourcePath"
    | "targetPath"
    | "retryable"
    | "status"
  >,
): boolean {
  if (task.retryable === false) return false;
  if (task.origin !== "drag-drop") return false;
  if (task.direction !== "upload") return false;
  if (task.sourceConnectionId !== "external") return false;
  if (task.isDirectory) return false;
  if (!task.sourcePath || task.sourcePath === "local") return false;
  if (!task.targetPath) return false;
  return task.status === "failed" || task.status === "cancelled" || task.status === "attention";
}

export type ExternalDragDropRetryDeps = {
  getBrowseSftpId: (connectionId: string) => string | undefined;
  acquireTransferSession?: (
    hostId: string,
    transferId: string,
  ) => Promise<TransferConnectionLease>;
  startStreamTransfer: (options: {
    transferId: string;
    sourcePath: string;
    targetPath: string;
    sourceType: "local";
    targetType: "local" | "sftp";
    targetSftpId?: string;
    targetHostId?: string;
    totalBytes?: number;
    resumable?: boolean;
    checkpointBytes?: number;
  }) => Promise<{ error?: string; cancelled?: boolean } | undefined>;
  clearPendingCancel?: (transferId: string) => Promise<unknown>;
  cleanupArtifacts?: (task: TransferTask) => Promise<void>;
  onPatch: (taskId: string, updates: Partial<TransferTask>) => void;
};

/**
 * Restart a failed/cancelled external drag-drop file upload in place (same id).
 * Returns true when the stream completed successfully.
 */
export async function retryExternalDragDropFileUpload(
  task: TransferTask,
  deps: ExternalDragDropRetryDeps,
): Promise<{ success: boolean; error?: string }> {
  if (!isExternalDragDropFileUpload(task)) {
    return { success: false, error: "Not an external drag-drop file upload" };
  }

  try {
    await deps.clearPendingCancel?.(task.id);
  } catch {
    // best-effort
  }
  try {
    await deps.cleanupArtifacts?.(task);
  } catch {
    // best-effort
  }

  const targetIsLocal = task.targetConnectionId === "local" || !task.targetHostId;
  let lease: TransferConnectionLease | null = null;
  let targetSftpId: string | undefined;

  try {
    if (!targetIsLocal) {
      targetSftpId = deps.getBrowseSftpId(task.targetConnectionId);
      if (!targetSftpId && task.targetHostId && deps.acquireTransferSession) {
        lease = await deps.acquireTransferSession(task.targetHostId, `${task.id}:retry`);
        targetSftpId = lease.sftpId;
      }
      if (!targetSftpId) {
        const error = "No SFTP session available to retry this upload. Reconnect and try again.";
        deps.onPatch(task.id, {
          status: "failed",
          error,
          endTime: Date.now(),
          speed: 0,
        });
        return { success: false, error };
      }
    }

    deps.onPatch(task.id, {
      status: "transferring",
      error: undefined,
      transferredBytes: 0,
      checkpointBytes: 0,
      speed: 0,
      endTime: undefined,
      phase: "transferring",
      reconnectRequired: false,
      pauseUnavailableReason: undefined,
      startTime: Date.now(),
    });

    const result = await deps.startStreamTransfer({
      transferId: task.id,
      sourcePath: task.sourcePath,
      targetPath: task.targetPath,
      sourceType: "local",
      targetType: targetIsLocal ? "local" : "sftp",
      targetSftpId: targetIsLocal ? undefined : targetSftpId,
      targetHostId: targetIsLocal ? undefined : task.targetHostId,
      totalBytes: task.totalBytes > 0 ? task.totalBytes : undefined,
      resumable: true,
      checkpointBytes: 0,
    });

    if (result?.cancelled) {
      deps.onPatch(task.id, {
        status: "cancelled",
        error: undefined,
        endTime: Date.now(),
        speed: 0,
        phase: undefined,
      });
      return { success: false, error: "Transfer cancelled" };
    }
    if (result?.error) {
      deps.onPatch(task.id, {
        status: "failed",
        error: result.error,
        endTime: Date.now(),
        speed: 0,
        phase: undefined,
      });
      return { success: false, error: result.error };
    }

    deps.onPatch(task.id, {
      status: "completed",
      error: undefined,
      transferredBytes: Math.max(task.totalBytes, task.transferredBytes, 0),
      endTime: Date.now(),
      speed: 0,
      phase: undefined,
    });
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.onPatch(task.id, {
      status: "failed",
      error: message,
      endTime: Date.now(),
      speed: 0,
      phase: undefined,
    });
    if (lease && /session|sftp|disconnect|not found/i.test(message)) {
      try { lease.discard(); } catch { /* best-effort */ }
      lease = null;
    }
    return { success: false, error: message };
  } finally {
    try { lease?.release(); } catch { /* best-effort */ }
  }
}
