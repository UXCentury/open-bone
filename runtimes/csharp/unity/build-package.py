#!/usr/bin/env python3
"""
Builds the Unity package's plugins and meta files.

  python3 runtimes/csharp/unity/build-package.py          # DLLs into Plugins/, .meta files for everything
  python3 runtimes/csharp/unity/build-package.py --pack   # ...and com.openbone.runtime-<version>.tgz (Add package from tarball)
  python3 runtimes/csharp/unity/build-package.py --out DIR [--pack]
      # assemble the complete package (sources, DLLs, every .meta) into DIR, leaving the source tree untouched;
      # this is what CI pushes to the `upm` branch (Package Manager git URL ...open-bone.git#upm, and OpenUPM)

Needs the .NET SDK (dotnet on PATH, or ~/.dotnet/dotnet). Plugins: OpenBone.Runtime.dll and OpenBone.Scripting.Jint.dll
(netstandard2.1, built from runtimes/csharp/src), Jint.dll (BSD-2-Clause) and Esprima.dll (BSD-3-Clause) from NuGet.
Meta GUIDs are derived from the package-relative path (md5 of "com.openbone.runtime/<path>"), so they are stable across
machines and runs, and identical whether the package is built in place or assembled with --out.
"""
import hashlib, json, os, shutil, subprocess, sys, tarfile

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE_PKG = os.path.join(HERE, "com.openbone.runtime")
PKG = SOURCE_PKG
SRC = os.path.normpath(os.path.join(HERE, "..", "src"))
PLUGINS = os.path.join(PKG, "Plugins")
DLLS = ("OpenBone.Runtime.dll", "OpenBone.Scripting.Jint.dll", "Jint.dll", "Esprima.dll")


def dotnet():
    for c in ("dotnet", os.path.expanduser("~/.dotnet/dotnet")):
        if shutil.which(c) or os.path.exists(c):
            return c
    sys.exit("dotnet not found: install the .NET 8 SDK (https://dot.net)")


def build_plugins():
    proj = os.path.join(SRC, "OpenBone.Scripting.Jint", "OpenBone.Scripting.Jint.csproj")
    out = os.path.join(HERE, "obj-plugins")
    shutil.rmtree(out, ignore_errors=True)
    subprocess.check_call([dotnet(), "publish", proj, "-c", "Release", "-f", "netstandard2.1", "-o", out, "--nologo"])
    extra = sorted(f for f in os.listdir(out) if f.endswith(".dll") and f not in DLLS)
    if extra:
        sys.exit(f"publish produced DLLs the package does not list: {extra} (add them to DLLS, link.xml and the README)")
    os.makedirs(PLUGINS, exist_ok=True)
    for dll in DLLS:
        shutil.copy2(os.path.join(out, dll), os.path.join(PLUGINS, dll))
    shutil.rmtree(out, ignore_errors=True)


def guid(rel):
    return hashlib.md5(("com.openbone.runtime/" + rel.replace(os.sep, "/")).encode()).hexdigest()


def meta_body(path):
    ext = os.path.splitext(path)[1].lower()
    if os.path.isdir(path):
        return "folderAsset: yes\nDefaultImporter:\n  externalObjects: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n"
    if ext == ".cs":
        return ("MonoImporter:\n  externalObjects: {}\n  serializedVersion: 2\n  defaultReferences: []\n  executionOrder: 0\n"
                "  icon: {instanceID: 0}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n")
    if ext == ".dll":
        return ("PluginImporter:\n  externalObjects: {}\n  serializedVersion: 2\n  iconMap: {}\n  executionOrder: {}\n"
                "  defineConstraints: []\n  isPreloaded: 0\n  isOverridable: 0\n  isExplicitlyReferenced: 0\n  validateReferences: 1\n"
                "  platformData:\n  - first:\n      Any: \n    second:\n      enabled: 1\n      settings: {}\n"
                "  userData: \n  assetBundleName: \n  assetBundleVariant: \n")
    if ext == ".shader":
        return ("ShaderImporter:\n  externalObjects: {}\n  defaultTextures: []\n  nonModifiableTextures: []\n"
                "  userData: \n  assetBundleName: \n  assetBundleVariant: \n")
    if ext == ".asmdef":
        return "AssemblyDefinitionImporter:\n  externalObjects: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n"
    if ext in (".md", ".json", ".txt", ".xml"):
        return "TextScriptImporter:\n  externalObjects: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n"
    return "DefaultImporter:\n  externalObjects: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n"


