import zlib from 'zlib'

// CRC-32 lookup table (standard ZIP polynomial 0xEDB88320)
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[i] = c
  }
  return t
})()

function crc32(data: Buffer): number {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[((crc ^ data[i]!) & 0xFF)!]! ^ (crc >>> 8)
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

export interface ZipEntry {
  name: string   // path within the zip (e.g. "src/index.ts")
  data: Buffer
}

// Build a valid ZIP archive from the given entries.
// Uses deflate (method 8) unless storing produces a smaller result.
export function buildZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = []
  const centralDirs: Buffer[] = []
  const localOffsets: number[] = []
  let offset = 0

  const now     = new Date()
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF

  for (const entry of entries) {
    const nameBytes   = Buffer.from(entry.name, 'utf8')
    const crc         = crc32(entry.data)
    const uncompSize  = entry.data.length
    const deflated    = zlib.deflateRawSync(entry.data, { level: 6 })
    const useDeflate  = deflated.length < entry.data.length
    const method      = useDeflate ? 8 : 0
    const compData    = useDeflate ? deflated : entry.data
    const compSize    = compData.length

    // Local file header (30 bytes + filename)
    const local = Buffer.alloc(30 + nameBytes.length)
    local.writeUInt32LE(0x04034b50,      0)
    local.writeUInt16LE(20,              4)
    local.writeUInt16LE(0,               6)
    local.writeUInt16LE(method,          8)
    local.writeUInt16LE(dosTime,        10)
    local.writeUInt16LE(dosDate,        12)
    local.writeUInt32LE(crc,            14)
    local.writeUInt32LE(compSize,       18)
    local.writeUInt32LE(uncompSize,     22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0,              28)
    nameBytes.copy(local, 30)

    localOffsets.push(offset)
    offset += local.length + compData.length
    parts.push(local, compData)

    // Central directory entry (46 bytes + filename)
    const central = Buffer.alloc(46 + nameBytes.length)
    central.writeUInt32LE(0x02014b50,      0)
    central.writeUInt16LE(20,              4)
    central.writeUInt16LE(20,              6)
    central.writeUInt16LE(0,               8)
    central.writeUInt16LE(method,         10)
    central.writeUInt16LE(dosTime,        12)
    central.writeUInt16LE(dosDate,        14)
    central.writeUInt32LE(crc,            16)
    central.writeUInt32LE(compSize,       20)
    central.writeUInt32LE(uncompSize,     24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0,              30)
    central.writeUInt16LE(0,              32)
    central.writeUInt16LE(0,              34)
    central.writeUInt16LE(0,              36)
    central.writeUInt32LE(0,              38)
    central.writeUInt32LE(localOffsets[localOffsets.length - 1]!, 42)
    nameBytes.copy(central, 46)
    centralDirs.push(central)
  }

  const centralDir       = Buffer.concat(centralDirs)
  const centralDirOffset = offset
  const centralDirSize   = centralDir.length

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50,         0)
  eocd.writeUInt16LE(0,                  4)
  eocd.writeUInt16LE(0,                  6)
  eocd.writeUInt16LE(entries.length,     8)
  eocd.writeUInt16LE(entries.length,    10)
  eocd.writeUInt32LE(centralDirSize,    12)
  eocd.writeUInt32LE(centralDirOffset,  16)
  eocd.writeUInt16LE(0,                 20)

  return Buffer.concat([...parts, centralDir, eocd])
}
