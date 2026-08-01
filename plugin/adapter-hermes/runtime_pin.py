"""Acquire and assert the pinned runtime, without a Node toolchain.

npm performs the acquisition; this module owns the pin. The pin is a three-key
JSON manifest so a Python adapter can assert it by reading two files, which is
the property a package.json plus lockfile does not have (spec 8.3a).

Resolution order: the pinned plugin-local artifact, then JINN_PLUGIN_RUNTIME_BIN,
then the command on PATH. The last two are development overrides and are
reported as such, so a doctor never tells a user their product install is fine
when it is really a developer's export.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, List, Optional, Tuple

from . import paths

RUNTIME_PACKAGE = "@jinn-network/plugin-runtime"
_EXACT_SEMVER = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")
_INSTALL_TIMEOUT_S = 300

# npm's vocabulary for "the registry cannot supply this exact version".
_OUTAGE_MARKERS = ("e404", "etarget", "notarget", "no matching version", "404 not found")

Installer = Callable[[List[str], Path], Tuple[int, str, str]]


class RuntimePinError(RuntimeError):
    """The pin is malformed, unsatisfied, or unusable."""


class ChannelOutageError(RuntimePinError):
    """npm cannot supply the pinned version: not fixable from this machine.

    Distinct from every other failure because the doctor must report it with a
    null remedy rather than printing a command that cannot work (spec 9.3).
    """


@dataclass(frozen=True)
class RuntimePin:
    package: str
    version: str
    bin_path: str


@dataclass(frozen=True)
class RuntimeResolution:
    argv: Tuple[str, ...]
    source: str  # "pinned" | "env" | "path"
    detail: str
    pin: RuntimePin


def read_pin(directory: Optional[Path] = None) -> RuntimePin:
    target = directory if directory is not None else paths.plugin_dir()
    path = target / "runtime-pin.json"
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimePinError(f"unreadable runtime pin at {path}: {exc}") from exc
    if not isinstance(document, dict):
        raise RuntimePinError(f"invalid runtime pin at {path}")
    package = document.get("package")
    version = document.get("version")
    bin_path = document.get("bin")
    if package != RUNTIME_PACKAGE:
        raise RuntimePinError(f"invalid runtime pin at {path}: package must be {RUNTIME_PACKAGE}")
    if not isinstance(version, str) or _EXACT_SEMVER.fullmatch(version) is None:
        raise RuntimePinError(f"invalid runtime pin at {path}: version must be an exact semver")
    if not isinstance(bin_path, str) or not bin_path:
        raise RuntimePinError(f"invalid runtime pin at {path}: bin must be a relative path")
    relative = Path(bin_path)
    if relative.is_absolute() or ".." in relative.parts:
        raise RuntimePinError(f"invalid runtime pin at {path}: bin escapes the plugin directory")
    return RuntimePin(package=package, version=version, bin_path=bin_path)


def installed_manifest_path(directory: Path, pin: RuntimePin) -> Path:
    """``<plugin>/runtime/node_modules/@jinn-network/plugin-runtime/package.json``."""
    scope, name = pin.package.split("/", 1)
    return directory / "runtime" / "node_modules" / scope / name / "package.json"


def _assert_installed(directory: Path, pin: RuntimePin) -> Path:
    binary = directory / pin.bin_path
    if not binary.is_file():
        raise RuntimePinError(f"pinned runtime artifact is not a file: {binary}")
    if sys.platform != "win32" and not os.access(binary, os.X_OK):
        raise RuntimePinError(f"pinned runtime artifact is not executable: {binary}")
    manifest_path = installed_manifest_path(directory, pin)
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimePinError(f"pinned runtime manifest is unreadable: {manifest_path}") from exc
    if (
        not isinstance(manifest, dict)
        or manifest.get("name") != pin.package
        or manifest.get("version") != pin.version
    ):
        raise RuntimePinError(
            f"pinned runtime version mismatch: expected {pin.package}@{pin.version} "
            f"in {manifest_path}"
        )
    return binary


def resolve(directory: Optional[Path] = None) -> RuntimeResolution:
    target = directory if directory is not None else paths.plugin_dir()
    pin = read_pin(target)
    binary = target / pin.bin_path
    if binary.exists():
        asserted = _assert_installed(target, pin)
        return RuntimeResolution(
            argv=(str(asserted),),
            source="pinned",
            detail=f"{pin.package}@{pin.version} ({asserted})",
            pin=pin,
        )
    override = (os.environ.get("JINN_PLUGIN_RUNTIME_BIN") or "").strip()
    if override:
        return RuntimeResolution(
            argv=(override,),
            source="env",
            detail=f"JINN_PLUGIN_RUNTIME_BIN={override} (development override)",
            pin=pin,
        )
    on_path = shutil.which("jinn-plugin-runtime")
    if on_path:
        return RuntimeResolution(
            argv=(on_path,),
            source="path",
            detail=f"{on_path} on PATH (development override)",
            pin=pin,
        )
    raise RuntimePinError(f"{pin.package}@{pin.version} is not installed at {binary}")


def _default_installer(argv: List[str], cwd: Path) -> Tuple[int, str, str]:
    try:
        completed = subprocess.run(
            argv,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=_INSTALL_TIMEOUT_S,
            check=False,
        )
        return completed.returncode, completed.stdout.strip(), completed.stderr.strip()
    except FileNotFoundError:
        return 127, "", f"{argv[0]}: not found"
    except subprocess.TimeoutExpired:
        return 124, "", f"{argv[0]}: timed out after {_INSTALL_TIMEOUT_S}s"


def _is_channel_outage(text: str) -> bool:
    lowered = text.lower()
    return any(marker in lowered for marker in _OUTAGE_MARKERS)


def ensure(
    directory: Optional[Path] = None,
    installer: Installer = _default_installer,
) -> RuntimeResolution:
    """Resolve the runtime, acquiring it from npm when the pin is unsatisfied."""
    target = directory if directory is not None else paths.plugin_dir()
    pin = read_pin(target)

    if (target / pin.bin_path).exists():
        try:
            return resolve(target)
        except RuntimePinError:
            # A plugin update advanced the pin; the git pull left the previous
            # install behind. Remove the residue so npm installs into a clean
            # prefix rather than resolving against a superseded tree (spec 9.3).
            pass

    if (os.environ.get("JINN_PLUGIN_RUNTIME_BIN") or "").strip():
        return resolve(target)
    if shutil.which("jinn-plugin-runtime"):
        return resolve(target)

    if not paths.is_installed_plugin():
        raise RuntimePinError(
            "refusing runtime acquisition outside an installed plugin clone"
        )

    npm = shutil.which("npm")
    if npm is None:
        raise RuntimePinError(f"cannot install {pin.package}@{pin.version}: npm is not on PATH")

    runtime_dir = target / "runtime"
    if runtime_dir.is_symlink():
        raise RuntimePinError(f"refusing a symlinked runtime prefix: {runtime_dir}")
    modules_dir = runtime_dir / "node_modules"
    if modules_dir.is_symlink():
        raise RuntimePinError(f"refusing a symlinked runtime prefix: {modules_dir}")
    if modules_dir.exists():
        shutil.rmtree(modules_dir, ignore_errors=True)

    argv = [
        npm,
        "install",
        "--prefix",
        str(runtime_dir),
        "--save-exact",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        f"{pin.package}@{pin.version}",
    ]
    code, out, err = installer(argv, target)
    if code != 0:
        combined = f"{err}\n{out}".strip() or f"npm exited {code}"
        first_line = combined.splitlines()[0]
        if _is_channel_outage(combined):
            raise ChannelOutageError(
                f"npm cannot supply {pin.package}@{pin.version}: {first_line}"
            )
        raise RuntimePinError(f"failed to install {pin.package}@{pin.version}: {first_line}")
    return resolve(target)
