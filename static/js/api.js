let recommendationController = null;

export async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `请求失败（${response.status}）`);
  }
  return response.json();
}

export function fetchRecommendations(payload) {
  // 连续提交时取消旧请求，旧响应就不会覆盖用户最后一次输入。
  recommendationController?.abort();
  recommendationController = new AbortController();
  return fetchJson("/api/v1/recommendations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: recommendationController.signal,
  });
}

export function isAbortError(error) {
  return error?.name === "AbortError";
}
