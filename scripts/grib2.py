"""Minimal pure-NumPy GRIB2 decoder.

Supports exactly what NOAA GFS pgrb2 regular lat/lon files use:
  - Grid Definition Template 3.0 (regular lat/lon)
  - Data Representation Template 5.0 (simple packing) and
    5.3 (complex packing with spatial differencing)
  - No bitmap (or bitmap indicator 255)

Written so the data pipeline needs no compiled GRIB library (eccodes),
which is blocked by Windows Application Control on some machines.
"""
import struct
import numpy as np


def _sm(value, nbytes):
    """Decode a GRIB 'sign and magnitude' integer."""
    top = 1 << (nbytes * 8 - 1)
    return -(value & (top - 1)) if value & top else value


def _read_bits(buf, bit_offsets, widths):
    """Read unsigned ints of varying widths (<=32) at given bit offsets."""
    out = np.zeros(bit_offsets.shape, dtype=np.int64)
    mask = widths > 0
    if not mask.any():
        return out
    offs = bit_offsets[mask]
    w = widths[mask].astype(np.uint64)
    byte = (offs >> 3).astype(np.int64)
    padded = np.concatenate([np.frombuffer(buf, dtype=np.uint8), np.zeros(8, np.uint8)]).astype(np.uint64)
    word = np.zeros(byte.shape, dtype=np.uint64)
    for k in range(8):
        word = (word << np.uint64(8)) | padded[byte + k]
    shift = (offs & 7).astype(np.uint64)
    word = word << shift  # drop leading bits (uint64 overflow discards them)
    out[mask] = (word >> (np.uint64(64) - w)).astype(np.int64)
    return out


def _packed_seq(buf, start_bit, count, width):
    offs = start_bit + np.arange(count, dtype=np.int64) * width
    return _read_bits(buf, offs, np.full(count, width, dtype=np.int64))


def _decode_53(s5, data, npts):
    R = struct.unpack(">f", s5[11:15])[0]
    E = _sm(struct.unpack(">H", s5[15:17])[0], 2)
    D = _sm(struct.unpack(">H", s5[17:19])[0], 2)
    nbits = s5[19]
    missing_mgmt = s5[22]
    NG = struct.unpack(">I", s5[31:35])[0]
    ref_w = s5[35]
    bits_w = s5[36]
    ref_l = struct.unpack(">I", s5[37:41])[0]
    inc_l = s5[41]
    last_l = struct.unpack(">I", s5[42:46])[0]
    bits_l = s5[46]
    order = s5[47]
    nextra = s5[48]
    if missing_mgmt != 0:
        raise NotImplementedError("missing-value management not supported")

    pos = 0
    extras = []
    for _ in range(order + 1):
        v = int.from_bytes(data[pos:pos + nextra], "big")
        extras.append(v)
        pos += nextra
    gmin = _sm(extras[-1], nextra)
    firsts = extras[:-1]
    bit = pos * 8

    def advance(bit, count, width):
        return ((bit + count * width + 7) // 8) * 8

    grefs = _packed_seq(data, bit, NG, nbits) if nbits else np.zeros(NG, np.int64)
    bit = advance(bit, NG, nbits)
    gw = (_packed_seq(data, bit, NG, bits_w) if bits_w else np.zeros(NG, np.int64)) + ref_w
    bit = advance(bit, NG, bits_w)
    gl = (_packed_seq(data, bit, NG, bits_l) if bits_l else np.zeros(NG, np.int64)) * inc_l + ref_l
    gl[-1] = last_l
    bit = advance(bit, NG, bits_l)
    if gl.sum() != npts:
        raise ValueError(f"group lengths sum {gl.sum()} != {npts}")

    widths = np.repeat(gw, gl)
    offs = bit + np.concatenate([[0], np.cumsum(widths)[:-1]])
    vals = _read_bits(data, offs, widths) + np.repeat(grefs, gl)

    if order == 1:
        vals[0] = firsts[0]
        vals[1:] += gmin
        vals = np.cumsum(vals)
    elif order == 2:
        h1, h2 = firsts
        d = vals.copy()
        d[2:] += gmin
        d1 = np.empty_like(d)
        d1[0] = 0
        d1[1] = h2 - h1
        d1[2:] = d1[1] + np.cumsum(d[2:])
        vals = h1 + np.cumsum(d1)
        vals[0] = h1
    else:
        raise NotImplementedError(f"spatial differencing order {order}")
    return (R + vals.astype(np.float64) * 2.0 ** E) / 10.0 ** D


def _decode_50(s5, data, npts):
    R = struct.unpack(">f", s5[11:15])[0]
    E = _sm(struct.unpack(">H", s5[15:17])[0], 2)
    D = _sm(struct.unpack(">H", s5[17:19])[0], 2)
    nbits = s5[19]
    vals = _packed_seq(data, 0, npts, nbits) if nbits else np.zeros(npts, np.int64)
    return (R + vals.astype(np.float64) * 2.0 ** E) / 10.0 ** D


def decode_messages(blob):
    """Yield dicts {discipline, category, parameter, surface, level, nx, ny, values(ny,nx), scan}."""
    pos = 0
    while True:
        pos = blob.find(b"GRIB", pos)
        if pos < 0:
            return
        discipline = blob[pos + 6]
        total = struct.unpack(">Q", blob[pos + 8:pos + 16])[0]
        p = pos + 16
        msg = {"discipline": discipline}
        s5 = None
        while p < pos + total - 4:
            ln, num = struct.unpack(">IB", blob[p:p + 5])
            sec = blob[p:p + ln]
            if num == 3:
                tmpl = struct.unpack(">H", sec[12:14])[0]
                if tmpl != 0:
                    raise NotImplementedError(f"grid template {tmpl}")
                msg["nx"] = struct.unpack(">I", sec[30:34])[0]
                msg["ny"] = struct.unpack(">I", sec[34:38])[0]
                msg["lat1"] = _sm(struct.unpack(">I", sec[46:50])[0], 4) / 1e6
                msg["lon1"] = _sm(struct.unpack(">I", sec[50:54])[0], 4) / 1e6
                msg["scan"] = sec[71]
            elif num == 4:
                msg["category"] = sec[9]
                msg["parameter"] = sec[10]
                msg["surface"] = sec[22]
                scale = sec[23]
                val = struct.unpack(">I", sec[24:28])[0]
                msg["level"] = val / (10 ** scale)
            elif num == 5:
                s5 = sec
                msg["npts"] = struct.unpack(">I", sec[5:9])[0]
                msg["dtemplate"] = struct.unpack(">H", sec[9:11])[0]
            elif num == 6:
                if sec[5] != 255:
                    raise NotImplementedError("bitmaps not supported")
            elif num == 7:
                data = sec[5:]
                if msg["dtemplate"] == 3:
                    v = _decode_53(s5, data, msg["npts"])
                elif msg["dtemplate"] == 0:
                    v = _decode_50(s5, data, msg["npts"])
                else:
                    raise NotImplementedError(f"data template {msg['dtemplate']}")
                msg["values"] = v.reshape(msg["ny"], msg["nx"])
            p += ln
        yield msg
        pos += total