def write_metas():
    count = 0
    for root, dirs, files in os.walk(PKG):
        dirs[:] = [d for d in dirs if not d.startswith(".") and not d.endswith("~")]
        for name in dirs + files:
            if name.endswith(".meta") or name.startswith("."):
                continue
            path = os.path.join(root, name)
            rel = os.path.relpath(path, PKG)
            meta = path + ".meta"
            if os.path.exists(meta):
                continue
            with open(meta, "w", newline="\n") as f:
                f.write(f"fileFormatVersion: 2\nguid: {guid(rel)}\n{meta_body(path)}")
            count += 1
    print(f"wrote {count} meta file(s)")


def assemble(out):
    """Copies the package sources (not the locally built Plugins/*.dll) into an empty directory and points PKG at it."""
    global PKG, PLUGINS
    out = os.path.abspath(out)
    if os.path.exists(out) and os.listdir(out):
        sys.exit(f"--out directory is not empty: {out}")

    def ignore(d, names):
        if os.path.abspath(d) == os.path.join(SOURCE_PKG, "Plugins"):
            return [n for n in names if n.endswith(".dll") or n.endswith(".dll.meta")]
        return [n for n in names if n.startswith(".")]

    shutil.copytree(SOURCE_PKG, out, ignore=ignore, dirs_exist_ok=True)
    PKG, PLUGINS = out, os.path.join(out, "Plugins")
    with open(os.path.join(PLUGINS, "README.md"), "w", newline="\n") as f:
        f.write("# Plugins\n\nPrebuilt from the OpenBone repository (`runtimes/csharp`): `OpenBone.Runtime.dll` and\n"
                "`OpenBone.Scripting.Jint.dll` (MIT, netstandard2.1), `Jint.dll` (BSD-2-Clause) and `Esprima.dll` (BSD-3-Clause).\n")


def verify():
    """Every asset has a .meta (Unity ignores, and warns about, files without one in an immutable package)."""
    problems = [f"missing Plugins/{d}" for d in DLLS if not os.path.isfile(os.path.join(PLUGINS, d))]
    for root, dirs, files in os.walk(PKG):
        dirs[:] = [d for d in dirs if not d.startswith(".") and not d.endswith("~")]
        for name in dirs + files:
            if name.endswith(".meta") or name.startswith("."):
                continue
            if not os.path.isfile(os.path.join(root, name) + ".meta"):
                problems.append("no .meta for " + os.path.relpath(os.path.join(root, name), PKG))
        for name in files:
            if name.endswith(".meta") and not os.path.exists(os.path.join(root, name[:-5])):
                problems.append("orphan " + os.path.relpath(os.path.join(root, name), PKG))
    if problems:
        sys.exit("incomplete package:\n  " + "\n  ".join(problems))
    print(f"package complete: {PKG}")


def pack():
    version = json.load(open(os.path.join(PKG, "package.json")))["version"]
    out_dir = HERE if PKG == SOURCE_PKG else os.path.dirname(PKG)
    out = os.path.join(out_dir, f"com.openbone.runtime-{version}.tgz")
    with tarfile.open(out, "w:gz") as tar:
        for root, dirs, files in os.walk(PKG):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            for name in files:
                if name.startswith("."):
                    continue
                path = os.path.join(root, name)
                tar.add(path, arcname="package/" + os.path.relpath(path, PKG).replace(os.sep, "/"))
    print(out)


if __name__ == "__main__":
    if "--out" in sys.argv:
        i = sys.argv.index("--out")
        if i + 1 >= len(sys.argv):
            sys.exit("--out needs a directory")
        assemble(sys.argv[i + 1])
    if "--metas-only" not in sys.argv:
        build_plugins()
    write_metas()
    if PKG != SOURCE_PKG:
        verify()
    if "--pack" in sys.argv:
        pack()
