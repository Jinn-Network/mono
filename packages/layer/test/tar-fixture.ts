/**
 * Shared test fixture builders for system_snapshot shapes: a minimal ustar
 * writer mirroring the engine's hand-rolled writer
 * (operator/src/harnesses/engine/packaging.ts — 512-byte headers, regular files
 * only, names ≤100 chars, octal size@124, `ustar` magic@257, checksum@148),
 * plus gzip and the jinn.artifact.donation.v1 wrapper as packaging publishes it.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

export function makeTar(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content, 'utf8');
    const header = Buffer.alloc(512);
    header.write(name, 0, 'utf8');
    header.write('0000644\0', 100, 'utf8'); // mode
    header.write('0000000\0', 108, 'utf8'); // uid
    header.write('0000000\0', 116, 'utf8'); // gid
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 'utf8'); // size
    header.write('00000000000\0', 136, 'utf8'); // mtime
    header.write('        ', 148, 'utf8'); // checksum placeholder (8 spaces)
    header.write('0', 156, 'utf8'); // typeflag: regular file
    header.write('ustar  \0', 257, 'utf8'); // magic
    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8');
    blocks.push(header, body);
    const pad = (512 - (body.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024)); // end-of-archive
  return Buffer.concat(blocks);
}

export function makeTarGz(files: Record<string, string>): Buffer {
  return gzipSync(makeTar(files));
}

export function sha256Hex(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

/** A donation wrapper exactly as packaging.ts publishes it. */
export function wrapDonation(bytes: Buffer): { wrapper: Record<string, unknown>; sha256: string } {
  const sha256 = sha256Hex(bytes);
  return {
    wrapper: {
      schemaVersion: 'jinn.artifact.donation.v1',
      encoding: 'jinn.artifact.donation.v1',
      artifactType: 'system_snapshot',
      sha256,
      data: bytes.toString('base64'),
    },
    sha256,
  };
}
