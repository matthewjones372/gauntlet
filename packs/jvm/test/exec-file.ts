// Execution data as JaCoCo's agent writes it, for the test map's tests (spec 0013).

/** JaCoCo's exec format (ExecutionDataWriter, version 0x1007), for a few classes. */
export const execFile = (classes: ReadonlyArray<{ readonly name: string; readonly probes: ReadonlyArray<boolean> }>): Uint8Array => {
  const out: number[] = []
  const u16 = (n: number) => out.push((n >> 8) & 0xff, n & 0xff)
  const i64 = (n: number) => {
    for (let i = 7; i >= 0; i--) out.push(i >= 4 ? 0 : (n >>> (i * 8)) & 0xff)
  }
  const utf = (s: string) => {
    const b = new TextEncoder().encode(s)
    u16(b.length)
    out.push(...b)
  }
  const varint = (n: number) => {
    while ((n & ~0x7f) !== 0) {
      out.push(0x80 | (n & 0x7f))
      n >>>= 7
    }
    out.push(n)
  }
  out.push(0x01)
  u16(0xc0c0)
  u16(0x1007)
  out.push(0x10)
  utf("host-1234")
  i64(1)
  i64(2)
  classes.forEach((c, i) => {
    out.push(0x11)
    i64(i + 1)
    utf(c.name)
    varint(c.probes.length)
    for (let at = 0; at < c.probes.length; at += 8) {
      let byte = 0
      c.probes.slice(at, at + 8).forEach((p, bit) => {
        if (p) byte |= 1 << bit
      })
      out.push(byte)
    }
  })
  return new Uint8Array(out)
}
