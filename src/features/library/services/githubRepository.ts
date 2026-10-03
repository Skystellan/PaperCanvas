export async function fetchGithubStars(repositoryUrl: string): Promise<number> {
  const match = /^https:\/\/github\.com\/([a-z0-9-]+)\/([a-z0-9_.-]+)\/?$/i.exec(repositoryUrl);
  if (!match || [".", ".."].includes(match[2])) {
    throw new Error("请输入 GitHub 仓库链接：https://github.com/owner/repo");
  }
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${match[1]}/${match[2]}`, {
      headers: { Accept: "application/vnd.github+json" },
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new Error("无法连接 GitHub，已保留上次记录的 Stars。");
  }
  if (response.status === 403 || response.status === 429) {
    throw new Error("GitHub 暂时限制了请求，已保留上次记录的 Stars。请稍后再打开。");
  }
  if (response.status === 404) {
    throw new Error("GitHub 仓库不存在或无法公开访问，已保留上次记录。");
  }
  if (!response.ok) throw new Error("GitHub 暂时无法响应，已保留上次记录的 Stars。");
  const result = await response.json().catch(() => null);
  if (!Number.isSafeInteger(result?.stargazers_count) || result.stargazers_count < 0) {
    throw new Error("GitHub 返回的 Stars 无效，已保留上次记录。");
  }
  return result.stargazers_count;
}
