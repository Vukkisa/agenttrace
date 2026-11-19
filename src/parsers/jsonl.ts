import fs from 'node:fs';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

export interface JsonlLine {
  lineNo: number;
  value?: unknown;
  /** Set when the line was not valid JSON. */
  malformed?: boolean;
}

/** True if this Node.js build ships zstd support in zlib (Node >= 22.15 / 23.8). */
export function zstdSupported(): boolean {
  return typeof (zlib as unknown as { createZstdDecompress?: unknown }).createZstdDecompress === 'function';
}

function openStream(file: string): Readable {
  // Read-only: files are only ever opened with flag 'r'.
  const raw = fs.createReadStream(file, { flags: 'r' });
  if (file.endsWith('.zst')) {
    if (!zstdSupported()) throw new Error('zstd decompression requires Node.js >= 22.15');
    const z = (zlib as unknown as { createZstdDecompress: () => NodeJS.ReadWriteStream }).createZstdDecompress();
    return raw.pipe(z) as unknown as Readable;
  }
  return raw;
}

/**
 * Stream a JSONL file line by line. Never throws on malformed lines; reports them.
 * Memory use is bounded by the longest line, so large logs are fine.
 */
export async function* readJsonl(file: string): AsyncGenerator<JsonlLine> {
  const rl = readline.createInterface({ input: openStream(file), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield { lineNo, value: JSON.parse(trimmed) };
    } catch {
      yield { lineNo, malformed: true };
    }
  }
}

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function parseTime(v: unknown): Date | undefined {
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return undefined;
}

export function inc(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}
