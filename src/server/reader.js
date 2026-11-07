// @ts-check
// Reads a growing JSONL file in pieces: remembers how far it got, keeps a half-written last line for later,
// and never holds more than a few megabytes of raw bytes at once. Files are only ever opened for reading.
import fs from "node:fs/promises";

const NEWLINE = 0x0a;
const CHUNK = 4 * 1024 * 1024; // read 4 MB at a time
const MAX_LINE = 64 * 1024 * 1024; // a single record bigger than this is skipped

export class JsonlTail {
  /** @param {string} file */
  constructor(file, { chunk = CHUNK, maxLine = MAX_LINE } = {}) {
    this.file = file;
    this.chunk = chunk;
    this.maxLine = maxLine;
    this.offset = 0;
    /** @type {Buffer[]} */
    this.pending = [];
    this.pendingBytes = 0;
    this.skipping = false; // inside an over-long line: drop bytes until the next newline
  }

  /**
   * Reads whatever was added since last time.
   * @returns {Promise<{ records: unknown[], reset: boolean }>}
   */
  async read() {
    /** @type {unknown[]} */
    const records = [];
    let reset = false;
    let size;
    try {
      size = (await fs.stat(this.file)).size;
    } catch {
      return { records, reset };
    }
    if (size < this.offset) {
      // The file was shortened or rewritten: start again from the top.
      this.offset = 0;
      this.pending = [];
      this.pendingBytes = 0;
      this.skipping = false;
      reset = true;
    }
    if (size === this.offset) return { records, reset };

    const fh = await fs.open(this.file, "r");
    try {
      while (this.offset < size) {
        const want = Math.min(this.chunk, size - this.offset);
        const buf = Buffer.alloc(want);
        const { bytesRead } = await fh.read(buf, 0, want, this.offset);
        if (bytesRead === 0) break;
        this.offset += bytesRead;
        this.#take(buf.subarray(0, bytesRead), records);
      }
    } finally {
      await fh.close();
    }
    return { records, reset };
  }

  /** @param {Buffer} buf @param {unknown[]} records */
  #take(buf, records) {
    let start = 0;
    while (start < buf.length) {
      const nl = buf.indexOf(NEWLINE, start);
      if (nl === -1) {
        if (!this.skipping) {
          this.pending.push(buf.subarray(start));
          this.pendingBytes += buf.length - start;
          if (this.pendingBytes > this.maxLine) {
            this.pending = [];
            this.pendingBytes = 0;
            this.skipping = true;
          }
        }
        return;
      }
      if (this.skipping) {
        this.skipping = false;
      } else {
        const piece = buf.subarray(start, nl);
        const line = this.pending.length ? Buffer.concat([...this.pending, piece]) : piece;
        this.pending = [];
        this.pendingBytes = 0;
        if (line.length <= this.maxLine) parseLine(line.toString("utf8"), records);
      }
      start = nl + 1;
    }
  }
}

/** @param {string} line @param {unknown[]} records */
function parseLine(line, records) {
  const t = line.trim();
  if (!t) return;
  try {
    records.push(JSON.parse(t));
  } catch {
    // a broken line: skip it, keep the rest
  }
}

/**
 * The first and last `bytes` of a file as text, for quick listing without reading everything.
 * @returns {Promise<{ head: string, tail: string }>}
 */
export async function readHeadTail(file, bytes = 64 * 1024) {
  const fh = await fs.open(file, "r");
  try {
    const { size } = await fh.stat();
    const headLen = Math.min(size, bytes);
    const head = Buffer.alloc(headLen);
    await fh.read(head, 0, headLen, 0);
    let tail = "";
    if (size > bytes) {
      const tailLen = Math.min(size - headLen, bytes);
      const t = Buffer.alloc(tailLen);
      await fh.read(t, 0, tailLen, size - tailLen);
      tail = t.toString("utf8");
    }
    return { head: head.toString("utf8"), tail };
  } finally {
    await fh.close();
  }
}

/** Parses the whole lines in a text slice (the first or last line may be cut, so failures are skipped). */
export function parseLines(text) {
  /** @type {unknown[]} */
  const out = [];
  for (const line of text.split("\n")) parseLine(line, out);
  return out;
}
