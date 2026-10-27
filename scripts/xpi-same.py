"""Check that a Mozilla-signed .xpi holds exactly the files of an unsigned one.

Mozilla's signing adds META-INF/ (the signature) and repacks the zip, so the
two never match byte for byte; every other entry must have the same name and
the same contents. Exits 1, naming the differences, when they don't.

Usage: python3 -I scripts/xpi-same.py UNSIGNED.xpi SIGNED.xpi
"""
import sys
import zipfile


def entries(path):
    with zipfile.ZipFile(path) as z:
        return {i.filename: z.read(i) for i in z.infolist()
                if not i.is_dir() and not i.filename.startswith("META-INF/")}


def main(unsigned, signed):
    with zipfile.ZipFile(signed) as z:
        if "META-INF/cose.sig" not in z.namelist():
            print(f"{signed} carries no Mozilla signature (META-INF/cose.sig)", file=sys.stderr)
            return 1
    a, b = entries(unsigned), entries(signed)
    diff = sorted(n for n in a.keys() | b.keys() if a.get(n) != b.get(n))
    for n in diff:
        what = "only in unsigned" if n not in b else "only in signed" if n not in a else "differs"
        print(f"{what}: {n}", file=sys.stderr)
    if diff:
        return 1
    print(f"same files ({len(a)}), plus Mozilla's signature")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    sys.exit(main(*sys.argv[1:]))
