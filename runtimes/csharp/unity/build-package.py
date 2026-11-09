#!/usr/bin/env python3
"""
Builds the Unity package's plugins and meta files.

  python3 runtimes/csharp/unity/build-package.py          # DLLs into Plugins/, .meta files for everything
  python3 runtimes/csharp/unity/build-package.py --pack   # ...and com.openbone.runtime-<version>.tgz (Add package from tarball)

Needs the .NET SDK (dotnet on PATH, or ~/.dotnet/dotnet). Plugins: OpenBone.Runtime.dll and OpenBone.Scripting.Jint.dll
(netstandard2.1, built from runtimes/csharp/src), Jint.dll (BSD-2-Clause) and Esprima.dll (BSD-3-Clause) from NuGet.
Meta GUIDs are derived from the file path, so they are stable across machines and runs.
"""
import hashlib, json, os, shutil, subprocess, sys, tarfile

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.join(HERE, "com.openbone.runtime")
SRC = os.path.normpath(os.path.join(HERE, "..", "src"))
PLUGINS = os.path.join(PKG, "Plugins")


def dotnet():
    for c in ("dotnet", os.path.expanduser("~/.dotnet/dotnet")):
        if shutil.which(c) or os.path.exists(c):
            return c
    sys.exit("dotnet not found: install the .NET 8 SDK (https://dot.net)")


def build_plugins():
    proj = os.path.join(SRC, "OpenBone.Scripting.Jint", "OpenBone.Scripting.Jint.csproj")
    out = os.path.join(HERE, "obj-plugins")
    subprocess.check_call([dotnet(), "publish", proj, "-c", "Release", "-f", "netstandard2.1", "-o", out, "--nologo"])
    os.makedirs(PLUGINS, exist_ok=True)
    for dll in ("OpenBone.Runtime.dll", "OpenBone.Scripting.Jint.dll", "Jint.dll", "Esprima.dll"):
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


def pack():
    version = json.load(open(os.path.join(PKG, "package.json")))["version"]
    out = os.path.join(HERE, f"com.openbone.runtime-{version}.tgz")
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
    if "--metas-only" not in sys.argv:
        build_plugins()
    write_metas()
    if "--pack" in sys.argv:
        pack()
