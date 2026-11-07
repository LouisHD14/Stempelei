import { crc32 } from 'node:zlib';

/**
 * Minimaler ZIP-Schreiber ohne Kompression (Methode „stored“). Mehr braucht ein .pkpass nicht,
 * die Dateien sind klein. Spart eine Abhängigkeit.
 */
export function zipStored(files: { name: string; data: Buffer }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // lokaler Dateikopf
    header.writeUInt16LE(20, 4); // benötigte Version 2.0
    header.writeUInt16LE(0x0800, 6); // Dateinamen in UTF-8
    header.writeUInt16LE(0, 8); // stored
    header.writeUInt32LE(0, 10); // Zeit und Datum: 1980, egal für Wallet
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(f.data.length, 18);
    header.writeUInt32LE(f.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, name, f.data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); // Eintrag im zentralen Verzeichnis
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt32LE(0, 12);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(f.data.length, 20);
    entry.writeUInt32LE(f.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += header.length + name.length + f.data.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // Ende des zentralen Verzeichnisses
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

/** Liest ein mit zipStored geschriebenes Archiv (für Tests). */
export function unzipStored(zip: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let p = 0;
  while (zip.readUInt32LE(p) === 0x04034b50) {
    const size = zip.readUInt32LE(p + 18);
    const nameLen = zip.readUInt16LE(p + 26);
    const extra = zip.readUInt16LE(p + 28);
    const name = zip.subarray(p + 30, p + 30 + nameLen).toString('utf8');
    const start = p + 30 + nameLen + extra;
    out.set(name, zip.subarray(start, start + size));
    p = start + size;
  }
  return out;
}
