import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGithubStars } from "./githubRepository";

afterEach(() => vi.unstubAllGlobals());

describe("GitHub repository refresh", () => {
  it("reads the GitHub star count without credentials or a cached response, including zero", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ stargazers_count: 0 })));
    vi.stubGlobal("fetch", fetch);
    expect(await fetchGithubStars("https://github.com/octocat/Hello-World/")).toBe(0);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("https://api.github.com/repos/octocat/Hello-World", {
      headers: { Accept: "application/vnd.github+json" }, credentials: "omit", cache: "no-store",
      signal: expect.any(AbortSignal),
    });
  });

  it("rejects non-GitHub and non-repository URLs before requesting anything", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const url of ["https://github.com.evil.test/a/b", "https://user@github.com/a/b",
      "http://github.com/a/b", "https://github.com/a/b/issues", "https://github.com/a/..",
      "https://github.com/a/b?x=1", "https://github.com/a", "file:///a/b"]) {
      await expect(fetchGithubStars(url)).rejects.toThrow("GitHub 仓库链接");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([403, 429, 404, 500])("reports status %i without inventing a star count or retrying", async status => {
    const fetch = vi.fn().mockResolvedValue(new Response("unavailable", { status }));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchGithubStars("https://github.com/a/b")).rejects.toThrow("已保留上次记录");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("handles timeouts and rejects malformed external data", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError"));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchGithubStars("https://github.com/a/b")).rejects.toThrow("无法连接 GitHub");
    for (const body of ["not JSON", "null", "{}", '{"stargazers_count":-1}', '{"stargazers_count":"10"}']) {
      fetch.mockResolvedValueOnce(new Response(body));
      await expect(fetchGithubStars("https://github.com/a/b")).rejects.toThrow("Stars 无效");
    }
  });
});
