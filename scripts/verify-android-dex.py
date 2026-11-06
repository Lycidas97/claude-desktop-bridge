#!/usr/bin/env python3
"""Verify native Capacitor registration and every classes*.dex in an APK.

Run with python3 -I. A valid APK signature does not imply valid DEX contents.
Use --dexdump when build-tools are outside ANDROID_HOME / ANDROID_SDK_ROOT.
Temporary DEX files are moved to the system recycle bin through the shared helper.
"""

import argparse
import json
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
with zipfile.ZipFile(args.apk) as apk:
    if "assets/capacitor.plugins.json" not in apk.namelist():
        raise SystemExit("APK is missing capacitor.plugins.json; native Android back and other plugins cannot load")
    plugins = {entry["pkg"]: entry["classpath"] for entry in json.loads(apk.read("assets/capacitor.plugins.json"))}
    for package, classpath in {
        "@capacitor/app": "com.capacitorjs.plugins.app.AppPlugin",
        "@capacitor/filesystem": "com.capacitorjs.plugins.filesystem.FilesystemPlugin",
        "@capacitor/push-notifications": "com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin",
        "@capacitor/share": "com.capacitorjs.plugins.share.SharePlugin",
    }.items():
        if plugins.get(package) != classpath:
            raise SystemExit(f"APK is missing native plugin registration: {package}")
    print("PASS native Capacitor plugin registrations", flush=True)
    entries = [entry for entry in apk.infolist() if re.fullmatch(r"classes(?:[2-9]|[1-9]\d+)?\.dex", entry.filename)]
    if not entries:
        raise SystemExit("APK contains no classes*.dex")
    directory = Path(tempfile.mkdtemp(prefix="bridge-dex-check-"))
    try:
        for entry in entries:
            path = directory / entry.filename
            path.write_bytes(apk.read(entry))
            result = subprocess.run([str(dexdump), "-c", str(path)], capture_output=True, text=True)
            if result.returncode:
                failed.append(entry.filename)
                print(f"FAIL {entry.filename}\n{result.stdout}{result.stderr}", flush=True)
            else:
                print(f"PASS {entry.filename}", flush=True)
    finally:
        scripts = Path(__file__).resolve().parent
        subprocess.run([
            "node", "--require", str(scripts / "recycle-cleanup.cjs"),
            str(scripts / "clean.mjs"), str(directory),
        ], check=True)

if failed:
    raise SystemExit(f"Invalid DEX files: {', '.join(failed)}")
print(f"Verified native plugins and all {len(entries)} DEX files in {args.apk.name}")
