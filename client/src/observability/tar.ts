/**
 * Minimal in-house USTAR (tar) writer + reader for the operator debug-report
 * bundle (issue #420 §2).
 *
 * A support bundle is a handful of small text/JSON files plus one PNG, so a
 * full `tar` dependency is not justified. This implements just enough of the
 * USTAR format — 512-byte header blocks, octal numeric fields, the `ustar`
 * magic, padded file content, and a two-block zero terminator — to write and
 * read regular files. Deterministic and unit-testable; no compression here
 * (the caller pipes the output through `zlib.gzipSync`).
 */

import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);

const BLOCK = 512;

export interface TarFile {
  /** Path within the archive (forward slashes). */
  name: string;
  content: Buffer;
}

/** Write an octal numeric field of `len` bytes, NUL-terminated. */
function octalField(value: number, len: number): Buffer {
  // USTAR numeric fields are `len-1` octal digits followed by a NUL.
  const str = value.toString(8).padStart(len - 1, '0').slice(-(len - 1));
  return Buffer.from(`${str}\0`, 'latin1');
}

/** Build a 512-byte USTAR header block for one regular file. */
function buildHeader(file: TarFile): Buffer {
  const header = Buffer.alloc(BLOCK, 0);
  const nameBuf = Buffer.from(file.name, 'utf8');
  if (nameBuf.length > 100) {
    throw new Error(`tar: file name too long for USTAR (max 100 bytes): ${file.name}`);
  }
  nameBuf.copy(header, 0);
  octalField(0o644, 8).copy(header, 100); // mode
  octalField(0, 8).copy(header, 108); // uid
  octalField(0, 8).copy(header, 116); // gid
  octalField(file.content.length, 12).copy(header, 124); // size
  octalField(0, 12).copy(header, 136); // mtime (deterministic: 0)
  header.write('0', 156, 1, 'latin1'); // typeflag '0' = regular file
  header.write('ustar\0', 257, 6, 'latin1'); // magic
  header.write('00', 263, 2, 'latin1'); // version

  // Checksum: computed with the checksum field filled with spaces.
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += header[i]!;
  // 6 octal digits, NUL, space.
  const chk = sum.toString(8).padStart(6, '0').slice(-6);
  header.write(`${chk}\0 `, 148, 8, 'latin1');
  return header;
}

/** Pad a buffer up to the next 512-byte boundary. */
function pad(buf: Buffer): Buffer {
  const rem = buf.length % BLOCK;
  if (rem === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(BLOCK - rem, 0)]);
}

/** Serialize files into an uncompressed USTAR archive buffer. */
export function writeTar(files: TarFile[]): Buffer {
  const parts: Buffer[] = [];
  for (const file of files) {
    parts.push(buildHeader(file));
    parts.push(pad(file.content));
  }
  // Two zero blocks terminate the archive.
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

/**
 * Serialize files into a gzip-compressed tar (`.tar.gz`) buffer. Async so the
 * gzip pass runs off the main thread on the libuv pool — a worst-case bundle
 * is tens of MiB of logs and `gzipSync` would stall every daemon loop while it
 * compressed.
 */
export async function writeTarGz(files: TarFile[]): Promise<Buffer> {
  return gzipAsync(writeTar(files));
}

/** Parse an octal numeric field, tolerating NUL/space padding. */
function parseOctal(buf: Buffer): number {
  const str = buf.toString('latin1').replace(/[\0 ]/g, '');
  return str.length === 0 ? 0 : parseInt(str, 8);
}

/**
 * Read regular-file entries from an uncompressed USTAR archive. Used in
 * tests to assert bundle contents.
 */
export function readTarEntries(tar: Buffer): TarFile[] {
  const out: TarFile[] = [];
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    // A zero block marks the end of the archive.
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = parseOctal(header.subarray(124, 136));
    offset += BLOCK;
    const content = tar.subarray(offset, offset + size);
    out.push({ name, content: Buffer.from(content) });
    // Advance past the content, rounded up to a block boundary.
    offset += Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}
