/**
 * Detect archive types and build extract commands for remote SSH exec / local spawn.
 * Pure helpers plus local process I/O — no SFTP session access.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const ARCHIVE_KINDS = [
  { kind: "tar.gz", suffixes: [".tar.gz", ".tgz"] },
  { kind: "tar.bz2", suffixes: [".tar.bz2", ".tbz2", ".tar.bzip2"] },
  { kind: "tar.xz", suffixes: [".tar.xz", ".txz"] },
  { kind: "tar.zst", suffixes: [".tar.zst", ".tzst"] },
  { kind: "tar", suffixes: [".tar"] },
  { kind: "zip", suffixes: [".zip"] },
  { kind: "gz", suffixes: [".gz"] },
  { kind: "bz2", suffixes: [".bz2"] },
  { kind: "xz", suffixes: [".xz"] },
];

const EXTRACT_OPEN_TIMEOUT_MS = 15_000;
const EXTRACT_BASE_TIMEOUT_MS = 60_000;
const EXTRACT_MAX_TIMEOUT_MS = 10 * 60_000;
const EXTRACT_MAX_OUTPUT_BYTES = 64 * 1024;

function getArchiveBaseName(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || "";
}

function getArchiveKind(filePath) {
  const base = getArchiveBaseName(filePath).toLowerCase();
  if (!base) return null;
  for (const entry of ARCHIVE_KINDS) {
    if (entry.suffixes.some((suffix) => base.endsWith(suffix) && base.length > suffix.length)) {
      return entry.kind;
    }
  }
  return null;
}

function isExtractableArchive(filePath) {
  return getArchiveKind(filePath) != null;
}

function posixParentDir(remotePath) {
  const normalized = String(remotePath || "").replace(/\\/g, "/");
  if (!normalized || normalized === "/" || normalized === ".") {
    throw new Error("Archive path has no parent directory");
  }
  const trimmed = normalized.replace(/\/+$/, "") || "/";
  if (trimmed === "/") {
    throw new Error("Archive path has no parent directory");
  }
  const idx = trimmed.lastIndexOf("/");
  if (idx < 0) return ".";
  if (idx === 0) return "/";
  return trimmed.slice(0, idx);
}

function stripCompressionSuffix(filePath, kind) {
  const suffix = kind === "gz" ? ".gz" : kind === "bz2" ? ".bz2" : kind === "xz" ? ".xz" : "";
  if (!suffix) {
    throw new Error(`Cannot strip suffix for archive kind: ${kind}`);
  }
  const base = getArchiveBaseName(filePath);
  if (base.length <= suffix.length || !base.toLowerCase().endsWith(suffix)) {
    throw new Error(`Archive name does not match kind ${kind}`);
  }
  const parent = posixParentDir(filePath);
  const stem = base.slice(0, base.length - suffix.length);
  if (parent === "/") return `/${stem}`;
  if (parent === ".") return stem;
  return `${parent}/${stem}`;
}

function computeExtractTimeoutMs(archiveSize) {
  const size = Number(archiveSize);
  if (!Number.isFinite(size) || size <= 0) return EXTRACT_MAX_TIMEOUT_MS;
  const extra = Math.ceil(size / (10 * 1024 * 1024)) * 30_000;
  return Math.min(EXTRACT_MAX_TIMEOUT_MS, Math.max(EXTRACT_BASE_TIMEOUT_MS, EXTRACT_BASE_TIMEOUT_MS + extra));
}

function buildExtractCommand(archivePath, { encoding = "utf-8" } = {}) {
  const kind = getArchiveKind(archivePath);
  if (!kind) {
    throw new Error(`Unsupported archive type: ${getArchiveBaseName(archivePath) || archivePath}`);
  }
  const { assertSafeRemotePath, shellQuotePath } = require("./scpShell.cjs");
  const remotePath = assertSafeRemotePath(archivePath);
  const parent = posixParentDir(remotePath);
  const qArchive = shellQuotePath(remotePath, encoding);
  const qParent = shellQuotePath(parent, encoding);

  if (kind === "tar") return `tar -xf ${qArchive} -C ${qParent}`;
  if (kind === "tar.gz") return `tar -xzf ${qArchive} -C ${qParent}`;
  if (kind === "tar.bz2") return `tar -xjf ${qArchive} -C ${qParent}`;
  if (kind === "tar.xz") return `tar -xJf ${qArchive} -C ${qParent}`;
  if (kind === "tar.zst") return `tar --zstd -xf ${qArchive} -C ${qParent}`;
  if (kind === "zip") {
    return [
      `if command -v unzip >/dev/null 2>&1; then`,
      `  unzip -o ${qArchive} -d ${qParent}`,
      `elif tar -tf ${qArchive} >/dev/null 2>&1; then`,
      `  tar -xf ${qArchive} -C ${qParent}`,
      `else`,
      `  echo 'unzip is not installed on the remote host' >&2`,
      `  exit 127`,
      `fi`,
    ].join("\n");
  }

  const qOut = shellQuotePath(stripCompressionSuffix(remotePath, kind), encoding);
  if (kind === "gz") return `gzip -dc -- ${qArchive} > ${qOut}`;
  if (kind === "bz2") return `bzip2 -dc -- ${qArchive} > ${qOut}`;
  if (kind === "xz") return `xz -dc -- ${qArchive} > ${qOut}`;
  throw new Error(`Unsupported archive type: ${kind}`);
}

function tarArgs(flag, archivePath, parentDir) {
  return flag ? [flag, archivePath, "-C", parentDir] : ["-xf", archivePath, "-C", parentDir];
}

function buildLocalExtractPlan(archivePath, platform = process.platform) {
  const kind = getArchiveKind(archivePath);
  if (!kind) {
    throw new Error(`Unsupported archive type: ${path.basename(archivePath) || archivePath}`);
  }
  const parentDir = path.dirname(archivePath);
  if (kind === "tar") return { command: "tar", args: tarArgs("-xf", archivePath, parentDir) };
  if (kind === "tar.gz") return { command: "tar", args: tarArgs("-xzf", archivePath, parentDir) };
  if (kind === "tar.bz2") return { command: "tar", args: tarArgs("-xjf", archivePath, parentDir) };
  if (kind === "tar.xz") return { command: "tar", args: tarArgs("-xJf", archivePath, parentDir) };
  if (kind === "tar.zst") return { command: "tar", args: ["--zstd", "-xf", archivePath, "-C", parentDir] };
  if (kind === "zip") {
    if (platform === "win32") {
      return { command: "tar", args: ["-xf", archivePath, "-C", parentDir] };
    }
    return {
      command: "unzip",
      args: ["-o", archivePath, "-d", parentDir],
      fallback: { command: "tar", args: ["-xf", archivePath, "-C", parentDir] },
    };
  }

  const outputPath = path.join(parentDir, path.basename(stripCompressionSuffix(archivePath.replace(/\\/g, "/"), kind)));
  if (kind === "gz") return { command: "gzip", args: ["-dc", archivePath], stdoutFile: outputPath };
  if (kind === "bz2") return { command: "bzip2", args: ["-dc", archivePath], stdoutFile: outputPath };
  if (kind === "xz") return { command: "xz", args: ["-dc", archivePath], stdoutFile: outputPath };
  throw new Error(`Unsupported archive type: ${kind}`);
}

function isMissingBinaryError(error) {
  const code = error?.code;
  return code === "ENOENT" || code === 127 || code === "127";
}

function pipeCommandToFile(command, args, stdoutFile, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = fs.createWriteStream(stdoutFile);
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`Local extraction timed out after ${timeoutMs} ms`));
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, timeoutMs);
    timer.unref?.();
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { out.destroy(); } catch { /* ignore */ }
      if (error) {
        fs.promises.unlink(stdoutFile).catch(() => {});
        reject(error);
        return;
      }
      resolve();
    };
    child.stdout.pipe(out);
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > EXTRACT_MAX_OUTPUT_BYTES) {
        stderr = stderr.slice(0, EXTRACT_MAX_OUTPUT_BYTES);
      }
    });
    out.on("error", (error) => finish(error));
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code === 0) {
        out.end(() => finish(null));
        return;
      }
      finish(new Error(
        `Local extraction failed (code ${code})${stderr ? `: ${stderr.trim()}` : ""}`,
      ));
    });
  });
}

