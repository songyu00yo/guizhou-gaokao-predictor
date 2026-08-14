export function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
}

export function animateNumber(node, value, formatter = Math.round) {
  if (!node) return;
  const target = Number(value);
  if (!Number.isFinite(target) || prefersReducedMotion()) {
    node.textContent = Number.isFinite(target) ? formatter(target) : "-";
    return;
  }
  const started = performance.now();
  const initial = Number(node.dataset.numericValue || 0);
  node.dataset.numericValue = String(target);
  node.getAnimations().forEach((animation) => animation.cancel());
  const tick = (now) => {
    const progress = Math.min(1, (now - started) / 520);
    const eased = 1 - Math.pow(1 - progress, 3);
    node.textContent = formatter(initial + (target - initial) * eased);
    if (progress < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export function reveal(node, className = "view-enter") {
  if (!node || prefersReducedMotion()) return;
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
  node.addEventListener("animationend", () => node.classList.remove(className), { once: true });
}

export function flip(elements, mutate) {
  const before = new Map(elements.map((node) => [node, node.getBoundingClientRect()]));
  mutate();
  if (prefersReducedMotion()) return;
  elements.forEach((node) => {
    const first = before.get(node);
    const last = node.getBoundingClientRect();
    if (!first || !last.width) return;
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    if (!dx && !dy) return;
    node.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
      { duration: 320, easing: "cubic-bezier(.2,.8,.2,1)" },
    );
  });
}
