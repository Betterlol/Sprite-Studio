import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { crc32, deflateRawSync } from "node:zlib";
import { StudioError } from "./store.ts";

export type ZipEntry = { name: string; source: string };

const MAX_ENTRIES = 65_535;
const MAX_BYTES = 0xffff_ffff;

function writeAll(fd: number, buffer: Buffer) {
  let offset = 0;
  while (offset < buffer.length)
    offset += writeSync(fd, buffer, offset, buffer.length - offset);
}

/** DOS date and time fields used by both ZIP headers. */
function dosStamp(value: Date) {
  const year = Math.max(1980, value.getFullYear());
  return {
    time:
      (value.getHours() << 11) |
      (value.getMinutes() << 5) |
      Math.floor(value.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate(),
  };
}

/**
 * Writes a deterministic ZIP with UTF-8 names, over the existing entries.
 * Node handles long Windows paths, so the archive does not depend on the
 * Python worker's path handling.
 */
export function writeZip(output: string, entries: ZipEntry[]) {
  if (!entries.length) throw new StudioError("导出内容为空");
  if (entries.length > MAX_ENTRIES)
    throw new StudioError("导出文件数量超出 ZIP 上限，请分批导出");
  const seen = new Set<string>();
  for (const entry of entries) {
    const name = entry.name.replaceAll("\\", "/");
    if (!name || name.startsWith("/") || name.split("/").some((part) => part === ".." || part === "." || part === ""))
      throw new StudioError(`无效的导出路径：${entry.name}`);
    if (seen.has(name)) throw new StudioError(`导出路径重复：${name}`);
    seen.add(name);
  }
  const temporary = output + ".part";
  // A crashed earlier attempt must not block the next archive at the same name.
  try {
    unlinkSync(temporary);
  } catch {
    // No leftover partial file.
  }
  const fd = openSync(temporary, "wx");
  let offset = 0;
  const central: Buffer[] = [];
  try {
    for (const entry of entries) {
      const name = Buffer.from(entry.name.replaceAll("\\", "/"), "utf8");
      const data = readFileSync(entry.source);
      if (data.length > MAX_BYTES)
        throw new StudioError(`单个文件超过 4 GB，无法写入 ZIP：${entry.name}`);
      const deflated = deflateRawSync(data, { level: 6 });
      const compressed = deflated.length < data.length;
      const body = compressed ? deflated : data;
      const checksum = crc32(data) >>> 0;
      const { time, date } = dosStamp(statSync(entry.source).mtime);
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x0800, 6);
      header.writeUInt16LE(compressed ? 8 : 0, 8);
      header.writeUInt16LE(time, 10);
      header.writeUInt16LE(date, 12);
      header.writeUInt32LE(checksum, 14);
      header.writeUInt32LE(body.length, 18);
      header.writeUInt32LE(data.length, 22);
      header.writeUInt16LE(name.length, 26);
      header.writeUInt16LE(0, 28);
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE(20, 4);
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(0x0800, 8);
      record.writeUInt16LE(compressed ? 8 : 0, 10);
      record.writeUInt16LE(time, 12);
      record.writeUInt16LE(date, 14);
      record.writeUInt32LE(checksum, 16);
      record.writeUInt32LE(body.length, 20);
      record.writeUInt32LE(data.length, 24);
      record.writeUInt16LE(name.length, 28);
      record.writeUInt16LE(0, 30);
      record.writeUInt16LE(0, 32);
      record.writeUInt16LE(0, 34);
      record.writeUInt16LE(0, 36);
      record.writeUInt32LE(0, 38);
      record.writeUInt32LE(offset, 42);
      writeAll(fd, header);
      writeAll(fd, name);
      writeAll(fd, body);
      central.push(record, name);
      offset += header.length + name.length + body.length;
      if (offset > MAX_BYTES)
        throw new StudioError("导出内容超过 4 GB，请分批导出");
    }
    const directoryStart = offset;
    for (const part of central) {
      writeAll(fd, part);
      offset += part.length;
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(offset - directoryStart, 12);
    end.writeUInt32LE(directoryStart, 16);
    end.writeUInt16LE(0, 20);
    writeAll(fd, end);
    offset += end.length;
    closeSync(fd);
    renameSync(temporary, output);
    return { entries: entries.length, bytes: offset };
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // The descriptor is already closed on the success path.
    }
    try {
      unlinkSync(temporary);
    } catch {
      // A missing partial file needs no cleanup.
    }
    throw error;
  }
}
