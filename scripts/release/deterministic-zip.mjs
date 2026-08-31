import { createHash } from 'node:crypto';
import { closeSync, createReadStream, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, relative } from 'node:path';

import {
  assertSafeRelativePath,
  ensureRegularFile,
  sha256File,
} from './release-tooling-common.mjs';

const LOCAL_FILE_HEADER = 0x04034b50;
const DATA_DESCRIPTOR = 0x08074b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const UTF8_AND_DATA_DESCRIPTOR_FLAGS = 0x0808;
const STORED_METHOD = 0;
const DOS_TIME = 0;
const DOS_DATE = 0x0021;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;
const DEFAULT_MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 50_000;

const CRC32_TABLE = createCrc32Table();

export async function writeDeterministicZip({ sourceDirectory, outputPath, archiveRoot }) {
  assertSafeRelativePath(archiveRoot, 'archive root');
  if (archiveRoot.includes('/')) throw new Error('archive root must be a single directory name.');
  const sourceFiles = listRegularFiles(sourceDirectory);
  if (sourceFiles.length === 0) throw new Error('archive source directory is empty.');
  if (sourceFiles.length > MAX_UINT16) throw new Error('archive exceeds the ZIP entry limit.');

  const output = await open(outputPath, 'wx', 0o600);
  let offset = 0;
  const centralEntries = [];
  try {
    for (const source of sourceFiles) {
      const archivePath = `${archiveRoot}/${source.relativePath}`;
      assertSafeRelativePath(archivePath, 'archive entry');
      const name = Buffer.from(archivePath, 'utf8');
      if (name.length > MAX_UINT16)
        throw new Error(`archive entry name is too long: ${archivePath}`);
      if (source.bytes > MAX_UINT32) throw new Error(`archive entry is too large: ${archivePath}`);

      const localOffset = offset;
      const localHeader = Buffer.alloc(30);
      localHeader.writeUInt32LE(LOCAL_FILE_HEADER, 0);
      localHeader.writeUInt16LE(20, 4);
      localHeader.writeUInt16LE(UTF8_AND_DATA_DESCRIPTOR_FLAGS, 6);
      localHeader.writeUInt16LE(STORED_METHOD, 8);
      localHeader.writeUInt16LE(DOS_TIME, 10);
      localHeader.writeUInt16LE(DOS_DATE, 12);
      localHeader.writeUInt16LE(name.length, 26);
      await output.write(localHeader, 0, localHeader.length, offset);
      offset += localHeader.length;
      await output.write(name, 0, name.length, offset);
      offset += name.length;

      let crc32 = 0xffffffff;
      let written = 0;
      for await (const chunk of createReadStream(source.absolutePath)) {
        crc32 = updateCrc32(crc32, chunk);
        await output.write(chunk, 0, chunk.length, offset);
        offset += chunk.length;
        written += chunk.length;
      }
      if (written !== source.bytes)
        throw new Error(`source changed while archiving: ${source.relativePath}`);
      crc32 = (crc32 ^ 0xffffffff) >>> 0;

      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(DATA_DESCRIPTOR, 0);
      descriptor.writeUInt32LE(crc32, 4);
      descriptor.writeUInt32LE(written, 8);
      descriptor.writeUInt32LE(written, 12);
      await output.write(descriptor, 0, descriptor.length, offset);
      offset += descriptor.length;
      centralEntries.push({
        archivePath,
        name,
        mode: source.mode,
        bytes: written,
        crc32,
        localOffset,
      });
    }

    const centralOffset = offset;
    for (const entry of centralEntries) {
      if (entry.localOffset > MAX_UINT32)
        throw new Error('archive requires unsupported ZIP64 offsets.');
      const header = Buffer.alloc(46);
      header.writeUInt32LE(CENTRAL_DIRECTORY_HEADER, 0);
      header.writeUInt16LE(0x0314, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(UTF8_AND_DATA_DESCRIPTOR_FLAGS, 8);
      header.writeUInt16LE(STORED_METHOD, 10);
      header.writeUInt16LE(DOS_TIME, 12);
      header.writeUInt16LE(DOS_DATE, 14);
      header.writeUInt32LE(entry.crc32, 16);
      header.writeUInt32LE(entry.bytes, 20);
      header.writeUInt32LE(entry.bytes, 24);
      header.writeUInt16LE(entry.name.length, 28);
      header.writeUInt32LE((((0o100000 | entry.mode) & 0xffff) * 0x10000) >>> 0, 38);
      header.writeUInt32LE(entry.localOffset, 42);
      await output.write(header, 0, header.length, offset);
      offset += header.length;
      await output.write(entry.name, 0, entry.name.length, offset);
      offset += entry.name.length;
    }
    const centralBytes = offset - centralOffset;
    if (centralOffset > MAX_UINT32 || centralBytes > MAX_UINT32 || offset > MAX_UINT32) {
      throw new Error('archive requires unsupported ZIP64 metadata.');
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
    end.writeUInt16LE(centralEntries.length, 8);
    end.writeUInt16LE(centralEntries.length, 10);
    end.writeUInt32LE(centralBytes, 12);
    end.writeUInt32LE(centralOffset, 16);
    await output.write(end, 0, end.length, offset);
    offset += end.length;
    await output.sync();
  } finally {
    await output.close();
  }
  const digest = await sha256File(outputPath);
  return { ...digest, entries: centralEntries.length };
}

export async function verifyDeterministicZip(
  archivePath,
  {
    selectedEntries = [],
    maxArchiveBytes = DEFAULT_MAX_ARCHIVE_BYTES,
    maxExpandedBytes = DEFAULT_MAX_EXPANDED_BYTES,
    maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES,
    maxEntries = DEFAULT_MAX_ENTRIES,
  } = {}
) {
  const archiveMetadata = ensureRegularFile(archivePath, 'archive');
  if (archiveMetadata.size > maxArchiveBytes) throw new Error('archive exceeds the byte limit.');
  const descriptor = openSync(archivePath, 'r');
  try {
    const end = findEndOfCentralDirectory(descriptor, archiveMetadata.size);
    if (end.diskNumber !== 0 || end.centralDisk !== 0 || end.entriesOnDisk !== end.entries) {
      throw new Error('multi-disk ZIP archives are not supported.');
    }
    if (end.entries === 0 || end.entries > maxEntries)
      throw new Error('archive entry count is invalid.');
    if (end.centralOffset + end.centralBytes > end.offset) {
      throw new Error('central directory overlaps the end record.');
    }
    const central = readExactly(descriptor, end.centralBytes, end.centralOffset);
    const entries = parseCentralDirectory(central, end.entries);
    const selected = new Set(selectedEntries);
    const selectedBytes = new Map();
    const seen = new Set();
    const ranges = [];
    let expandedBytes = 0;
    let previousPath = '';
    for (const entry of entries) {
      assertSafeRelativePath(entry.path, 'archive entry');
      if (seen.has(entry.path)) throw new Error(`duplicate archive entry: ${entry.path}`);
      seen.add(entry.path);
      if (previousPath && previousPath.localeCompare(entry.path) >= 0) {
        throw new Error('archive entries are not strictly sorted.');
      }
      previousPath = entry.path;
      if (entry.flags !== UTF8_AND_DATA_DESCRIPTOR_FLAGS || entry.method !== STORED_METHOD) {
        throw new Error(`archive entry ${entry.path} uses unsupported ZIP flags or compression.`);
      }
      if (entry.bytes !== entry.compressedBytes || entry.bytes > maxEntryBytes) {
        throw new Error(`archive entry ${entry.path} has an invalid size.`);
      }
      expandedBytes += entry.bytes;
      if (expandedBytes > maxExpandedBytes)
        throw new Error('archive exceeds the expanded byte limit.');
      const fileType = entry.mode & 0o170000;
      if (fileType !== 0o100000)
        throw new Error(`archive entry ${entry.path} is not a regular file.`);
      const local = parseLocalHeader(descriptor, entry.localOffset);
      if (
        local.path !== entry.path ||
        local.flags !== entry.flags ||
        local.method !== entry.method
      ) {
        throw new Error(`archive local header disagrees for ${entry.path}.`);
      }
      const dataStart = local.dataStart;
      const dataEnd = dataStart + entry.bytes;
      const descriptorEnd = dataEnd + 16;
      if (descriptorEnd > end.centralOffset)
        throw new Error(`archive entry ${entry.path} overlaps metadata.`);
      ranges.push({ start: entry.localOffset, end: descriptorEnd, path: entry.path });
      const digest = await digestRange(
        archivePath,
        dataStart,
        entry.bytes,
        selected.has(entry.path)
      );
      if (digest.crc32 !== entry.crc32) throw new Error(`CRC mismatch for ${entry.path}.`);
      const dataDescriptor = readExactly(descriptor, 16, dataEnd);
      if (
        dataDescriptor.readUInt32LE(0) !== DATA_DESCRIPTOR ||
        dataDescriptor.readUInt32LE(4) !== entry.crc32 ||
        dataDescriptor.readUInt32LE(8) !== entry.bytes ||
        dataDescriptor.readUInt32LE(12) !== entry.bytes
      ) {
        throw new Error(`invalid data descriptor for ${entry.path}.`);
      }
      entry.sha256 = digest.sha256;
      if (digest.bytes) selectedBytes.set(entry.path, digest.bytes);
    }
    ranges.sort((left, right) => left.start - right.start);
    if (ranges[0]?.start !== 0) throw new Error('archive contains bytes before its first entry.');
    for (let index = 1; index < ranges.length; index += 1) {
      if (ranges[index - 1].end !== ranges[index].start) {
        throw new Error(`archive entries overlap or contain gaps near ${ranges[index].path}.`);
      }
    }
    if (ranges.at(-1)?.end !== end.centralOffset) {
      throw new Error('archive contains unreferenced bytes before its central directory.');
    }
    for (const path of selected) {
      if (!selectedBytes.has(path)) throw new Error(`required archive entry is missing: ${path}`);
    }
    const archiveDigest = await sha256File(archivePath);
    return {
      ...archiveDigest,
      entries,
      selectedBytes,
      expandedBytes,
    };
  } finally {
    closeSync(descriptor);
  }
}

function listRegularFiles(root) {
  const output = [];
  const visit = directory => {
    for (const name of readdirSync(directory).sort()) {
      const absolutePath = join(directory, name);
      const metadata = lstatSync(absolutePath);
      if (metadata.isSymbolicLink()) throw new Error(`archive source contains a symlink: ${name}`);
      if (metadata.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!metadata.isFile()) throw new Error(`archive source contains a non-file entry: ${name}`);
      const relativePath = relative(root, absolutePath).split('\\').join('/');
      assertSafeRelativePath(relativePath, 'archive source path');
      output.push({
        absolutePath,
        relativePath,
        bytes: metadata.size,
        mode: metadata.mode & 0o111 ? 0o755 : 0o644,
      });
    }
  };
  visit(root);
  return output.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function findEndOfCentralDirectory(descriptor, archiveBytes) {
  if (archiveBytes < 22) throw new Error('archive is too small to be a ZIP file.');
  const tailBytes = Math.min(archiveBytes, 22 + MAX_UINT16);
  const tailOffset = archiveBytes - tailBytes;
  const tail = readExactly(descriptor, tailBytes, tailOffset);
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY) continue;
    const commentBytes = tail.readUInt16LE(offset + 20);
    if (offset + 22 + commentBytes !== tail.length) continue;
    if (commentBytes !== 0) throw new Error('archive comments are not supported.');
    return {
      offset: tailOffset + offset,
      diskNumber: tail.readUInt16LE(offset + 4),
      centralDisk: tail.readUInt16LE(offset + 6),
      entriesOnDisk: tail.readUInt16LE(offset + 8),
      entries: tail.readUInt16LE(offset + 10),
      centralBytes: tail.readUInt32LE(offset + 12),
      centralOffset: tail.readUInt32LE(offset + 16),
    };
  }
  throw new Error('ZIP end record was not found.');
}

function parseCentralDirectory(bytes, expectedEntries) {
  const entries = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== CENTRAL_DIRECTORY_HEADER) {
      throw new Error('central directory is malformed.');
    }
    const nameBytes = bytes.readUInt16LE(offset + 28);
    const extraBytes = bytes.readUInt16LE(offset + 30);
    const commentBytes = bytes.readUInt16LE(offset + 32);
    const end = offset + 46 + nameBytes + extraBytes + commentBytes;
    if (end > bytes.length || extraBytes !== 0 || commentBytes !== 0) {
      throw new Error('central directory contains unsupported metadata.');
    }
    entries.push({
      path: bytes.subarray(offset + 46, offset + 46 + nameBytes).toString('utf8'),
      flags: bytes.readUInt16LE(offset + 8),
      method: bytes.readUInt16LE(offset + 10),
      crc32: bytes.readUInt32LE(offset + 16),
      compressedBytes: bytes.readUInt32LE(offset + 20),
      bytes: bytes.readUInt32LE(offset + 24),
      mode: bytes.readUInt32LE(offset + 38) >>> 16,
      localOffset: bytes.readUInt32LE(offset + 42),
    });
    offset = end;
  }
  if (entries.length !== expectedEntries) throw new Error('central directory entry count drifted.');
  return entries;
}

