/** Reads the text files from a ZIP archive with the browser's own deflate support (no library). */
export async function readZipTextFiles(data: ArrayBuffer, accept: (name: string) => boolean): Promise<{ name: string; text: string }[]> {
  const view = new DataView(data);
  const end = findEndOfCentralDirectory(view);
  if (end < 0) {
    throw new Error('not-a-zip');
  }
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const files: { name: string; text: string }[] = [];
  const decoder = new TextDecoder();

  for (let i = 0; i < count; i++) {
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeader = view.getUint32(offset + 42, true);
    const name = decoder.decode(new Uint8Array(data, offset + 46, nameLength));
    offset += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/') || !accept(name)) {
      continue;
    }
    const start = localHeader + 30 + view.getUint16(localHeader + 26, true) + view.getUint16(localHeader + 28, true);
    const bytes = new Uint8Array(data, start, compressedSize);
    const content = method === 0 ? bytes : await inflate(bytes);
    files.push({ name: name.split('/').pop() ?? name, text: decoder.decode(content) });
  }
  return files;
}

export function isZip(data: ArrayBuffer): boolean {
  const bytes = new Uint8Array(data, 0, Math.min(4, data.byteLength));
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function findEndOfCentralDirectory(view: DataView): number {
  for (let i = view.byteLength - 22; i >= Math.max(0, view.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      return i;
    }
  }
  return -1;
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
