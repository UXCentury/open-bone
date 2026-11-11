import { describe, expect, it, vi } from "vitest";

vi.mock("virtual:openbone-about", () => ({ default: { version: "0.3.0", commit: "", dirty: false, buildDate: "", credits: [] } }));
vi.mock("../src/state.ts", () => ({ toast: () => {} }));
vi.mock("../src/storage.ts", () => ({ isDesktop: () => false }));
vi.mock("../src/activity.ts", () => ({ logActivity: () => {} }));

const { compareVersions, detectOs, pickInstaller } = await import("../src/updates.ts");

describe("update checker", () => {
  it("compares versions numerically, pre-releases first", () => {
    expect(compareVersions("0.3.0", "0.3.0")).toBe(0);
    expect(compareVersions("v0.3.1", "0.3.0")).toBe(1);
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBe(-1);
    expect(compareVersions("0.3", "0.3.0")).toBe(0);
  });

  it("picks the installer for this system from the release assets", () => {
    const names = ["OpenBone-0.3.1-1.x86_64.rpm", "OpenBone_0.3.1_amd64.AppImage", "OpenBone_0.3.1_amd64.deb", "OpenBone_0.3.1_universal.app.tar.gz", "OpenBone_0.3.1_universal.dmg", "OpenBone_0.3.1_x64-setup.exe", "OpenBone_0.3.1_x64_en-US.msi"];
    const assets = names.map((name) => ({ name, browser_download_url: `https://x/${name}` }));
    expect(pickInstaller(assets, "windows")?.name).toBe("OpenBone_0.3.1_x64-setup.exe");
    expect(pickInstaller(assets, "mac")?.name).toBe("OpenBone_0.3.1_universal.dmg");
    expect(pickInstaller(assets, "linux")?.name).toBe("OpenBone_0.3.1_amd64.AppImage");
    expect(pickInstaller(assets, "other")).toBeNull();
    expect(detectOs("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(detectOs("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("mac");
    expect(detectOs("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
    expect(detectOs("Mozilla/5.0 (Linux; Android 14)")).toBe("other");
  });
});
