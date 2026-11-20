import { describe, expect, it } from "vitest";
import { MAX_RECENT, addRecent, clearRecent, recentLabel, recentProjects, removeRecent, sanitizeRecent } from "../src/recent.ts";

describe("open recent", () => {
  it("keeps the newest first, without duplicates, up to the limit", () => {
    clearRecent();
    addRecent("/p/a.obone", 1);
    addRecent("/p/b.obone", 2);
    addRecent("/p/a.obone", 3); // opened again: back to the top, once
    expect(recentProjects().map((r) => r.path)).toEqual(["/p/a.obone", "/p/b.obone"]);
    for (let i = 0; i < MAX_RECENT + 5; i++) addRecent(`/p/${i}.obone`, 10 + i);
    expect(recentProjects()).toHaveLength(MAX_RECENT);
    expect(recentProjects()[0].path).toBe(`/p/${MAX_RECENT + 4}.obone`);
    removeRecent(`/p/${MAX_RECENT + 4}.obone`);
    expect(recentProjects()[0].path).toBe(`/p/${MAX_RECENT + 3}.obone`);
    clearRecent();
    expect(recentProjects()).toEqual([]);
  });

  it("ignores broken stored data", () => {
    expect(sanitizeRecent("nope")).toEqual([]);
    expect(sanitizeRecent([null, { path: "" }, { path: 3 }, { path: "/x.obone" }, { path: "/x.obone", time: 5 }])).toEqual([{ path: "/x.obone", time: 0 }]);
  });

  it("labels a row with the file and its folder", () => {
    expect(recentLabel("/home/me/Starcaller/starcaller.obone")).toBe("starcaller.obone — Starcaller");
    expect(recentLabel("C:\\Art\\hero.obone")).toBe("hero.obone — Art");
    expect(recentLabel("hero.obone")).toBe("hero.obone");
  });
});
