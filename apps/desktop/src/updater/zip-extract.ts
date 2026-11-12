import { createReadStream, createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";

export interface ZipCentralDirectoryEntry {
  fileName: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CEN_SIGNATURE = 0x02014b50;
const LOC_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH = 65_557;

export async function listZipEntries(zipPath: string): Promise<ZipCentralDirectoryEntry[]> {
  const handle = await open(zipPath, "r");
  try {
    const { size: fileSize } = await handle.stat();
    if (fileSize < 22) throw new Error("Invalid ZIP archive: file too small");
    const tailLength = Math.min(fileSize, MAX_EOCD_SEARCH);
    const tail = Buffer.allocUnsafe(tailLength);
    await handle.read(tail, 0, tailLength, fileSize - tailLength);

    let eocdOffset = -1;
    for (let cursor = tailLength - 22; cursor >= 0; cursor -= 1) {
      if (tail.readUInt32LE(cursor) === EOCD_SIGNATURE) {
        eocdOffset = cursor;
        break;
      }
    }
    if (eocdOffset < 0) throw new Error("Invalid ZIP archive: End of Central Directory not found");

    const entryCount = tail.readUInt16LE(eocdOffset + 10);
    const cdSize = tail.readUInt32LE(eocdOffset + 12);
    const cdOffset = tail.readUInt32LE(eocdOffset + 16);
    if (cdOffset + cdSize > fileSize) {
      throw new Error("Invalid ZIP archive: Central Directory out of bounds");
    }

    const cdBuffer = Buffer.allocUnsafe(cdSize);
    await handle.read(cdBuffer, 0, cdSize, cdOffset);

    const entries: ZipCentralDirectoryEntry[] = [];
    let offset = 0;
    for (let index = 0; index < entryCount && offset + 46 <= cdSize; index += 1) {
      if (cdBuffer.readUInt32LE(offset) !== CEN_SIGNATURE) {
        throw new Error("Invalid ZIP archive: bad Central Directory entry signature");
      }
      const compressionMethod = cdBuffer.readUInt16LE(offset + 10);
      const compressedSize = cdBuffer.readUInt32LE(offset + 20);
      const uncompressedSize = cdBuffer.readUInt32LE(offset + 24);
      const nameLength = cdBuffer.readUInt16LE(offset + 28);
      const extraLength = cdBuffer.readUInt16LE(offset + 30);
      const commentLength = cdBuffer.readUInt16LE(offset + 32);
      const localHeaderOffset = cdBuffer.readUInt32LE(offset + 42);
      const nameEnd = offset + 46 + nameLength;
      if (nameEnd > cdSize) throw new Error("Invalid ZIP archive: truncated entry filename");
      const fileName = cdBuffer.subarray(offset + 46, nameEnd).toString("utf8");
      entries.push({
        fileName,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
      offset = nameEnd + extraLength + commentLength;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

export async function extractZipEntryToFile(
  zipPath: string,
  predicate: (entry: ZipCentralDirectoryEntry) => boolean,
  destinationPath: string,
): Promise<{ entryName: string; bytesWritten: number }> {
  const entries = await listZipEntries(zipPath);
  const entry = entries.find((candidate) => (
    !candidate.fileName.endsWith("/")
    && basename(candidate.fileName) === candidate.fileName.split("/").pop()
    && !candidate.fileName.includes("..")
    && predicate(candidate)
  ));
  if (!entry) {
    throw new Error("Target installer entry not found inside release ZIP archive");
  }
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw new Error(`Unsupported ZIP compression method: ${entry.compressionMethod}`);
  }

  const handle = await open(zipPath, "r");
  let dataStart = 0;
  try {
    const localHeader = Buffer.allocUnsafe(30);
    await handle.read(localHeader, 0, 30, entry.localHeaderOffset);
    if (localHeader.readUInt32LE(0) !== LOC_SIGNATURE) {
      throw new Error("Invalid ZIP archive: bad Local File Header signature");
    }
    const localNameLength = localHeader.readUInt16LE(26);
    const localExtraLength = localHeader.readUInt16LE(28);
    dataStart = entry.localHeaderOffset + 30 + localNameLength + localExtraLength;
  } finally {
    await handle.close();
  }

  if (entry.compressedSize === 0) {
    if (entry.uncompressedSize !== 0) {
      throw new Error("Corrupted ZIP entry: zero compressed size for non-empty file");
    }
    const emptyOut = createWriteStream(destinationPath, { mode: 0o700 });
    emptyOut.end();
    await new Promise<void>((resolve, reject) => {
      emptyOut.once("finish", resolve);
      emptyOut.once("error", reject);
    });
    return { entryName: basename(entry.fileName), bytesWritten: 0 };
  }

  const source = createReadStream(zipPath, {
    start: dataStart,
    end: dataStart + entry.compressedSize - 1,
  });
  const destination = createWriteStream(destinationPath, { mode: 0o700 });
  if (entry.compressionMethod === 8) {
    await pipeline(source, createInflateRaw(), destination);
  } else {
    await pipeline(source, destination);
  }
  if (destination.bytesWritten !== entry.uncompressedSize) {
    throw new Error(
      `Extracted size mismatch for ${entry.fileName}: expected ${entry.uncompressedSize}, got ${destination.bytesWritten}`,
    );
  }
  return { entryName: basename(entry.fileName), bytesWritten: destination.bytesWritten };
}
