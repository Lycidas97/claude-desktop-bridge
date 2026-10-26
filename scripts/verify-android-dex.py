#!/usr/bin/env python3
"""Verify every classes*.dex in an APK with Android build-tools dexdump.

Run with python3 -I. A valid APK signature does not imply valid DEX contents.
Use --dexdump when build-tools are outside ANDROID_HOME / ANDROID_SDK_ROOT.
"""

import argparse
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("apk", type=Path)
parser.add_argument("--dexdump", type=Path)
args = parser.parse_args()

dexdump = args.dexdump or shutil.which("dexdump")
if not dexdump:
    sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    if sdk:
        candidates = sorted(
            (Path(sdk) / "build-tools").glob("*/dexdump*"),
            key=lambda path: tuple(int(part) for part in re.findall(r"\d+", path.parent.name)),
        )
        if candidates:
            dexdump = candidates[-1]
if not dexdump:
    raise SystemExit("dexdump not found: set ANDROID_HOME or pass --dexdump")

failed = []
with zipfile.ZipFile(args.apk) as apk, tempfile.TemporaryDirectory(prefix="bridge-dex-check-") as directory:
    entries = [entry for entry in apk.infolist() if re.fullmatch(r"classes(?:[2-9]|[1-9]\d+)?\.dex", entry.filename)]
    if not entries:
        raise SystemExit("APK contains no classes*.dex")
    for entry in entries:
        path = Path(directory) / entry.filename
        path.write_bytes(apk.read(entry))
        result = subprocess.run([str(dexdump), "-c", str(path)], capture_output=True, text=True)
        if result.returncode:
            failed.append(entry.filename)
            print(f"FAIL {entry.filename}\n{result.stdout}{result.stderr}", flush=True)
        else:
            print(f"PASS {entry.filename}", flush=True)

if failed:
    raise SystemExit(f"Invalid DEX files: {', '.join(failed)}")
print(f"Verified all {len(entries)} DEX files in {args.apk.name}")
