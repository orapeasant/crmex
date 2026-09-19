// PNG validation and metadata stripping for pasted/attached images
// (crmex.md §18.4). Tests: test-plan.md §21 CAM-15.
//
// Why PNG-only, and why chunk-stripping rather than a re-encode:
//
// buildObjectPath() always yields `<org>/<user>/<sha256>.png`, so the storage
// contract is already PNG. Re-encoding an arbitrary JPEG/WebP into PNG would
// need a decoder (sharp or similar) — a native dependency added to core-server
// for one endpoint. PNG's container format instead makes stripping metadata a
// pure-JS operation that is easy to verify by reading it: the file is a
// sequence of length-tagged chunks, and everything that can carry EXIF, GPS,
// comments or colour-profile text lives in an *ancillary* chunk that a decoder
// is required to be able to ignore. Dropping all of them yields a valid image
// with no metadata, without ever decoding pixels.
//
// Clients convert to PNG before upload (canvas.toBlob in the browser, which
// incidentally drops EXIF too). This function does not trust that: a client can
// still send a PNG with an eXIf chunk, so every upload is stripped server-side.

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Chunks kept. Critical chunks (uppercase first letter) are required to render
 * the image; the three ancillary ones here are kept because dropping them
 * changes how the image *looks* (transparency and colour), not what it reveals:
 *   tRNS — palette transparency
 *   gAMA — gamma
 *   sRGB — colour space marker (a 1-byte enum, unlike iCCP which is a named blob)
 * Everything else is dropped, which is the point: eXIf (EXIF, including GPS),
 * tEXt/zTXt/iTXt (arbitrary text, often camera and software provenance),
 * iCCP (named profile), tIME (last-modified), and any chunk type added later.
 * An allowlist is used rather than a blocklist so an unknown future chunk is
 * dropped by default instead of passed through.
 */
const KEPT_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'sRGB']);

export class InvalidImageError extends Error {
  constructor(reason: string) {
    super(`INVALID_IMAGE: ${reason}`);
    this.name = 'InvalidImageError';
  }
}

/**
 * Validates `bytes` as a PNG and returns a copy containing only the chunks in
 * KEPT_CHUNKS, in their original order. Throws InvalidImageError on anything
 * that is not a structurally valid PNG.
 *
 * This is a structural pass, not a decode: it does not verify that the pixel
 * data is coherent, only that the container is well-formed and carries no
 * metadata. A malformed IDAT stream fails later, in whatever renders it.
 */
export function sanitizePng(bytes: Buffer): Buffer {
  if (bytes.length < PNG_MAGIC.length + 12 || !bytes.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new InvalidImageError('not a PNG');
  }

  const kept: Buffer[] = [PNG_MAGIC];
  let offset = PNG_MAGIC.length;
  let sawIHDR = false;
  let sawIDAT = false;
  let sawIEND = false;

  while (offset < bytes.length) {
    // Each chunk is: length (4) + type (4) + data (length) + CRC (4).
    if (offset + 8 > bytes.length) throw new InvalidImageError('truncated chunk header');
    const length = bytes.readUInt32BE(offset);
    // Guards against a declared length that would overflow the buffer or the
    // PNG spec's own 2^31-1 ceiling — both are how a crafted file tries to walk
    // the reader off the end of the allocation.
    if (length > 0x7fffffff) throw new InvalidImageError('chunk length exceeds PNG maximum');
    const end = offset + 12 + length;
    if (end > bytes.length) throw new InvalidImageError('truncated chunk data');

    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new InvalidImageError('malformed chunk type');

    if (type === 'IHDR') {
      if (sawIHDR) throw new InvalidImageError('duplicate IHDR');
      if (length !== 13) throw new InvalidImageError('malformed IHDR');
      sawIHDR = true;
    } else if (!sawIHDR) {
      throw new InvalidImageError('first chunk is not IHDR');
    }
    if (type === 'IDAT') sawIDAT = true;
    if (type === 'IEND') sawIEND = true;

    if (KEPT_CHUNKS.has(type)) kept.push(bytes.subarray(offset, end));

    offset = end;
    if (sawIEND) break; // trailing bytes after IEND are not part of the image
  }

  if (!sawIHDR || !sawIDAT || !sawIEND) throw new InvalidImageError('missing required chunk');
  return Buffer.concat(kept);
}

/** Dimensions from the IHDR of an already-validated PNG. */
export function pngDimensions(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
