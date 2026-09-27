"""Zero the file offset of zero-fill thread-local (__thread_bss) Mach-O sections.

macOS 27's dyld refuses to load a library whose S_THREAD_LOCAL_ZEROFILL section
carries a non-zero file `offset` ("section '__DATA/__thread_bss' has a zero-fill
section type, but offset field is not zero"). The scipy 1.15.3 arm64 wheels (the
last scipy for Python 3.10, pinned in requirements.lock.txt) are built that way,
so `import scipy.<anything>` fails → whisperx.load_model raises → the engine
exits 10 and the app misreports it as a missing model.

A zero-fill section has no file bytes, so the offset is meaningless; zeroing it
is behavior-neutral. Patched files are ad-hoc re-signed (arm64 requires a valid
signature and the edit invalidates the original one).

usage: python patch_macho_tls.py DIR   (patches *.so / *.dylib under DIR in place)
"""
import os
import struct
import subprocess
import sys

MH_MAGIC_64 = 0xFEEDFACF
LC_SEGMENT_64 = 0x19
S_THREAD_LOCAL_ZEROFILL = 0x12


def patch_file(path):
    """Return the number of sections patched in a thin 64-bit Mach-O (0 = untouched)."""
    with open(path, "rb") as f:
        data = bytearray(f.read())
    if len(data) < 32 or struct.unpack_from("<I", data, 0)[0] != MH_MAGIC_64:
        return 0
    ncmds = struct.unpack_from("<I", data, 16)[0]
    off = 32
    changed = 0
    for _ in range(ncmds):
        cmd, cmdsize = struct.unpack_from("<II", data, off)
        if cmd == LC_SEGMENT_64:
            nsects = struct.unpack_from("<I", data, off + 64)[0]
            s = off + 72  # section_64 headers follow segment_command_64
            for _ in range(nsects):
                flags = struct.unpack_from("<I", data, s + 64)[0]
                if (flags & 0xFF) == S_THREAD_LOCAL_ZEROFILL:
                    if struct.unpack_from("<I", data, s + 48)[0] != 0:
                        struct.pack_into("<I", data, s + 48, 0)
                        changed += 1
                s += 80
        off += cmdsize
    if changed:
        with open(path, "wb") as f:
            f.write(data)
        subprocess.run(["codesign", "-f", "-s", "-", path], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return changed


def main(root):
    total = 0
    for dirpath, _, names in os.walk(root):
        for n in names:
            if n.endswith((".so", ".dylib")):
                if patch_file(os.path.join(dirpath, n)):
                    total += 1
    print("patched %d Mach-O file(s) under %s" % (total, root))


if __name__ == "__main__":
    main(sys.argv[1])
