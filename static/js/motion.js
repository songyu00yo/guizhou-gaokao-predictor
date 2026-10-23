export function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
}

const countFrames = new WeakMap();

// 数字从上一次的值滚动到新值；减少动态效果时直接写最终值。
export function countUp(node, value, { format = (n) => Math.round(n).toLocaleString("zh-CN"), duration = 1400 } = {}) {
  if (!node) return;
  const target = Number(value);
  const previous = Number(node.dataset.countValue);
  node.dataset.countValue = String(target);
  if (prefersReducedMotion()) {
    node.textContent = format(target);
    return;
  }
  const from = Number.isFinite(previous) ? previous : 0;
  cancelAnimationFrame(countFrames.get(node));
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - t) ** 4;
    node.textContent = format(from + (target - from) * eased);
    if (t < 1) countFrames.set(node, requestAnimationFrame(step));
  };
  countFrames.set(node, requestAnimationFrame(step));
}
