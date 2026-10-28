import { statSync } from "node:fs";
import { deserialize } from "node:v8";
import { readRegularFile } from "@openclaw/fs-safe/advanced";
import { isPathInside, safeRealpathSync } from "@openclaw/fs-safe/path";
import { resolveStateDir } from "../../../config/state-dir.js";
import { openLocalFileSafely } from "../../../infra/fs-safe.js";
import { resolveRuntimeProcessEntrypointUrl } from "../../../infra/runtime-process-url.js";
import { resolveRuntimeWorkerArgv } from "../../../infra/runtime-worker-url.js";
import { isSqliteFilePath } from "../../../infra/sqlite-file-path.js";
import {
  resolveCommandProcessSignal,
  withCommandProcessScope,
} from "../../../process/exec-spawn.js";
import { runCommandBuffered } from "../../../process/exec.js";
import { getSpawnBroker } from "../../../process/spawn-broker/context.js";
import { withChildProcessOperation } from "../../../process/spawn-diagnostics.js";
import type { FileReadResult } from "./read-file.worker.js";

function requiresIsolatedRead(filePath: string): boolean {
  const stateDir = resolveStateDir();
  if (isSqliteFilePath(filePath) || isPathInside(stateDir, filePath)) {
    return true;
  }
  const realPath = safeRealpathSync(filePath);
  // Metadata probes never close SQLite descriptors; aliases and hardlinks can hide database names.
  return (
    !realPath ||
    isSqliteFilePath(realPath) ||
    isPathInside(safeRealpathSync(stateDir) ?? stateDir, realPath) ||
    statSync(realPath, { throwIfNoEntry: false })?.nlink !== 1
  );
}

export async function readLocalFile(filePath: string, signal?: AbortSignal): Promise<Buffer> {
  if (!requiresIsolatedRead(filePath)) {
    return (await readRegularFile({ filePath })).buffer;
  }
  // Closing a raw descriptor in any Gateway thread drops SQLite's POSIX locks on that inode.
  const broker = getSpawnBroker();
  if (broker) {
    return await broker.readFile(filePath, resolveCommandProcessSignal(signal));
  }
  // Standalone CLI callers have no Gateway broker to retain a separate-process reader.
  return await withCommandProcessScope(async () => {
    const result = await withChildProcessOperation("agent.file-read", () =>
      runCommandBuffered(
        [
          process.execPath,
          ...resolveRuntimeWorkerArgv(resolveRuntimeProcessEntrypointUrl("fileToolRead")),
          filePath,
        ],
        {
          input: "",
          signal,
          // Preserve fs.readFile's byte limit, including the serialized result envelope.
          maxOutputBytes: { stdout: Number.MAX_SAFE_INTEGER, stderr: 64 * 1024 },
        },
      ),
    );
    if (result.code !== 0 || result.termination !== "exit") {
      throw result.error ?? new Error(`File read failed: ${result.termination}`);
    }
    // SAFETY: The private child serializes only the read result after closing its descriptor.
    const reply = deserialize(result.stdout) as FileReadResult;
    if ("error" in reply) {
      throw Object.assign(reply.error, { code: reply.code });
    }
    return reply.buffer;
  }, signal);
}

/** Bounded local snapshot the read tool pages from. */
export type LocalFileSource = {
  buffer: Buffer;
  /** True when the file is larger than the byte limit and only its prefix was read. */
  truncated: boolean;
  /** On-disk size observed when the source was opened. */
  size: number;
};

/**
 * Reads the prefix of a local file that one read call can show. Isolated
 * readers (SQLite and state-directory files) keep their existing path: their
 * bytes belong to the database owner, not to a text preview.
 */
export async function readLocalFileSource(
  filePath: string,
  signal: AbortSignal | undefined,
  maxBytes: number,
): Promise<LocalFileSource> {
  if (requiresIsolatedRead(filePath)) {
    return { buffer: await readLocalFile(filePath, signal), truncated: false, size: 0 };
  }
  const opened = await openLocalFileSafely({ filePath });
  try {
    const size = opened.stat.size;
    const limit = Math.min(size, maxBytes);
    const buffer = Buffer.allocUnsafe(limit);
    let total = 0;
    while (total < limit) {
      const { bytesRead } = await opened.handle.read(buffer, total, limit - total, total);
      if (bytesRead === 0) {
        break;
      }
      total += bytesRead;
    }
    return { buffer: buffer.subarray(0, total), truncated: size > limit, size };
  } finally {
    await opened[Symbol.asyncDispose]();
  }
}