async function runLocalExtractCommand(command, args, stdoutFile, timeoutMs) {
  if (stdoutFile) {
    await pipeCommandToFile(command, args, stdoutFile, timeoutMs);
    return;
  }
  await execFileAsync(command, args, {
    timeout: timeoutMs,
    maxBuffer: EXTRACT_MAX_OUTPUT_BYTES,
    windowsHide: true,
  });
}

async function executeLocalExtractPlan(plan, { timeoutMs = EXTRACT_MAX_TIMEOUT_MS } = {}) {
  try {
    await runLocalExtractCommand(plan.command, plan.args, plan.stdoutFile, timeoutMs);
  } catch (error) {
    if (plan.fallback && isMissingBinaryError(error)) {
      await runLocalExtractCommand(
        plan.fallback.command,
        plan.fallback.args,
        plan.fallback.stdoutFile,
        timeoutMs,
      );
      return;
    }
    throw error;
  }
}

async function extractLocalArchiveFile(archivePath) {
  if (typeof archivePath !== "string" || !archivePath) {
    throw new Error("Archive path is required");
  }
  const stat = await fs.promises.stat(archivePath);
  if (stat.isDirectory()) {
    throw new Error("Cannot extract a directory");
  }
  const plan = buildLocalExtractPlan(archivePath);
  await executeLocalExtractPlan(plan, { timeoutMs: computeExtractTimeoutMs(stat.size) });
  return { success: true };
}

module.exports = {
  ARCHIVE_KINDS,
  EXTRACT_OPEN_TIMEOUT_MS,
  EXTRACT_MAX_TIMEOUT_MS,
  EXTRACT_MAX_OUTPUT_BYTES,
  getArchiveKind,
  isExtractableArchive,
  posixParentDir,
  stripCompressionSuffix,
  computeExtractTimeoutMs,
  buildExtractCommand,
  buildLocalExtractPlan,
  executeLocalExtractPlan,
  extractLocalArchiveFile,
};
