"""Detect installed versions of the DCC tools and engines the docs mirror covers.

Detection reads install folder names only (no app is launched). Each product lists the
folders its installers use on Windows and macOS; the highest version found wins. Anything
detection gets wrong, or cannot see (portable Godot builds, custom drives), goes in
`versions.override.toml` in the mirror directory:

    [versions]
    godot = "4.7"
    blender = "5.3"
"""

from __future__ import annotations

import os
import re
import sys
import tomllib
from pathlib import Path


def _version_key(v: str):
    return [int(p) if p.isdigit() else p for p in re.split(r"[.\-_]", v)]


def _program_files() -> list[Path]:
    roots = []
    for var in ("ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"):
        v = os.environ.get(var)
        if v and Path(v) not in roots:
            roots.append(Path(v))
    return roots


def _steam_common() -> list[Path]:
    out = []
    for root in _program_files():
        p = root / "Steam" / "steamapps" / "common"
        if p.is_dir():
            out.append(p)
    return out


# Each rule: (product, parent folder candidates, regex on child folder name -> version group).
def _rules(home: Path):
    pf = _program_files()
    steam = _steam_common()
    rules = [
        ("blender", [p / "Blender Foundation" for p in pf], r"Blender (\d+\.\d+)"),
        ("blender", steam, r"Blender()"),  # Steam build: version unknown from the folder
        ("houdini", [p / "Side Effects Software" for p in pf] + [Path("/Applications/Houdini")],
         r"Houdini ?(\d+\.\d+\.\d+)"),
        ("unity", [p / "Unity" / "Hub" / "Editor" for p in pf]
         + [Path("/Applications/Unity/Hub/Editor")], r"(\d{4}\.\d+\.\d+\w*)"),
        ("unreal", [p / "Epic Games" for p in pf] + [Path("/Users/Shared/Epic Games")],
         r"UE_(\d+\.\d+)"),
        ("godot", [p / "Godot" for p in pf] + steam + [home / "Godot", Path("/Applications")],
         r"Godot[ _]?v?(\d+\.\d+(?:\.\d+)?)"),
        ("rizomuv", [p / "Rizom Lab" for p in pf] + [Path("/Applications")],
         r"RizomUV[ _]?(?:VS |RS )?(\d{4}\.\d+)"),
        ("cascadeur", pf + [Path("/Applications")], r"Cascadeur()"),
        ("substance-designer", [p / "Adobe" for p in pf] + [Path("/Applications")],
         r"Adobe Substance 3D Designer()"),
        ("substance-painter", [p / "Adobe" for p in pf] + [Path("/Applications")],
         r"Adobe Substance 3D Painter()"),
        ("substance-sampler", [p / "Adobe" for p in pf] + [Path("/Applications")],
         r"Adobe Substance 3D Sampler()"),
    ]
    return rules


def _mac_bundle_version(app: Path) -> str | None:
    plist = app / "Contents" / "Info.plist"
    if not plist.is_file():
        return None
    try:
        import plistlib

        with plist.open("rb") as f:
            return plistlib.load(f).get("CFBundleShortVersionString")
    except Exception:
        return None


def detect(home: Path | None = None) -> dict[str, dict]:
    """Return {product: {"version": str|None, "path": str, "source": "folder"|"bundle"}}."""
    home = home or Path.home()
    found: dict[str, dict] = {}
    for product, parents, pattern in _rules(home):
        for parent in parents:
            if not parent.is_dir():
                continue
            try:
                children = list(parent.iterdir())
            except OSError:
                continue
            for child in children:
                name = child.name[:-4] if child.name.endswith(".app") else child.name
                m = re.fullmatch(pattern + r".*", name, re.I)
                if not m:
                    continue
                version = m.group(1) or None
                source = "folder"
                if version is None and child.name.endswith(".app"):
                    version = _mac_bundle_version(child)
                    source = "bundle"
                prev = found.get(product)
                if prev is None or (version and (prev["version"] is None
                                                 or _version_key(version) > _version_key(prev["version"]))):
                    found[product] = {"version": version, "path": str(child), "source": source}
    # Blender on macOS is a single Blender.app.
    mac_blender = Path("/Applications/Blender.app")
    if "blender" not in found and mac_blender.is_dir():
        found["blender"] = {"version": _mac_bundle_version(mac_blender), "path": str(mac_blender),
                            "source": "bundle"}
    return found


def load(mirror_dir: Path, home: Path | None = None) -> dict[str, dict]:
    """Detected versions with `versions.override.toml` applied on top."""
    versions = detect(home)
    override = mirror_dir / "versions.override.toml"
    if override.is_file():
        with override.open("rb") as f:
            data = tomllib.load(f).get("versions", {})
        for product, version in data.items():
            if not isinstance(version, str):
                # Unquoted 4.10 is the TOML float 4.1: refuse rather than mirror the wrong docs.
                raise SystemExit(f'{override}: quote the version, e.g. {product} = "{version}"')
            versions[product] = {"version": str(version), "path": versions.get(product, {}).get("path", ""),
                                 "source": "override"}
    return versions


def doc_version(product_version: str | None) -> str | None:
    """Map an installed version to the form versioned docs URLs use: major.minor.

    Blender 5.3.1 -> 5.3, Unity 6000.3.2f1 -> 6000.3, Houdini 22.0.512 -> 22.0, UE 5.8 -> 5.8.
    """
    if not product_version:
        return None
    parts = re.findall(r"\d+", product_version)
    if len(parts) < 2:
        return None
    return f"{parts[0]}.{parts[1]}"


if __name__ == "__main__":
    import json

    print(json.dumps(load(Path(sys.argv[1]) if len(sys.argv) > 1 else Path(".")), indent=2))
