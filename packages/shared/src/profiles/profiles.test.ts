import { describe, expect, it } from "vitest";

import { PROFILES, profileFor } from "./index.js";

describe("profileFor", () => {
  it("encuentra el perfil por sufijo de dominio", () => {
    expect(profileFor("https://es.wikipedia.org/wiki/Chrome")?.id).toBe("wikipedia");
    expect(profileFor("https://www.github.com/anthropics/claude-code")?.id).toBe("github-repo");
    expect(profileFor("https://news.ycombinator.com/")?.id).toBe("hackernews");
  });

  it("no encaja con dominios que solo terminan parecido", () => {
    expect(profileFor("https://notgithub.com/x")).toBeUndefined();
    expect(profileFor("https://fakewikipedia.org.evil.com/x")).toBeUndefined();
  });

  it("devuelve undefined para dominios sin perfil y urls invalidas", () => {
    expect(profileFor("https://example.com")).toBeUndefined();
    expect(profileFor("no-es-una-url")).toBeUndefined();
  });

  it("todos los perfiles tienen id unico y al menos un match", () => {
    const ids = PROFILES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const profile of PROFILES) expect(profile.match.length).toBeGreaterThan(0);
  });
});
