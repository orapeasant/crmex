import { crc32 } from 'zlib';
import { describe, expect, it } from 'vitest';
import { InvalidImageError, pngDimensions, sanitizePng } from '../../src/lib/png';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Builds one length-tagged PNG chunk with a real CRC, exactly as libpng would. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData) >>> 0, 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function ihdr(width = 1, height = 1): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8; // bit depth
  data[9] = 6; // color type: RGBA
  data[10] = 0; // compression
  data[11] = 0; // filter
  data[12] = 0; // interlace
  return chunk('IHDR', data);
}

/** A minimal but structurally valid PNG: IHDR, one ancillary chunk of each
 * kind under test, IDAT, IEND — in the order a real encoder would emit them. */
function buildPng(opts: { extraAncillary?: Array<[string, Buffer]>; extraKept?: Array<[string, Buffer]> } = {}): Buffer {
  const parts = [PNG_MAGIC, ihdr()];
  for (const [type, data] of opts.extraAncillary ?? []) parts.push(chunk(type, data));
  for (const [type, data] of opts.extraKept ?? []) parts.push(chunk(type, data));
  parts.push(chunk('IDAT', Buffer.from([0x00, 0x01, 0x02])));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/** Splits a built PNG back into its chunk type sequence, for order assertions. */
function chunkTypes(bytes: Buffer): string[] {
  const types: string[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    types.push(bytes.toString('ascii', offset + 4, offset + 8));
    offset += 12 + length;
  }
  return types;
}

describe('lib/png sanitizePng', () => {
  it('CAM-15: round-trips a valid PNG with no ancillary metadata unchanged in structure', () => {
    const png = buildPng();
    const sanitized = sanitizePng(png);
    expect(chunkTypes(sanitized)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(pngDimensions(sanitized)).toEqual({ width: 1, height: 1 });
  });

  it('CAM-15: drops eXIf (including GPS-bearing payloads), tEXt, iCCP and tIME', () => {
    const gpsExif = Buffer.from('Exif\0\0GPS 37.7749 N, 122.4194 W', 'utf8');
    const png = buildPng({
      extraAncillary: [
        ['eXIf', gpsExif],
        ['tEXt', Buffer.from('Software\0MySpyware 1.0', 'utf8')],
        ['iCCP', Buffer.from('some named profile', 'utf8')],
        ['tIME', Buffer.from([0x07, 0xea, 0x01, 0x01, 0x00, 0x00, 0x00])],
        ['zTXt', Buffer.from('compressed text', 'utf8')],
        ['iTXt', Buffer.from('international text', 'utf8')],
      ],
    });

    const sanitized = sanitizePng(png);

    expect(chunkTypes(sanitized)).toEqual(['IHDR', 'IDAT', 'IEND']);
    // The GPS/EXIF bytes must not survive anywhere in the output, not just be relabeled.
    expect(sanitized.includes(gpsExif)).toBe(false);
    expect(sanitized.toString('latin1')).not.toContain('GPS');
    expect(sanitized.toString('latin1')).not.toContain('MySpyware');
  });

  it('keeps critical chunks and the allowlisted ancillary ones (tRNS, gAMA, sRGB), in original order', () => {
    const png = buildPng({ extraKept: [['gAMA', Buffer.from([0, 0, 0, 1])], ['sRGB', Buffer.from([0])], ['tRNS', Buffer.from([255])]] });

    const sanitized = sanitizePng(png);

    expect(chunkTypes(sanitized)).toEqual(['IHDR', 'gAMA', 'sRGB', 'tRNS', 'IDAT', 'IEND']);
  });

  it('drops an unknown future ancillary chunk type by default (allowlist, not a blocklist)', () => {
    const png = buildPng({ extraAncillary: [['zzZz', Buffer.from('mystery future chunk')]] });
    expect(chunkTypes(sanitizePng(png))).toEqual(['IHDR', 'IDAT', 'IEND']);
  });

  it('rejects a non-PNG (e.g. a JPEG) body', () => {
    // JPEG magic bytes (FFD8FF), not the PNG signature.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    expect(() => sanitizePng(jpeg)).toThrow(InvalidImageError);
  });

  it('rejects a truncated chunk (declared length runs past the buffer)', () => {
    const png = buildPng();
    const truncated = png.subarray(0, png.length - 6); // cut into IEND's CRC/tail
    expect(() => sanitizePng(truncated)).toThrow(InvalidImageError);
  });

  it('rejects a declared chunk length that exceeds the PNG maximum', () => {
    const badLength = Buffer.alloc(4);
    badLength.writeUInt32BE(0x80000000, 0); // > 2^31-1
    const bogus = Buffer.concat([PNG_MAGIC, badLength, Buffer.from('IHDR'), Buffer.alloc(4)]);
    expect(() => sanitizePng(bogus)).toThrow(InvalidImageError);
  });

  it('rejects a malformed (non-alphabetic) chunk type', () => {
    const data = Buffer.alloc(13);
    const badType = Buffer.concat([Buffer.alloc(4), Buffer.from([0x00, 0x01, 0x02, 0x03]), data, Buffer.alloc(4)]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(13, 0);
    const bogus = Buffer.concat([PNG_MAGIC, length, Buffer.from([0x00, 0x01, 0x02, 0x03]), data, Buffer.alloc(4)]);
    expect(() => sanitizePng(bogus)).toThrow(InvalidImageError);
  });

  it('rejects a PNG missing IDAT or IEND', () => {
    const noIdat = Buffer.concat([PNG_MAGIC, ihdr(), chunk('IEND', Buffer.alloc(0))]);
    expect(() => sanitizePng(noIdat)).toThrow(InvalidImageError);

    const noIend = Buffer.concat([PNG_MAGIC, ihdr(), chunk('IDAT', Buffer.from([0]))]);
    expect(() => sanitizePng(noIend)).toThrow(InvalidImageError);
  });

  it('rejects a chunk stream that does not start with IHDR', () => {
    const notIhdrFirst = Buffer.concat([PNG_MAGIC, chunk('IDAT', Buffer.from([0])), chunk('IEND', Buffer.alloc(0))]);
    expect(() => sanitizePng(notIhdrFirst)).toThrow(InvalidImageError);
  });

  it('rejects an empty/too-short buffer', () => {
    expect(() => sanitizePng(Buffer.alloc(0))).toThrow(InvalidImageError);
    expect(() => sanitizePng(PNG_MAGIC)).toThrow(InvalidImageError);
  });
});
