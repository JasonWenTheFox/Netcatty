"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getArchiveKind,
  isExtractableArchive,
  posixParentDir,
  stripCompressionSuffix,
  computeExtractTimeoutMs,
  buildExtractCommand,
  buildLocalExtractPlan,
  EXTRACT_MAX_TIMEOUT_MS,
} = require("./archiveExtract.cjs");

test("detects compound archive suffixes before single-file compression", () => {
  assert.equal(getArchiveKind("backup.tar.gz"), "tar.gz");
  assert.equal(getArchiveKind("/var/a.tgz"), "tar.gz");
  assert.equal(getArchiveKind("logs.tar.bz2"), "tar.bz2");
  assert.equal(getArchiveKind("src.tar.xz"), "tar.xz");
  assert.equal(getArchiveKind("app.tar"), "tar");
  assert.equal(getArchiveKind("payload.zip"), "zip");
  assert.equal(getArchiveKind("notes.txt.gz"), "gz");
  assert.equal(getArchiveKind("notes.txt"), null);
  assert.equal(getArchiveKind(".gz"), null);
  assert.equal(isExtractableArchive("bundle.tgz"), true);
  assert.equal(isExtractableArchive("readme.md"), false);
});

test("posix parent and gzip output stay in the archive directory", () => {
  assert.equal(posixParentDir("/home/app/a.tar.gz"), "/home/app");
  assert.equal(posixParentDir("/a.zip"), "/");
  assert.equal(stripCompressionSuffix("/home/app/notes.txt.gz", "gz"), "/home/app/notes.txt");
  assert.equal(stripCompressionSuffix("/notes.txt.gz", "gz"), "/notes.txt");
});

test("extract commands quote spaces and single quotes", () => {
  const tarCmd = buildExtractCommand("/tmp/my files/app's.tgz");
  assert.match(tarCmd, /tar -xzf '/);
  assert.match(tarCmd, /'\/tmp\/my files\/app'\\''s\.tgz'/);
  assert.match(tarCmd, /-C '\/tmp\/my files'/);

  const zipCmd = buildExtractCommand("/opt/build/out.zip");
  assert.match(zipCmd, /unzip -o '\/opt\/build\/out\.zip' -d '\/opt\/build'/);
  assert.match(zipCmd, /tar -xf '\/opt\/build\/out\.zip' -C '\/opt\/build'/);

  const gzCmd = buildExtractCommand("/var/log/syslog.gz");
  assert.equal(gzCmd, "gzip -dc -- '/var/log/syslog.gz' > '/var/log/syslog'");
});

test("extract command rejects newlines and unknown types", () => {
  assert.throws(() => buildExtractCommand("/tmp/bad\n.tar.gz"), /NUL or newlines/);
  assert.throws(() => buildExtractCommand("/tmp/notes.txt"), /Unsupported archive type/);
});

test("local extract plan uses unzip with tar fallback off Windows", () => {
  const unixZip = buildLocalExtractPlan("/tmp/a.zip", "linux");
  assert.deepEqual(unixZip.command, "unzip");
  assert.deepEqual(unixZip.args, ["-o", "/tmp/a.zip", "-d", "/tmp"]);
  assert.deepEqual(unixZip.fallback, { command: "tar", args: ["-xf", "/tmp/a.zip", "-C", "/tmp"] });

  const winZip = buildLocalExtractPlan("C:\\tmp\\a.zip", "win32");
  assert.equal(winZip.command, "tar");
  assert.ok(winZip.args.includes("-xf"));
});

test("unknown archive size uses the maximum extract timeout", () => {
  assert.equal(computeExtractTimeoutMs(undefined), EXTRACT_MAX_TIMEOUT_MS);
  assert.ok(computeExtractTimeoutMs(1024) < EXTRACT_MAX_TIMEOUT_MS);
});

test("extractLocalArchiveFile unpacks a tar.gz next to the archive", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { spawnSync } = require("node:child_process");
  const { extractLocalArchiveFile } = require("./archiveExtract.cjs");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nc-extract-"));
  const source = path.join(dir, "hello.txt");
  const archive = path.join(dir, "hello.tgz");
  fs.writeFileSync(source, "hello-extract");
  const packed = spawnSync("tar", ["-czf", archive, "-C", dir, "hello.txt"], { encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  fs.unlinkSync(source);

  await extractLocalArchiveFile(archive);
  assert.equal(fs.readFileSync(source, "utf8"), "hello-extract");
  fs.rmSync(dir, { recursive: true, force: true });
});