function parseLocalHeader(descriptor, offset) {
  const header = readExactly(descriptor, 30, offset);
  if (header.readUInt32LE(0) !== LOCAL_FILE_HEADER)
    throw new Error('local ZIP header is malformed.');
  const nameBytes = header.readUInt16LE(26);
  const extraBytes = header.readUInt16LE(28);
  if (extraBytes !== 0) throw new Error('local ZIP extras are not supported.');
  const name = readExactly(descriptor, nameBytes, offset + 30).toString('utf8');
  return {
    path: name,
    flags: header.readUInt16LE(6),
    method: header.readUInt16LE(8),
    dataStart: offset + 30 + nameBytes,
  };
}

function readExactly(descriptor, bytes, position) {
  const output = Buffer.alloc(bytes);
  let read = 0;
  while (read < bytes) {
    const count = readSync(descriptor, output, read, bytes - read, position + read);
    if (count === 0) throw new Error('archive ended unexpectedly.');
    read += count;
  }
  return output;
}

async function digestRange(path, start, bytes, capture) {
  const hash = createHash('sha256');
  let crc32 = 0xffffffff;
  let observed = 0;
  const chunks = [];
  if (bytes > 0) {
    for await (const chunk of createReadStream(path, { start, end: start + bytes - 1 })) {
      observed += chunk.length;
      hash.update(chunk);
      crc32 = updateCrc32(crc32, chunk);
      if (capture) chunks.push(chunk);
    }
  }
  if (observed !== bytes) throw new Error('archive entry ended unexpectedly.');
  return {
    sha256: hash.digest('hex'),
    crc32: (crc32 ^ 0xffffffff) >>> 0,
    bytes: capture ? Buffer.concat(chunks) : undefined,
  };
}

function createCrc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function updateCrc32(crc32, bytes) {
  let value = crc32;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}
