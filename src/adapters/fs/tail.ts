// Incremental readers for append-only JSON Lines files.
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';

const READ_LIMIT = 16 * 1024 * 1024;
const NEWLINE = 10;

function sizeOf(file: string): number | null {
  try {
    return statSync(file).size;
  } catch {
    return null;
  }
}

/**
 * Follows a file by byte offset and returns its complete new lines, parsed. Each byte is read
 * once; a line still being written is carried to the next read, and a multi-byte character
 * split across reads is never decoded in halves.
 */
export class Tail {
  private position = 0;
  private carried: Buffer | null = null;
  private skipPartialFirstLine = false;

  constructor(readonly file: string) {}

  /** Starts at the end: only what is appended from now on. */
  seekToEnd(): void {
    this.position = sizeOf(this.file) ?? 0;
    this.carried = null;
    this.skipPartialFirstLine = false;
  }

  /** Starts `bytes` before the end, for recent history without reading a large file whole. */
  seekNearEnd(bytes: number): void {
    const size = sizeOf(this.file);

    if (size !== null && size > bytes) {
      this.position = size - bytes;
      this.skipPartialFirstLine = true; // we almost certainly landed inside a line
    }
  }

  /** The values of the lines appended since the last call. Unparsable lines are skipped. */
  read(maxBytes = READ_LIMIT): unknown[] {
    const appended = this.readAppended(maxBytes);

    return appended ? parseLines(this.completeLines(appended)) : [];
  }

  /** The bytes appended since the last call, up to `maxBytes`; null when there are none. */
  private readAppended(maxBytes: number): Buffer | null {
    const size = sizeOf(this.file);

    if (size === null) {
      return null;
    }

    // Truncated or rotated: start over.
    if (size < this.position) {
      this.position = 0;
      this.carried = null;
      this.skipPartialFirstLine = false;
    }

    if (size === this.position) {
      return null;
    }

    const bytes = readAt(this.file, this.position, Math.min(size - this.position, maxBytes));

    this.position += bytes?.length ?? 0;

    return bytes;
  }

  /** The whole lines in what was read. A line still being written waits for the next read. */
  private completeLines(appended: Buffer): string[] {
    const chunk = this.carried ? Buffer.concat([this.carried, appended]) : appended;
    const lastNewline = chunk.lastIndexOf(NEWLINE);

    if (lastNewline < 0) {
      this.carried = Buffer.from(chunk);

      return [];
    }

    const rest = chunk.subarray(lastNewline + 1);
    const lines = chunk.toString('utf8', 0, lastNewline).split('\n');

    this.carried = rest.length > 0 ? Buffer.from(rest) : null;

    if (this.skipPartialFirstLine) {
      lines.shift();
      this.skipPartialFirstLine = false;
    }

    return lines;
  }
}

/** `length` bytes of `file` from `position`, or null when it cannot be read. */
function readAt(file: string, position: number, length: number): Buffer | null {
  const buffer = Buffer.allocUnsafe(length);
  let fd: number | undefined;

  try {
    fd = openSync(file, 'r');

    return buffer.subarray(0, readSync(fd, buffer, 0, length, position));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function parseLines(lines: readonly string[]): unknown[] {
  const values: unknown[] = [];

  for (const line of lines) {
    if (!line) {
      continue;
    }

    try {
      values.push(JSON.parse(line));
    } catch {
      // A torn or foreign line: nothing to report.
    }
  }

  return values;
}

/**
 * Calls `visit` with each line from the end of the file toward its start, until it returns true.
 * Reads 64 KB at a time, so the cost depends on how far back the answer is, not on the file.
 */
export function scanBackwards(
  file: string,
  visit: (line: string) => boolean,
  chunkBytes = 64 * 1024,
): boolean {
  let fd: number | undefined;

  try {
    fd = openSync(file, 'r');

    let position = fstatSync(fd).size;
    let carried = Buffer.alloc(0);

    while (position > 0) {
      const start = Math.max(0, position - chunkBytes);
      const buffer = Buffer.allocUnsafe(position - start);

      readSync(fd, buffer, 0, buffer.length, start);

      const data = carried.length > 0 ? Buffer.concat([buffer, carried]) : buffer;
      let end = data.length;

      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] !== NEWLINE) {
          continue;
        }

        if (end > i + 1 && visit(data.toString('utf8', i + 1, end))) {
          return true;
        }

        end = i;
      }

      carried = Buffer.from(data.subarray(0, end));
      position = start;
    }

    return carried.length > 0 && visit(carried.toString('utf8'));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

/** The first line of a file, parsed. The line can be long: it holds an agent's whole prompt. */
export function firstRecord(file: string, limitBytes = 8 * 1024 * 1024): unknown {
  let fd: number | undefined;

  try {
    fd = openSync(file, 'r');

    const parts: Buffer[] = [];
    let position = 0;

    while (position < limitBytes) {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const bytesRead = readSync(fd, buffer, 0, buffer.length, position);

      if (bytesRead <= 0) {
        break;
      }

      const piece = buffer.subarray(0, bytesRead);
      const newline = piece.indexOf(NEWLINE);

      if (newline >= 0) {
        parts.push(piece.subarray(0, newline));
        break;
      }

      parts.push(piece);
      position += bytesRead;
    }

    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

/**
 * The complete lines within the first `limitBytes` of a file, in order. For what stands at the
 * start of a long file, without reading the rest.
 */
export function firstLines(file: string, limitBytes = 256 * 1024): string[] {
  let fd: number | undefined;

  try {
    fd = openSync(file, 'r');

    const buffer = Buffer.allocUnsafe(Math.min(limitBytes, fstatSync(fd).size));
    const text = buffer.toString('utf8', 0, readSync(fd, buffer, 0, buffer.length, 0));

    // What follows the last line break was cut by the limit, unless the whole file was read.
    return text
      .slice(0, text.lastIndexOf('\n') + 1)
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}
