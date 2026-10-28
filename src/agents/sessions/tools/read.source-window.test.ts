import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { READ_SOURCE_MAX_BYTES } from "./limits.js";
import { readLocalFileSource } from "./read-file.js";
import { createReadToolDefinition } from "./read.js";
import { formatSize } from "./truncate.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function writeTempFile(name: string, content: string) {
  const dir = tempDirs.make("openclaw-read-source-window-");
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, content);
  return filePath;
}

function executeRead(
  tool: ReturnType<typeof createReadToolDefinition>,
  args: Parameters<typeof tool.execute>[1],
) {
  return tool.execute("read", args, undefined, undefined, undefined as never);
}

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

function truncatedTool(content: Buffer, size: number, mimeType?: string) {
  return createReadToolDefinition("/workspace", {
    operations: {
      access: async () => {},
      readFile: async () => Buffer.from(content),
      readSource: async () => ({ buffer: Buffer.from(content), truncated: true, size }),
      ...(mimeType ? { detectImageMimeType: async () => mimeType } : {}),
    },
  });
}

describe("read source window", () => {
  it("reads a file below the limit in full", async () => {
    const filePath = await writeTempFile("small.txt", "one\ntwo\nthree\n");
    const source = await readLocalFileSource(filePath, undefined, READ_SOURCE_MAX_BYTES);
    expect(source.truncated).toBe(false);
    expect(source.size).toBe(14);
    expect(source.buffer.toString("utf8")).toBe("one\ntwo\nthree\n");
  });

  it("materializes only the requested prefix of a larger file", async () => {
    const body = "0123456789\n".repeat(20);
    const filePath = await writeTempFile("large.txt", body);
    const source = await readLocalFileSource(filePath, undefined, 33);
    expect(source.truncated).toBe(true);
    expect(source.size).toBe(Buffer.byteLength(body));
    expect(source.buffer.length).toBe(33);
    expect(source.buffer.toString("utf8")).toBe(body.slice(0, 33));
  });

  it("labels a truncated source and keeps whole lines", async () => {
    const size = 60 * 1024 * 1024;
    const tool = truncatedTool(Buffer.from("alpha\nbeta\npartial line"), size);
    const result = await executeRead(tool, { path: "/workspace/big.log" });
    const text = textContent(result);
    expect(text).toContain(
      `File is ${formatSize(size)}; read shows at most its first ${formatSize(READ_SOURCE_MAX_BYTES)}.`,
    );
    expect(text).toContain("alpha\nbeta");
    expect(text).not.toContain("partial line");
  });

  it("reports an offset beyond the read window instead of the file end", async () => {
    const size = 60 * 1024 * 1024;
    const tool = truncatedTool(Buffer.from("alpha\nbeta\n"), size);
    const result = await executeRead(tool, { path: "/workspace/big.log", offset: 3 });
    const text = textContent(result);
    expect(text).toContain(
      `Offset 3 is beyond the ${formatSize(READ_SOURCE_MAX_BYTES)} read window`,
    );
    expect(text).toContain("Use exec");
    expect(text).not.toContain("beyond end of file");
  });

  it("does not attach a partial image from a truncated source", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      "base64",
    );
    const tool = truncatedTool(png, 40 * 1024 * 1024, "image/png");
    const result = await executeRead(tool, { path: "/workspace/photo.png" });
    expect(result.content.some((part) => part.type === "image")).toBe(false);
    expect(textContent(result)).toContain("the image was not attached");
  });
});
