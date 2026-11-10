import { describe, expect, it } from "vitest";
import { isLocalHost, isLocalOrigin, isLocalRequest } from "../src/local-only.ts";

describe("local-only guard", () => {
  it("allows non-browser clients and the editor's own origins", () => {
    for (const o of [undefined, "", "http://127.0.0.1:5180", "http://localhost:5180", "https://localhost", "http://[::1]:5180", "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"])
      expect(isLocalOrigin(o), String(o)).toBe(true);
  });
  it("refuses web pages from other sites", () => {
    for (const o of ["https://evil.example", "http://127.0.0.1.evil.example", "http://localhost.evil.example", "null", "file://", "tauri://evil", "chrome-extension://abc", "ws://localhost"])
      expect(isLocalOrigin(o), o).toBe(false);
  });
  it("refuses DNS rebinding hosts", () => {
    expect(isLocalHost("127.0.0.1:7718")).toBe(true);
    expect(isLocalHost("localhost:7717")).toBe(true);
    expect(isLocalHost("[::1]:7718")).toBe(true);
    expect(isLocalHost("rebind.evil.example:7718")).toBe(false);
    expect(isLocalHost(undefined)).toBe(false);
    expect(isLocalRequest({ origin: "http://rebind.evil.example:7718", host: "rebind.evil.example:7718" })).toBe(false);
    expect(isLocalRequest({ host: "127.0.0.1:7718" })).toBe(true);
  });
});
