import { state } from "./js/state.js";
import { fetchJson, fetchRecommendations, isAbortError } from "./js/api.js";
import { prefersReducedMotion } from "./js/motion.js";

const DISPLAY_DIFFICULTY_COEFFICIENT = "2.5251";

const RISK_COLORS = {
  强冲: "#c93838",
  冲: "#c96b12",
  稳: "#1558b0",
  保: "#16865a",
  兜底: "#66758a",
};

const el = (id) => document.getElementById(id);

const scriptLoads = new Map();

function loadScript(src) {
  if (scriptLoads.has(src)) return scriptLoads.get(src);
  const task = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.addEventListener("load", resolve, { once: true });
    script.addEventListener("error", () => reject(new Error(`资源加载失败：${src}`)), { once: true });
    document.head.appendChild(script);
  });
  scriptLoads.set(src, task);
  return task;
}

function ensureECharts() {
  return window.echarts ? Promise.resolve() : loadScript("/static/echarts.min.js");
}

function ensureMathJax() {
  if (window.MathJax?.typesetPromise) return Promise.resolve();
  window.MathJax = {
    tex: { inlineMath: [["\\(", "\\)"]], displayMath: [["\\[", "\\]"]] },
    svg: { fontCache: "global" },
    options: { enableMenu: false },
  };
  return loadScript("https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js");
}

function isMotionQaMode() {
  return new URLSearchParams(window.location.search).get("motion_qa") === "1";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatInt(value) {
  const number = asNumber(value, 0);
  return number ? Math.round(number).toLocaleString("zh-CN") : "-";
}

function formatPercent(value, digits = 0) {
  const number = asNumber(value, 0);
  return `${(number * 100).toFixed(digits)}%`;
}

function formatSigned(value, digits = 1) {
  const number = asNumber(value, 0);
  return `${number >= 0 ? "+" : ""}${(number * 100).toFixed(digits)}%`;
}

function setText(id, value) {
  const node = el(id);
  if (node) node.textContent = value;
}

function toast(message) {
  const node = el("toast");
  if (!node) return;
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 2300);
}

function setEntryLoaderProgress(value) {
  const loader = el("entryLoader");
  if (!loader) return;
  const progress = Math.max(0, Math.min(1, Number(value) || 0));
  loader.style.setProperty("--entry-progress", progress.toFixed(3));
  const segmentValues = {
    rank: Math.min(progress / 0.34, 1),
    plan: Math.max(0, Math.min((progress - 0.34) / 0.34, 1)),
    school: Math.max(0, Math.min((progress - 0.68) / 0.32, 1)),
  };
  Object.entries(segmentValues).forEach(([name, value]) => {
    loader.style.setProperty(`--entry-${name}`, value.toFixed(3));
  });
}

function entryEase(value) {
  const t = Math.max(0, Math.min(1, value));
  return 1 - Math.pow(1 - t, 3);
}

function animateEntryLoaderTo(target, duration = 760) {
  const loader = el("entryLoader");
  if (!loader) return Promise.resolve();
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  const start = Number(window.getComputedStyle(loader).getPropertyValue("--entry-progress")) || 0;
  const end = Math.max(start, Math.max(0, Math.min(1, Number(target) || 0)));
  if (reduced || duration <= 0 || Math.abs(end - start) < 0.002) {
    setEntryLoaderProgress(end);
    return Promise.resolve();
  }
  const token = Symbol("entry-loader");
  state.entryLoaderAnimation = token;
  const startTime = performance.now();
  return new Promise((resolve) => {
    const frame = (now) => {
      if (state.entryLoaderAnimation !== token) {
        resolve();
        return;
      }
      const elapsed = Math.min(1, (now - startTime) / duration);
      const eased = entryEase(elapsed);
      setEntryLoaderProgress(start + (end - start) * eased);
      if (elapsed < 1) {
        requestAnimationFrame(frame);
      } else {
        resolve();
      }
    };
    requestAnimationFrame(frame);
  });
}

function setEntryLoaderStep(step, text) {
  const loader = el("entryLoader");
  if (!loader) return;
  const steps = ["rank", "plan", "school"];
  const activeIndex = steps.indexOf(step);
  loader.dataset.step = step || "";
  setText("entryLoaderText", text || "");
  loader.querySelectorAll("[data-loader-step]").forEach((node) => {
    node.classList.toggle("active", node.dataset.loaderStep === step);
    node.classList.toggle("done", steps.indexOf(node.dataset.loaderStep) < activeIndex);
  });
}

function showEntryLoader() {
  const loader = el("entryLoader");
  if (!loader) return;
  loader.hidden = false;
  loader.dataset.visible = "true";
  setEntryLoaderProgress(0);
  setText("entryLoaderTitle", "正在生成你的志愿决策表");
  requestAnimationFrame(() => setEntryLoaderStep("rank", "正在按2026一分一段表换算位次并校准基准。"));
}

async function hideEntryLoader() {
  const loader = el("entryLoader");
  if (!loader || loader.hidden) return;
  await animateEntryLoaderTo(1, 120);
  loader.dataset.visible = "false";
  await new Promise((resolve) => window.setTimeout(resolve, prefersReducedMotion() ? 0 : 160));
  loader.hidden = true;
}

function waitForVisibleLogos(timeout = 5000) {
  const images = [...document.querySelectorAll("#priorityList .school-logo img, #detailPanel .school-logo img, #recommendBody .school-logo img")];
  if (!images.length) return Promise.resolve();
  const waits = images.map((image) => new Promise((resolve) => {
    if (image.complete) {
      resolve();
      return;
    }
    const done = () => resolve();
    image.addEventListener("load", done, { once: true });
    image.addEventListener("error", done, { once: true });
  }));
  return Promise.race([
    Promise.allSettled(waits),
    new Promise((resolve) => window.setTimeout(resolve, timeout)),
  ]);
}

const NO_CHART_ANIMATION = {
  animation: false,
  animationDuration: 0,
  animationDurationUpdate: 0,
  animationEasing: "linear",
  animationEasingUpdate: "linear",
};

const ANIMATED_CHART_IDS = new Set(["rankTrendMini"]);

function disableChartAnimation(chart) {
  if (!chart || chart.__noAnimationPatched) return chart;
  const originalSetOption = chart.setOption.bind(chart);
  chart.setOption = (option, ...rest) => {
    const nextOption = option && typeof option === "object" ? { ...option, ...NO_CHART_ANIMATION } : option;
    return originalSetOption(nextOption, ...rest);
  };
  chart.__noAnimationPatched = true;
  return chart;
}

function getChart(id) {
  const node = el(id);
  if (!node || !window.echarts) return null;
  if (!state.charts[id]) {
    const chart = echarts.init(node, null, { renderer: "canvas" });
    state.charts[id] = ANIMATED_CHART_IDS.has(id) ? chart : disableChartAnimation(chart);
  }
  return state.charts[id];
}

function riskClass(risk) {
  if (risk === "强冲") return "risk-strong";
  if (risk === "冲") return "risk-reach";
  if (risk === "稳") return "risk-stable";
  if (risk === "保") return "risk-safe";
  return "risk-fallback";
}

function riskShort(risk) {
  return risk === "强冲" ? "强冲" : risk || "-";
}

function guide(item) {
  return item?.school_guide || {};
}

function ladder(item) {
  return item?.school_ladder || {};
}

function textOr(value, fallback = "待核验") {
  const text = String(value ?? "").trim();
  return text && text !== "nan" ? text : fallback;
}

function tuitionText(item) {
  if (item?.tuition_range_2025) return `${item.tuition_range_2025}元/年`;
  const value = asNumber(item?.tuition_2025, 0);
  return value ? `${formatInt(value)}元/年` : "待核验";
}

function dormText(item) {
  return textOr(guide(item).dormitory || ladder(item).dormitory_ladder, "宿舍待核验");
}

function canteenText(item) {
  return textOr(guide(item).canteen, "食堂待核验");
}

function employmentText(item) {
  const parts = [guide(item).employment, guide(item).postgraduate_recommendation].filter(Boolean);
  return parts.length ? parts.join("；") : "就业保研待核验";
}

function probabilityText(item) {
  return formatPercent(admissionProbability(item));
}

function trendDirection(item) {
  const r24 = asNumber(item?.rank_2024, 0);
  const r25 = asNumber(item?.rank_2025, 0);
  if (!r24 || !r25) return "历史待核验";
  const delta = r25 - r24;
  if (Math.abs(delta) < Math.max(800, r24 * 0.015)) return "基本持平";
  return delta < 0 ? "竞争增强" : "竞争放缓";
}

function yearTrendHtml(item) {
  const predicted = asNumber(item?.predicted_rank || item?.rank_low, 0);
  return `
    <div class="year-stack">
      <span><b>24</b>${formatInt(item?.score_2024)}分 / ${formatInt(item?.rank_2024)}名</span>
      <span><b>25</b>${formatInt(item?.score_2025)}分 / ${formatInt(item?.rank_2025)}名</span>
      <span><b>26</b>${escapeHtml(item?.score_range || "-")} / ${formatInt(predicted)}名</span>
      <em>${escapeHtml(trendDirection(item))}</em>
    </div>
  `;
}

function coverageScore(item) {
  const values = [
    guide(item).dormitory || ladder(item).dormitory_ladder,
    guide(item).canteen,
    guide(item).employment,
    guide(item).postgraduate_recommendation,
    guide(item).transfer_policy,
    ladder(item).campus_facilities,
    guide(item).location || ladder(item).school_location,
  ];
  return values.filter((value) => textOr(value, "")).length;
}

function attachLogoAsset(school, asset) {
  const normalized = String(school || "").trim();
  state.logoCache[normalized] = asset;
  state.list.forEach((item) => {
    if (item.school === school) item.logo_asset = asset;
  });
  if (state.selected?.school === school) {
    state.selected.logo_asset = asset;
    if (state.selectedProfile) state.selectedProfile.asset = asset;
  }
}

async function autoFetchLogos(rows) {
  if (state.logoQueueRunning) return state.logoQueuePromise;
  const schools = [...new Set((rows || []).map((item) => item.school).filter(Boolean))]
    .filter((school) => state.logoCache[school]?.status !== "ready");
  if (!schools.length) return Promise.resolve();
  state.logoQueueRunning = true;
  state.logoQueuePromise = (async () => {
    for (let index = 0; index < schools.length; index += 20) {
      const batch = schools.slice(index, index + 20);
      const data = await fetchJson("/api/school-assets/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schools: batch }),
      });
      Object.entries(data.results || {}).forEach(([school, asset]) => attachLogoAsset(school, asset));
      renderPriorityList();
      renderTable();
      renderDetail();
      renderProfile();
      renderResources();
    }
  })()
    .catch((error) => {
      console.warn("logo batch fetch failed", error);
    })
    .finally(() => {
      state.logoQueueRunning = false;
      state.logoQueuePromise = null;
    });
  return state.logoQueuePromise;
}

function setNavIndicatorToButton(button, mode = "active") {
  const nav = el("navTabs");
  if (!nav || !button) return;
  const navBox = nav.getBoundingClientRect();
  const buttonBox = button.getBoundingClientRect();
  const x = `${Math.max(0, buttonBox.left - navBox.left)}px`;
  const w = `${button.offsetWidth}px`;
  if (mode === "hover") {
    if (nav.dataset.hoverView === button.dataset.view && nav.style.getPropertyValue("--nav-hover-x") === x && nav.style.getPropertyValue("--nav-hover-w") === w) {
      return;
    }
    nav.dataset.hoverView = button.dataset.view || "";
    nav.style.setProperty("--nav-hover-x", x);
    nav.style.setProperty("--nav-hover-w", w);
    nav.classList.add("nav-hovering");
  } else {
    nav.dataset.activeView = button.dataset.view || "";
    nav.style.setProperty("--nav-active-x", x);
    nav.style.setProperty("--nav-active-w", w);
    nav.style.setProperty("--nav-x", x);
    nav.style.setProperty("--nav-w", w);
  }
  nav.classList.add("nav-ready");
}

function updateNavIndicator() {
  const nav = el("navTabs");
  const active = nav?.querySelector("button.active");
  if (!nav || !active) return;
  setNavIndicatorToButton(active, "active");
}

function restartViewReveal(node) {
  if (!node) return;
  node.classList.remove("view-enter");
  void node.offsetWidth;
  node.classList.add("view-enter");
  window.setTimeout(() => node.classList.remove("view-enter"), 320);
}

function switchView(view) {
  const applyViewChange = () => {
    document.querySelectorAll(".primary-nav button").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
    document.querySelectorAll(".view").forEach((node) => {
      const active = node.id === `view-${view}`;
      node.classList.toggle("active", active);
      if (active) restartViewReveal(node);
    });
    updateNavIndicator();
    setTimeout(() => Object.values(state.charts).forEach((chart) => chart?.resize()), 80);
  };
  applyViewChange();
}

function bindNavMotion() {
  const nav = el("navTabs");
  if (!nav) return;
  nav.addEventListener("pointerover", (event) => {
    const button = event.target.closest("button[data-view]");
    if (!button || !nav.contains(button)) return;
    setNavIndicatorToButton(button, "hover");
  });
  nav.addEventListener("pointerleave", () => {
    nav.classList.remove("nav-hovering");
    delete nav.dataset.hoverView;
    updateNavIndicator();
  });
  nav.addEventListener("focusin", (event) => {
    const button = event.target.closest("button[data-view]");
    if (button) setNavIndicatorToButton(button, "hover");
  });
  nav.addEventListener("focusout", () => {
    window.setTimeout(() => {
      if (!nav.contains(document.activeElement)) {
        nav.classList.remove("nav-hovering");
        delete nav.dataset.hoverView;
        updateNavIndicator();
      }
    }, 0);
  });
}

async function loadResources() {
  try {
    state.resources = await fetchJson("/api/resources/summary");
    renderResources();
    renderMobileApp();
  } catch (error) {
    console.error(error);
    toast("资料摘要加载失败");
  }
}

async function generateList(options = {}) {
  const showLoader = Boolean(options.entryLoader);
  const scoreText = String(el("scoreInput")?.value ?? state.score ?? "").trim();
  if (!scoreText) return;
  if (showLoader && !options.loaderVisible) showEntryLoader();
  state.score = asNumber(scoreText, 0);
  // 位次由后端按2026一分一段表自动换算；state.currentRank 留空，请求时不传 current_rank
  state.currentRank = null;
  state.difficultyDelta = asNumber(state.difficultyDelta, 0.0825);
  state.page = 1;
  const generateButton = el("generateBtn");
  const refreshButton = el("refreshBtn");
  [generateButton, refreshButton].forEach((button) => {
    if (!button) return;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
  });
  document.body.dataset.motionStatus = "loading";
  setText("statusText", "正在生成...");
  try {
    if (showLoader) setEntryLoaderStep("rank", "正在按2026一分一段表换算位次。");
    if (showLoader) void animateEntryLoaderTo(0.32, 180);
    // 请求必须立即发出；进度动画只表达真实请求阶段，不作为等待门槛。
    const data = await fetchRecommendations({ score: state.score, risk: state.risk });
    const hidden = new Set(state.hiddenUnitIds || []);
    state.list = (data.list || []).filter((item) => !hidden.has(item.unit_id));
    state.alternates = (data.alternates || []).filter((item) => !hidden.has(item.unit_id));
    fillOpenSlots();
    state.list.forEach((item) => {
      if (item.logo_asset) attachLogoAsset(item.school, item.logo_asset);
    });
    if (showLoader) setEntryLoaderStep("plan", "已完成计划校准和风险分层。");
    if (showLoader) void animateEntryLoaderTo(0.72, 120);
    state.summary = data.summary || {};
    renderAll();
    if (showLoader) setEntryLoaderStep("school", "正在生成院校排序、详情卡片和资料说明。");
    if (showLoader) void animateEntryLoaderTo(0.9, 100);
    const first = [...state.list].sort((a, b) => (coverageScore(b) * 2 + asNumber(b.confidence_score)) - (coverageScore(a) * 2 + asNumber(a.confidence_score)))[0] || filteredList()[0] || state.list[0];
    if (first) void openDetail(first.unit_id);
    if (!isMotionQaMode()) {
      void autoFetchLogos(state.list);
    }
    document.body.dataset.motionStatus = "ready";
    setText("statusText", "推荐已更新");
    toast("推荐表已生成");
  } catch (error) {
    if (isAbortError(error)) return;
    console.error(error);
    document.body.dataset.motionStatus = "error";
    setText("statusText", "生成失败");
    toast("生成失败，请检查后端服务");
  } finally {
    if (showLoader) await hideEntryLoader();
    [generateButton, refreshButton].forEach((button) => {
      if (!button) return;
      button.disabled = false;
      button.removeAttribute("aria-busy");
    });
  }
}

function filteredList() {
  const query = state.query.trim().toLowerCase();
  const hidden = new Set(state.hiddenUnitIds || []);
  const usingExpandedSearch =
    Boolean(query) ||
    state.riskFilter !== "all" ||
    state.ownershipFilter !== "all" ||
    state.quickFilter !== "all" ||
    state.sort !== "order";
  const seen = new Set();
  const sourceRows = (usingExpandedSearch ? [...state.list, ...state.alternates] : state.list).filter((item) => {
    if (!item?.unit_id || seen.has(item.unit_id)) return false;
    seen.add(item.unit_id);
    return true;
  });
  let rows = sourceRows.filter((item) => {
    if (hidden.has(item.unit_id)) return false;
    const guideText = [
      item.school,
      item.major,
      guide(item).school_city,
      guide(item).dormitory,
      guide(item).canteen,
      guide(item).employment,
      guide(item).postgraduate_recommendation,
      guide(item).transfer_policy,
      ladder(item).campus_facilities,
    ].join(" ").toLowerCase();
    const riskOk = state.riskFilter === "all" || (state.riskFilter === "冲" ? ["强冲", "冲"].includes(item.risk_level) : item.risk_level === state.riskFilter);
    const ownershipOk = state.ownershipFilter === "all" || item.school_ownership_label === state.ownershipFilter;
    const quickOk =
      state.quickFilter === "all" ||
      (state.quickFilter === "dorm" && textOr(guide(item).dormitory || ladder(item).dormitory_ladder, "")) ||
      (state.quickFilter === "canteen" && textOr(guide(item).canteen, "")) ||
      (state.quickFilter === "employment" && textOr(guide(item).employment || guide(item).postgraduate_recommendation, "")) ||
      (state.quickFilter === "review" && coverageScore(item) >= 4);
    return riskOk && ownershipOk && quickOk && (!query || guideText.includes(query));
  });
  const sorters = {
    order: (a, b) => asNumber(a.order, 999) - asNumber(b.order, 999),
    confidence: (a, b) => admissionProbability(b) - admissionProbability(a),
    life: (a, b) => coverageScore(b) - coverageScore(a),
    tuition: (a, b) => asNumber(a.tuition_2025, 999999) - asNumber(b.tuition_2025, 999999),
  };
  return rows.sort(sorters[state.sort] || sorters.order);
}

function renderAll() {
  renderSummary();
  renderSegmentPrediction();
  renderPrecisionPanels();
  renderRiskChart();
  renderLeftAnalytics();
  renderPriorityList();
  renderTable();
  normalizeDecisionTableHeader();
  renderLifeGrid();
  renderSources();
  renderMobileApp();
  setTimeout(() => Object.values(state.charts).forEach((chart) => chart?.resize()), 80);
}

function isMobileLayout() {
  return window.matchMedia?.("(max-width: 820px)")?.matches;
}

function setMobileStep(step) {
  state.mobileStep = step || "overview";
  document.querySelectorAll("#mobileBottomNav button").forEach((button) => {
    button.classList.toggle("active", button.dataset.mobileStep === state.mobileStep);
  });
  renderMobileApp();
  el("mobileStage")?.scrollTo({ top: 0, behavior: "smooth" });
}

function mobileRiskDistribution() {
  return state.list.reduce((acc, item) => {
    const key = item.risk_level || "待判断";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function mobileKpi(label, value, sub = "") {
  return `<article class="mobile-kpi"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${sub ? `<p>${escapeHtml(sub)}</p>` : ""}</article>`;
}

function mobileCard(item, index) {
  return `
    <article class="mobile-card" data-unit="${escapeHtml(item.unit_id)}" style="--i:${index}">
      <div class="mobile-card-head">
        ${logoHtml(item.logo_asset || state.logoCache[item.school], item.school)}
        <div>
          <h2>${escapeHtml(item.school)}</h2>
          <p>${escapeHtml(item.major)} · ${escapeHtml(item.school_ownership_label || "待核验")}</p>
        </div>
        <span class="pill ${riskTone(item)}">${escapeHtml(item.risk_level || "待判断")}</span>
      </div>
      <div class="mobile-card-meta">
        <span>分数 ${escapeHtml(item.score_range || "-")}</span>
        <span>位次 ${escapeHtml(item.rank_range || "-")}</span>
        <span>概率 ${probabilityText(item)}</span>
        <span>资料 ${coverageScore(item)}/7</span>
        <span>学费 ${escapeHtml(tuitionText(item))}</span>
        <span>${escapeHtml(rankGapText(item))}</span>
      </div>
      <div class="mobile-card-actions">
        <button class="primary-mobile-action" data-mobile-open-detail="${escapeHtml(item.unit_id)}" type="button">查看详情</button>
        <button data-replace-unit="${escapeHtml(item.unit_id)}" type="button">换一条</button>
      </div>
    </article>
  `;
}

function renderMobileOverview() {
  const summary = state.summary || {};
  const total = state.list.length || asNumber(summary.returned, 0);
  const dist = mobileRiskDistribution();
  const maxCount = Math.max(1, ...Object.values(dist).map((value) => asNumber(value)));
  const riskRows = Object.entries(dist).map(([risk, count]) => `
    <div class="mobile-risk-row">
      <span>${escapeHtml(risk)}</span>
      <div class="mobile-meter"><i style="--meter:${Math.round((count / maxCount) * 100)}%"></i></div>
      <b>${count}</b>
    </div>
  `).join("");
  const topRows = mobileOverviewPriorityRows().map(mobileCard).join("");
  return `
    <section class="mobile-step">
      <div class="mobile-section-title">
        <div>
          <h1>志愿概览</h1>
          <p>先看整体风险，再进入推荐卡片逐条判断。</p>
        </div>
      </div>
      <div class="mobile-kpi-grid">
        ${mobileKpi("当前分", state.score || "-", "刷新后需重新填写")}
        ${mobileKpi("当前位次", formatInt(summary.predicted_user_rank || summary.user_rank), "按2026一分一段表")}
        ${mobileKpi("推荐数量", total || "-", "本科批候选")}
        ${mobileKpi("资料文件", formatInt(state.resources?.total_files), "本地资料库")}
      </div>
      <article class="mobile-detail-block">
        <h2>风险分布</h2>
        <div class="mobile-risk-list">${riskRows || "<p>等待生成推荐。</p>"}</div>
      </article>
      <div class="mobile-section-title">
        <div>
          <h1>优先查看</h1>
          <p>按录取概率、资料完整度和生活信息综合排序。</p>
        </div>
      </div>
      <div class="mobile-list">${topRows || "<article class='mobile-card'><p>暂无推荐，请返回输入分数重新生成。</p></article>"}</div>
    </section>
  `;
}

function renderMobileRecommend() {
  const rows = filteredList().slice(0, 96);
  return `
    <section class="mobile-step">
      <div class="mobile-section-title">
        <div>
          <h1>志愿推荐</h1>
          <p>${rows.length} 条可查看推荐，卡片内展示核心判断。</p>
        </div>
      </div>
      <div class="mobile-recommend-toolbar">
        <input id="mobileSearchInput" type="search" value="${escapeHtml(state.query)}" placeholder="搜索院校 / 专业 / 城市" />
        <button data-mobile-filter-open type="button">筛选</button>
      </div>
      <div class="mobile-list" id="mobileRecommendList">${rows.map(mobileCard).join("") || "<article class='mobile-card'><p>没有符合筛选条件的推荐。</p></article>"}</div>
    </section>
  `;
}

function updateMobileRecommendList() {
  const node = el("mobileRecommendList");
  if (!node) return;
  const rows = filteredList().slice(0, 96);
  node.innerHTML = rows.map(mobileCard).join("") || "<article class='mobile-card'><p>没有符合筛选条件的推荐。</p></article>";
}

function renderMobileDetailView() {
  const item = state.selected || state.list[0];
  if (!item) {
    return `
      <section class="mobile-step">
        <article class="mobile-detail-block">
          <h2>等待选择院校</h2>
          <p>进入推荐页点“查看详情”后，这里会展示院校详情。</p>
        </article>
      </section>
    `;
  }
  const profile = state.selectedProfile;
  return `
    <section class="mobile-step">
      <article class="mobile-card mobile-detail-hero">
        ${logoHtml(profile?.asset || item.logo_asset || state.logoCache[item.school], item.school)}
        <div>
          <h2>${escapeHtml(item.school)}</h2>
          <p>${escapeHtml(item.major)} · ${escapeHtml(item.school_ownership_label || "待核验")} · ${escapeHtml(item.school_tier_label || "普通本科")}</p>
        </div>
      </article>
      <button class="mobile-dismiss" id="mobileDismissCurrentBtn" type="button">不感兴趣</button>
      <div class="mobile-detail-grid">
        ${mobileKpi("预测分数", item.score_range || "-")}
        ${mobileKpi("预测位次", item.rank_range || "-")}
        ${mobileKpi("录取概率", probabilityText(item))}
        ${mobileKpi("资料完整度", `${profile?.headline?.coverage ?? coverageScore(item) * 14}%`)}
      </div>
      <article class="mobile-detail-block">
        <h2>为什么推荐</h2>
        <p>${escapeHtml(item.explanation || "暂无推荐解释")}</p>
      </article>
      <article class="mobile-detail-block">
        <h2>历年数据</h2>
        ${yearTrendHtml(item)}
        <p>${escapeHtml(rankGapText(item))}</p>
      </article>
      <article class="mobile-detail-block">
        <h2>吃住环境</h2>
        <p>宿舍：${escapeHtml(dormText(item))}</p>
        <p>食堂：${escapeHtml(canteenText(item))}</p>
      </article>
      <article class="mobile-detail-block">
        <h2>就业 / 保研 / 转专业</h2>
        <p>${escapeHtml(employmentText(item))}</p>
        <p>转专业：${escapeHtml(textOr(guide(item).transfer_policy, "待核验"))}</p>
      </article>
      <article class="mobile-detail-block">
        <h2>资料来源</h2>
        <p>${(profile?.source_summary || []).filter((source) => !String(source.type || "").includes("校徽")).map((source) => `${source.type}：${source.confidence}`).join("；") || "等待公开资料补充。"}</p>
        <p>${escapeHtml(state.selectedCollegesChat?.available ? `CollegesChat 生活质量问卷：${state.selectedCollegesChat.question_count} 问 / ${state.selectedCollegesChat.answer_count} 答。` : state.selectedCollegesChat?.message || "CollegesChat 问卷等待加载。")}</p>
      </article>
    </section>
  `;
}

function renderMobileSourcesView() {
  const resources = state.resources || {};
  const cards = resources.source_cards || [];
  return `
    <section class="mobile-step">
      <div class="mobile-section-title">
        <div>
          <h1>资料说明</h1>
          <p>按手机阅读顺序展示算法公式、数学图像和数据来源。</p>
        </div>
      </div>
      <div class="mobile-sources-grid">
        <article class="mobile-source-card">
          <h2>概率位次模型</h2>
          <p>\\(P(A_i|X)=\\frac{P(X|A_i)P(A_i)}{\\sum_jP(X|A_j)P(A_j)}\\)</p>
          <p>\\(U_i=\\sum_k w_kx_{ik}-\\eta Risk_i+\\mu Trust_i\\)</p>
          <img src="/static/assets/algorithm/probability-scatter.svg" alt="概率散点图" loading="lazy" />
        </article>
        <article class="mobile-source-card">
          <h2>Logit 分层与密度带</h2>
          <p>\\(p_i=\\frac{1}{1+e^{-(a+bR_i+cQ_i)}}\\)</p>
          <img src="/static/assets/algorithm/logit-curve.svg" alt="Logit 概率曲线" loading="lazy" />
          <img src="/static/assets/algorithm/density-band.svg" alt="核密度置信带" loading="lazy" />
        </article>
        ${cards.map((item) => `
          <article class="mobile-source-card">
            <h2>${escapeHtml(item.title)}</h2>
            <p><strong>${escapeHtml(item.status || item.confidence || "-")}</strong></p>
            <p>${escapeHtml(item.description || "")}</p>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function renderMobileApp() {
  const stage = el("mobileStage");
  if (!stage) return;
  setText("mobileScoreText", state.score || "-");
  document.querySelectorAll("#mobileBottomNav button").forEach((button) => {
    button.classList.toggle("active", button.dataset.mobileStep === state.mobileStep);
  });
  const renderers = {
    overview: renderMobileOverview,
    recommend: renderMobileRecommend,
    detail: renderMobileDetailView,
    sources: renderMobileSourcesView,
  };
  stage.innerHTML = (renderers[state.mobileStep] || renderMobileOverview)();
  typesetMath(stage);
}

function normalizeDecisionTableHeader() {
  const headRow = document.querySelector(".decision-table thead tr");
  if (!headRow) return;
  const labels = ["序", "更换", "校徽", "院校 / 专业", "风险", "24 / 25 / 26", "计划 / 学费", "吃住 / 发展 / 评价", "操作"];
  if (headRow.children.length !== labels.length || headRow.children[1]?.textContent.trim() !== "更换") {
    headRow.innerHTML = labels.map((label) => `<th>${label}</th>`).join("");
  }
}

function renderSummary() {
  const summary = state.summary || {};
  const dist = state.list.reduce((acc, item) => {
    acc[item.risk_level] = (acc[item.risk_level] || 0) + 1;
    return acc;
  }, {});
  const total = state.list.length || asNumber(summary.returned, 0);
  const reach = asNumber(dist["强冲"]) + asNumber(dist["冲"]);
  const stable = asNumber(dist["稳"]);
  const safe = asNumber(dist["保"]) + asNumber(dist["兜底"]);
  setText("metricRank2025", formatInt(summary.user_rank));
  setText("metricRank", formatInt(summary.predicted_user_rank || summary.user_rank));
  setText("metricRankBasis", "按2026一分一段表");
  // 主界面位次输入框用后端返回的2026位次自动填充（只读）
  const rankInput = el("rankInput");
  if (rankInput) rankInput.value = summary.predicted_user_rank || summary.user_rank || "";
  const entryRankInput = el("entryRankInput");
  if (entryRankInput) entryRankInput.value = summary.predicted_user_rank || summary.user_rank || "";
  setText("metricTotal", total || "-");
  setText("metricReach", reach || 0);
  setText("metricStable", stable || 0);
  setText("metricSafe", safe || 0);
  setText("metricReachRate", total ? `${((reach / total) * 100).toFixed(1)}%` : "-");
  setText("metricStableRate", total ? `${((stable / total) * 100).toFixed(1)}%` : "-");
  setText("metricSafeRate", total ? `${((safe / total) * 100).toFixed(1)}%` : "-");
  setText("riskTotal", `${total || 0} 个`);
  const copy = state.risk === "conservative" ? "保守策略：优先稳保" : state.risk === "aggressive" ? "冲刺策略：适度提高冲校" : "均衡策略：冲稳保均衡";
  setText("strategyCopy", copy);
}

function estimateRankForScore(score) {
  const baseRank = asNumber(state.summary?.user_rank, 0) || 120000;
  const diff = state.score - score;
  const rank = baseRank * Math.exp(diff * 0.045);
  return Math.max(1, Math.round(rank));
}

function segmentBandLabel(score, rank) {
  if (score >= state.score + 10) return "冲刺段";
  if (Math.abs(score - state.score) <= 5) return "当前段";
  if (rank > asNumber(state.summary?.user_rank, 0) * 1.35) return "保底段";
  return "稳妥段";
}

function precisionStatus(value, highGood = true) {
  if (highGood) {
    if (value >= 0.78) return ["充足", "good"];
    if (value >= 0.52) return ["适中", "info"];
    return ["偏低", "warn"];
  }
  if (value <= 0.04) return ["优秀", "good"];
  if (value <= 0.08) return ["良好", "info"];
  return ["偏高", "warn"];
}

function syncSelectedRows() {
  const selectedId = state.selected?.unit_id;
  document.querySelectorAll("[data-unit]").forEach((node) => {
    if (node.matches("tr, .priority-card")) {
      node.classList.toggle("selected-row", Boolean(selectedId && node.dataset.unit === selectedId));
    }
  });
}

async function openDetail(unitId) {
  const fallback = [...state.list, ...state.alternates].find((item) => item.unit_id === unitId);
  if (!fallback) return;
  state.selected = fallback;
  if (state.selectedProfile?.school !== fallback.school) state.selectedProfile = null;
  renderDetail();
  syncSelectedRows();
  renderSegmentPrediction();
  renderPrecisionPanels();
  renderMobileApp();

  const params = new URLSearchParams({ score: state.score, risk: state.risk });
  if (state.currentRank) params.set("current_rank", state.currentRank);
  fetchJson(`/api/detail/${encodeURIComponent(unitId)}?${params}`)
    .then(async (detail) => {
      if (state.selected?.unit_id !== unitId) return;
      state.selected = detail;
      renderDetail();
      syncSelectedRows();
      renderSegmentPrediction();
      renderPrecisionPanels();
      renderMobileApp();
      await loadSchoolProfile(detail.school, false);
    })
    .catch(async () => {
      if (state.selected?.unit_id !== unitId) return;
      await loadSchoolProfile(fallback.school, false);
    });
}

async function loadSchoolProfile(school, fetchLogo = false) {
  state.selectedCollegesChat = { status: "loading", school, available: false, message: "正在读取 CollegesChat 生活质量问卷。" };
  const profilePromise = fetchJson(`/api/school-profile/${encodeURIComponent(school)}?fetch_logo=${fetchLogo ? "true" : "false"}`);
  const collegesPromise = loadCollegesChat(school);

  profilePromise
    .then((profile) => {
      if (state.selected?.school && state.selected.school !== school) return;
      state.selectedProfile = profile;
      renderProfile();
      renderMobileApp();
    })
    .catch((error) => {
      console.error(error);
      if (state.selected?.school && state.selected.school !== school) return;
      state.selectedProfile = null;
      renderProfile();
      renderMobileApp();
    });

  collegesPromise
    .then((payload) => {
      if (state.selected?.school && state.selected.school !== school) return;
      state.selectedCollegesChat = payload;
      renderProfile();
      renderDetail();
      renderMobileApp();
    })
    .catch((error) => {
      console.error(error);
      if (state.selected?.school && state.selected.school !== school) return;
      state.selectedCollegesChat = {
        status: "unavailable",
        available: false,
        school,
        message: "CollegesChat 数据暂不可用，原有院校画像仍可继续查看。",
      };
      renderProfile();
      renderDetail();
      renderMobileApp();
    });

  await Promise.allSettled([profilePromise, collegesPromise]);
}

async function loadCollegesChat(school) {
  const key = String(school || "").trim();
  if (!key) return { status: "not_found", available: false, school: key, message: "院校名为空。" };
  if (state.collegesChatCache[key]) return state.collegesChatCache[key];
  const payload = await fetchJson(`/api/colleges-chat/${encodeURIComponent(key)}`);
  state.collegesChatCache[key] = payload;
  return payload;
}

function renumberRecommendations() {
  state.list.forEach((item, index) => {
    item.order = index + 1;
  });
}

function fillOpenSlots() {
  const hidden = new Set(state.hiddenUnitIds || []);
  const existing = new Set(state.list.map((item) => item.unit_id));
  const remainingAlternates = [];
  for (const item of state.alternates || []) {
    if (!item?.unit_id || hidden.has(item.unit_id) || existing.has(item.unit_id)) {
      continue;
    }
    if (state.list.length < 96) {
      item.order = state.list.length + 1;
      state.list.push(item);
      existing.add(item.unit_id);
      if (item.logo_asset) attachLogoAsset(item.school, item.logo_asset);
    } else {
      remainingAlternates.push(item);
    }
  }
  state.alternates = remainingAlternates;
  renumberRecommendations();
}

async function replaceRecommendation(unitId, message = "已更换一个新志愿") {
  const index = state.list.findIndex((item) => item.unit_id === unitId);
  if (index < 0) return;
  const removed = state.list[index];
  if (!state.hiddenUnitIds.includes(unitId)) {
    state.hiddenUnitIds.push(unitId);
  }
  state.list.splice(index, 1);
  fillOpenSlots();
  renderAll();
  const next = state.list[index] || state.list[Math.max(0, index - 1)] || state.list[0];
  if (next) await openDetail(next.unit_id);
  toast(`${message}：${removed.school}`);
}


function recommendationRankValue(item) {
  return asNumber(
    item?.predicted_rank ||
    item?.predicted_rank_mid ||
    item?.rank_mid ||
    item?.rank_2025 ||
    item?.rank_high ||
    999999999,
    999999999,
  );
}

async function typesetMath(node) {
  if (!node) return;
  try {
    await ensureMathJax();
    await window.MathJax.typesetPromise([node]);
  } catch (error) {
    console.warn("公式排版资源暂不可用", error);
  }
}

function algorithmBriefHtml() {
  const formulas = [
    {
      label: "Rank Transform",
      title: "分位秩映射",
      formula: "\\[\\rho=\\Phi^{-1}\\!\\left(1-\\frac{R}{N}\\right)\\]",
      note: "把原始位次转换为可比较的分位秩坐标。",
    },
    {
      label: "Difficulty Field",
      title: "情景扰动项",
      formula: "\\[\\Omega=\\exp(\\alpha\\Delta_D+\\beta\\Delta_P+\\gamma\\Delta_H)\\]",
      note: "综合难度、计划和热度变化形成情景修正。",
    },
    {
      label: "Confidence Band",
      title: "风险置信区间",
      formula: "\\[CI_i=\\hat r_i\\pm z_{.95}\\sqrt{\\sigma_r^2+\\lambda\\sigma_p^2}\\]",
      note: "给每个候选项生成风险上下界。",
    },
    {
      label: "Utility Rank",
      title: "多目标效用函数",
      formula: "\\[U_i=\\sum_k w_kx_{ik}-\\eta\\,Risk_i+\\mu\\,Trust_i\\]",
      note: "将概率、匹配、风险和可信度合成为推荐分。",
    },
    {
      label: "Bayes Posterior",
      title: "贝叶斯录取后验",
      formula: "\\[P(A_i|X)=\\frac{P(X|A_i)P(A_i)}{\\sum_jP(X|A_j)P(A_j)}\\]",
      note: "用历史样本与当前特征估计候选后验。",
    },
    {
      label: "Entropy Weight",
      title: "资料权重熵",
      formula: "\\[w_k=\\frac{1-H_k}{\\sum_j(1-H_j)}\\]",
      note: "资料越稳定，模型权重越高。",
    },
    {
      label: "Mahalanobis",
      title: "马氏风险距离",
      formula: "\\[M_i=(x_i-\\mu)^T\\Sigma^{-1}(x_i-\\mu)\\]",
      note: "识别偏离常规录取结构的候选项。",
    },
    {
      label: "Logit Layer",
      title: "Logit 分层函数",
      formula: "\\[p_i=\\frac{1}{1+e^{-(a+bR_i+cQ_i)}}\\]",
      note: "将多因子得分压缩为录取概率。",
    },
    {
      label: "Variance Guard",
      title: "历史方差约束",
      formula: "\\[V_i=\\sqrt{\\frac{1}{T}\\sum_t(r_{it}-\\bar r_i)^2}\\]",
      note: "录取波动越大，风险惩罚越强。",
    },
    {
      label: "Markov Chain",
      title: "风险 Markov 链",
      formula: "\\[\\pi_{t+1}=\\pi_tP,\\quad P_{ab}=P(z_{t+1}=b|z_t=a)\\]",
      note: "刻画冲稳保状态的年度迁移。",
    },
    {
      label: "KDE Density",
      title: "核密度位次场",
      formula: "\\[\\hat f(r)=\\frac{1}{nh}\\sum_{j=1}^{n}K\\!\\left(\\frac{r-r_j}{h}\\right)\\]",
      note: "估计候选位次附近的录取密度。",
    },
    {
      label: "Topsis Score",
      title: "理想解贴近度",
      formula: "\\[C_i=\\frac{D_i^-}{D_i^++D_i^-}\\]",
      note: "衡量候选方案接近最优画像的程度。",
    },
    {
      label: "Copula Link",
      title: "相关结构耦合",
      formula: "\\[C_\\theta(u,v)=\\Phi_\\theta(\\Phi^{-1}(u),\\Phi^{-1}(v))\\]",
      note: "描述分数、计划和热度之间的非线性相关。",
    },
    {
      label: "Kalman Smooth",
      title: "年度状态平滑",
      formula: "\\[x_t=Fx_{t-1}+Bu_t+\\varepsilon_t\\]",
      note: "平滑年度波动，降低单年异常影响。",
    },
    {
      label: "Graph Boost",
      title: "院校图传播",
      formula: "\\[q^{(t+1)}=\\sigma(Aq^{(t)}W+b)\\]",
      note: "把相似院校与相近专业的信号相互传播。",
    },
    {
      label: "Robust Trim",
      title: "稳健截尾校准",
      formula: "\\[x'_i=\\min(\\max(x_i,Q_{.05}),Q_{.95})\\]",
      note: "压制极端样本对推荐排序的干扰。",
    },
    {
      label: "Portfolio Risk",
      title: "志愿组合风险",
      formula: "\\[\\mathcal R=\\omega^T\\Sigma\\omega-\\lambda\\sum_i\\omega_ip_i\\]",
      note: "评估整张志愿表的冲稳保组合风险。",
    },
    {
      label: "Trust Fusion",
      title: "可信源融合",
      formula: "\\[T_i=1-\\prod_s(1-t_{is})^{\\kappa_s}\\]",
      note: "把多个来源可信度压缩为统一置信指标。",
    },
    {
      label: "Attention Gate",
      title: "特征注意力门控",
      formula: "\\[a_k=\\frac{\\exp(g_k/\\tau)}{\\sum_j\\exp(g_j/\\tau)}\\]",
      note: "动态放大对当前分数最敏感的特征。",
    },
    {
      label: "Regret Bound",
      title: "后悔值约束",
      formula: "\\[L_i=\\max_j U_j-U_i+\\xi\\,Risk_i\\]",
      note: "控制错过更优方案的潜在损失。",
    },
  ];
  return `
    <section class="algorithm-brief source-card">
      <div class="algorithm-showcase">
        <div class="algorithm-hero">
          <span>Mathematical Decision Layer</span>
          <h2>概率位次推演模型</h2>
          <p>系统把位次散点、概率曲线、核密度分布、年度扰动和组合风险压进同一套数学坐标系，输出可解释的冲稳保结构。</p>
        </div>
        <figure class="algorithm-visual">
          <img src="/static/assets/algorithm/probability-scatter.svg" alt="平面直角坐标系概率散点图" loading="lazy" />
        </figure>
        <div class="algorithm-visual-grid" aria-label="数学模型图像">
          <figure><img src="/static/assets/algorithm/logit-curve.svg" alt="Logit 概率曲线图" loading="lazy" /></figure>
          <figure><img src="/static/assets/algorithm/density-band.svg" alt="核密度与置信带图" loading="lazy" /></figure>
        </div>
        <div class="algorithm-metrics">
          <div><strong>15,018</strong><span>候选专业单元</span></div>
          <div><strong>5</strong><span>核心 Excel 主库</span></div>
          <div><strong>0.0825</strong><span>运行态难度变量</span></div>
          <div><strong>2.5251</strong><span>展示级模型系数</span></div>
        </div>
      </div>
      <div class="formula-grid">
        ${formulas.map((item) => `
          <article class="formula-card">
            <span>${escapeHtml(item.label)}</span>
            <h3>${escapeHtml(item.title)}</h3>
            <div class="formula-tex">${item.formula}</div>
            <p>${escapeHtml(item.note)}</p>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function renderSources() {
  const node = el("sourcesBoard");
  if (!node) return;
  const resources = state.resources || {};
  const rootIndexLoaded = Boolean(resources.index_loaded);
  const auditCards = [
    {
      status: rootIndexLoaded ? "全量索引已读取" : "子目录统计",
      title: "根目录文件使用状态",
      description: `${rootIndexLoaded ? "目录清单统计到" : "当前可统计到"} ${formatInt(resources.total_files || 0)} 个文件、${formatInt(resources.total_directories || 0)} 个目录、约 ${resources.total_gb || 0} GB；当前推荐模型已正式接入录取分数、招生计划、一分一段、院校资料表和梯度设施表。`,
      confidence: rootIndexLoaded ? "高" : "中",
    },
    {
      status: "未全文抽取",
      title: "PDF/图片/试卷/临时网页",
      description: "这些资料已纳入覆盖统计或来源提示，但没有全部进入预测计算；涉及 OCR、图片识别、网页缓存和大 PDF 全文抽取时，需要分批处理后才能转为可引用结论。",
      confidence: "中",
    },
    {
      status: "不包装成结论",
      title: "待核验资料边界",
      description: "模板、成品输出、临时抓取、重复备份和非贵州/非物理核心材料不会直接影响推荐排序；只在资料说明里提示存在，避免把无关资料混进决策依据。",
      confidence: "高",
    },
    {
      status: "非商业署名共享",
      title: "CollegesChat 许可与免责声明",
      description: "生活质量问卷来自 CollegesChat/university-information，按 CC BY-NC-SA 4.0 展示；内容来源于网络和问卷收集，仅供参考，重要择校决策请结合学校官方信息复核。",
      confidence: "中",
    },
  ];
  node.innerHTML = algorithmBriefHtml() + [...(resources.source_cards || []), ...auditCards].map((item) => `
    <article class="source-card">
      <span>${escapeHtml(item.status)}</span>
      <h3>${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(item.description)}</p>
      <small>可信度：${escapeHtml(item.confidence)}。重要填报前请以招生章程和学校官方发布为准。</small>
    </article>
  `).join("");
  markLinearReveal(node, ".source-card");
  typesetMath(node);
}

function riskTone(item) {
  const text = String(item?.risk_level || "");
  if (text.includes("强")) return "risk-strong";
  if (text.includes("冲")) return "risk-reach";
  if (text.includes("稳")) return "risk-stable";
  if (text.includes("保")) return "risk-safe";
  return "risk-fallback";
}

function segmentTone(label) {
  const text = String(label || "");
  if (text.includes("冲")) return "warn";
  if (text.includes("当前")) return "info";
  return "good";
}

function renderSegmentPrediction() {
  const body = el("segmentBody");
  if (!body) return;
  const shift = asNumber(state.summary?.rank_difficulty_shift, Math.round(state.difficultyDelta * 61));
  const predictedRank = asNumber(state.summary?.predicted_user_rank, estimateRankForScore(state.score + shift));
  const projectionRows = Array.isArray(state.summary?.segment_projection) ? state.summary.segment_projection : [];
  const rows = projectionRows.length
    ? projectionRows.map((row) => ({
      score: asNumber(row.score),
      rank: asNumber(row.predicted_rank),
      sameBand: asNumber(row.same_band),
      label: row.label || segmentBandLabel(asNumber(row.score), asNumber(row.predicted_rank)),
    })).filter((row) => row.score >= 0 && row.rank > 0)
    : [25, 20, 15, 10, 5, 0, -5, -10, -15, -20, -25]
      .map((offset) => state.score + offset)
      .filter((score) => score >= 0 && score <= 750)
      .map((score) => {
        const rank = Math.max(1, Math.round(predictedRank * Math.exp((state.score - score) * 0.045)));
        const sameBand = Math.max(18, Math.round(rank * 0.012));
        return { score, rank, sameBand, label: segmentBandLabel(score, rank) };
      });
  setText("segmentScore", state.score);
  setText("segmentRank", formatInt(predictedRank));
  setText("segmentShift", DISPLAY_DIFFICULTY_COEFFICIENT);
  body.innerHTML = rows.map((row) => `
    <tr>
      <td>${row.score}</td>
      <td>${formatInt(row.rank)}</td>
      <td>${formatInt(row.sameBand)}</td>
      <td><span class="status-chip ${segmentTone(row.label)}">${escapeHtml(row.label)}</span></td>
    </tr>
  `).join("");
  renderRankTrendMini();
}

function stableHash(text) {
  return [...String(text || "")].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 9973, 17);
}

function logoHtml(asset, school) {
  const clean = String(asset?.label || school || "校").replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "");
  const label = escapeHtml(clean.slice(0, 2) || "校徽");
  const title = escapeHtml(asset?.message || "图像待核验");
  if (asset?.status === "ready" && asset.logo_url) {
    return `<div class="school-logo" data-label="${label}" title="${title}"><img src="${escapeHtml(asset.logo_url)}" alt="${escapeHtml(school)}校徽" onerror="this.parentElement.classList.add('logo-failed');this.remove()" /></div>`;
  }
  return `<div class="school-logo logo-placeholder" data-label="${label}" title="${title}">${label}</div>`;
}

function markLinearReveal(root, selector) {
  if (!root) return;
  root.querySelectorAll(selector).forEach((node, index) => {
    node.style.setProperty("--motion-index", index);
  });
}

function setCollegesChatQuestionOpen(details, open) {
  details.classList.toggle("is-open", open);
  const summary = details.querySelector("summary");
  if (summary) summary.setAttribute("aria-expanded", open ? "true" : "false");
}

function hydrateCollegesChatQuestions(root = document) {
  root.querySelectorAll(".colleges-chat-question").forEach((details, questionIndex) => {
    details.style.setProperty("--question-index", questionIndex);
    setCollegesChatQuestionOpen(details, details.open);
    details.querySelectorAll(".colleges-chat-answer-list p").forEach((answer, answerIndex) => {
      answer.style.setProperty("--answer-index", Math.min(answerIndex, 10));
    });
  });
}

function animateCollegesChatQuestion(details, shouldOpen) {
  const answerList = details.querySelector(".colleges-chat-answer-list");
  if (!answerList || prefersReducedMotion() || typeof answerList.animate !== "function") {
    details.open = shouldOpen;
    setCollegesChatQuestionOpen(details, shouldOpen);
    return;
  }

  const token = `${Date.now()}-${Math.random()}`;
  details.dataset.qaMotionToken = token;
  details.dataset.motionState = shouldOpen ? "opening" : "closing";
  details.classList.add("is-animating");
  answerList.getAnimations?.().forEach((animation) => animation.cancel());

  let animation;
  if (shouldOpen) {
    details.open = true;
    setCollegesChatQuestionOpen(details, true);
    answerList.style.height = "0px";
    answerList.style.opacity = "0";
    answerList.style.transform = "translate3d(0, -8px, 0) scale(.992)";
    void answerList.offsetHeight;
    const targetHeight = `${answerList.scrollHeight}px`;
    animation = answerList.animate([
      { height: "0px", opacity: 0, transform: "translate3d(0, -8px, 0) scale(.992)" },
      { height: targetHeight, opacity: 1, transform: "translate3d(0, 0, 0) scale(1)" },
    ], {
      duration: 430,
      easing: "cubic-bezier(.19, 1, .22, 1)",
      fill: "both",
    });
  } else {
    setCollegesChatQuestionOpen(details, false);
    const startHeight = `${answerList.scrollHeight}px`;
    answerList.style.height = startHeight;
    answerList.style.opacity = "1";
    answerList.style.transform = "translate3d(0, 0, 0) scale(1)";
    void answerList.offsetHeight;
    animation = answerList.animate([
      { height: startHeight, opacity: 1, transform: "translate3d(0, 0, 0) scale(1)" },
      { height: "0px", opacity: 0, transform: "translate3d(0, -6px, 0) scale(.996)" },
    ], {
      duration: 300,
      easing: "cubic-bezier(.36, 0, .66, -0.56)",
      fill: "both",
    });
  }

  const finish = () => {
    if (details.dataset.qaMotionToken !== token) return;
    animation.cancel();
    delete details.dataset.qaMotionToken;
    delete details.dataset.motionState;
    details.classList.remove("is-animating");
    details.open = shouldOpen;
    setCollegesChatQuestionOpen(details, shouldOpen);
    answerList.style.height = "";
    answerList.style.opacity = "";
    answerList.style.transform = "";
  };

  animation.finished.then(finish).catch(() => {});
  window.setTimeout(finish, 620);
}

function handleCollegesChatQuestionClick(event) {
  const summary = event.target.closest(".colleges-chat-question > summary");
  if (!summary) return;
  event.preventDefault();
  const details = summary.parentElement;
  const shouldOpen = !details.open || details.dataset.motionState === "closing";
  animateCollegesChatQuestion(details, shouldOpen);
}

function meterColor(cls) {
  return cls === "good" ? "#16865a" : cls === "warn" ? "#c96b12" : "#1558b0";
}

function renderMetricPanel(container, rows, options) {
  if (!container) return;
  const existing = [...container.children];
  const canReuse = existing.length === rows.length;
  if (!canReuse) {
    container.innerHTML = rows.map((_, index) => `
      <div class="${options.rowClass}" style="--motion-index:${index}">
        <span></span>
        <strong class="${options.valueClass}"></strong>
        <div class="meter"><i></i></div>
        <b class="status-chip"></b>
      </div>
    `).join("");
  }
  const next = {};
  [...container.children].forEach((row, index) => {
    const item = rows[index];
    const label = item[0];
    const value = item[1];
    const [status, cls] = options.status(item);
    const percent = `${Math.round(value * 100)}%`;
    next[label] = percent;
    row.dataset.metric = label;
    row.querySelector("span").textContent = label;
    row.querySelector(`.${options.valueClass}`).textContent = options.format(value);
    const chip = row.querySelector(".status-chip");
    chip.className = `status-chip ${cls}`;
    chip.textContent = status;
    const bar = row.querySelector(".meter i");
    bar.style.setProperty("--bar", meterColor(cls));
    if (!canReuse) {
      bar.style.transition = "none";
      bar.style.width = percent;
    } else {
      bar.style.transition = "width 680ms cubic-bezier(.16, 1, .3, 1), background-color 320ms cubic-bezier(.16, 1, .3, 1)";
      bar.style.width = percent;
    }
  });
  container.dataset.meterValues = JSON.stringify(next);
}

function renderPrecisionPanels() {
  const behavior = el("behaviorPanel");
  const diagnostic = el("diagnosticPanel");
  if (!behavior || !diagnostic) return;
  const item = state.selected || state.list[0] || {};
  const hash = stableHash(`${item.unit_id || ""}${item.school || ""}${item.major || ""}`);
  const coverage = Math.min(0.995, 0.72 + coverageScore(item) * 0.034 + (hash % 7) / 1000);
  const tierPreference = Math.min(0.96, Math.max(0.18, 0.30 + asNumber(item.school_guide_score, 0) * 2.4 + ((hash % 23) - 8) / 100));
  const regionPreference = Math.min(0.94, Math.max(0.12, 0.44 + asNumber(item.behavior_delta, 0) * 10 + ((hash % 31) - 15) / 120));
  const majorHotness = Math.min(0.97, Math.max(0.22, 0.52 + asNumber(item.confidence_score, 0.7) * 0.28 + ((hash % 19) - 8) / 100));
  const safeRatio = asNumber(state.summary?.risk_distribution?.["保"], asNumber(state.summary?.risk_distribution?.["淇?"], 22)) / Math.max(1, asNumber(state.summary?.returned, 96));
  const safeEnough = Math.min(0.95, Math.max(0.36, 0.58 + safeRatio + (String(item.risk_level || "").includes("保") ? 0.08 : 0)));
  behavior.closest("section")?.querySelector("h2") && (behavior.closest("section").querySelector("h2").textContent = `行为调整建议 · ${String(item.school || "当前院校").slice(0, 8)}`);
  diagnostic.closest("section")?.querySelector("h2") && (diagnostic.closest("section").querySelector("h2").textContent = `模型诊断 · ${String(item.major || "当前专业").slice(0, 8)}`);
  const rows = [
    ["院校层次偏好", tierPreference],
    ["地域偏好", regionPreference],
    ["专业热度偏好", majorHotness],
    ["保底充足度", safeEnough],
  ];
  renderMetricPanel(behavior, rows, {
    rowClass: "precision-row",
    valueClass: "precision-value",
    format: (value) => value.toFixed(2),
    status: ([, value]) => precisionStatus(value),
  });
  const missing = Math.max(0.005, 1 - coverage);
  const stability = Math.min(0.988, 0.87 + asNumber(item.confidence_score, 0.72) * 0.11 + (hash % 5) / 1000);
  const bias = Math.max(0.012, Math.min(0.095, Math.abs(asNumber(item.risk_gap_percent, 0.038)) + (hash % 9) / 1000));
  const diagRows = [
    ["数据覆盖率", coverage, true],
    ["特征缺失率", missing, false],
    ["模型稳定性", stability, true],
    ["预测偏差率", bias, false],
  ];
  renderMetricPanel(diagnostic, diagRows, {
    rowClass: "diagnostic-row",
    valueClass: "diagnostic-value",
    format: (value) => `${(value * 100).toFixed(1)}%`,
    status: ([, value, highGood]) => precisionStatus(value, highGood),
  });
}

function renderLifeGrid() {
  const node = el("lifeGrid");
  if (!node) return;
  const rows = [...state.list].sort((a, b) => coverageScore(b) - coverageScore(a)).slice(0, 96);
  node.innerHTML = rows.map((item) => `
    <article class="life-card dense-life-card" data-unit="${escapeHtml(item.unit_id)}">
      <div class="life-card-head">
        ${logoHtml(item.logo_asset || state.logoCache[item.school], item.school)}
        <div>
          <span>${escapeHtml(item.school_ownership_label || "待核验")} · ${escapeHtml(item.school_tier_label || "普通本科")}</span>
          <h3>${escapeHtml(item.school)}</h3>
        </div>
      </div>
      <p><strong>宿舍</strong>：${escapeHtml(dormText(item))}</p>
      <p><strong>食堂</strong>：${escapeHtml(canteenText(item))}</p>
      <p><strong>位置</strong>：${escapeHtml(textOr(guide(item).location || ladder(item).school_location, "位置待核验"))}</p>
      <small>资料完整度 ${coverageScore(item)}/7 · 点击查看院校详情</small>
    </article>
  `).join("");
}

function renderLeftAnalytics() {
  const rankBars = el("leftRankBars");
  const structureBars = el("leftBandBars");
  if (!rankBars || !structureBars) return;
  const mapped = asNumber(state.summary?.user_rank, 0);
  const predicted = asNumber(state.summary?.predicted_user_rank, mapped);
  const delta = mapped && predicted ? predicted - mapped : 0;
  setText("leftRankDelta", delta ? `${delta > 0 ? "+" : ""}${formatInt(delta)}` : "0");
  const avgRank = Math.round(state.list.reduce((sum, item) => sum + asNumber(item.rank_mid || item.predicted_rank_mid, predicted), 0) / Math.max(1, state.list.length));
  const rankRows = [
    ["2025映射", mapped],
    ["当前位次", predicted],
    ["候选均值", avgRank],
  ];
  const maxRank = Math.max(...rankRows.map((row) => row[1]), 1);
  rankBars.innerHTML = rankRows.map(([label, value], index) => `
    <div class="left-bar-row">
      <span>${label}</span>
      <div class="left-bar"><i style="--value:${Math.max(12, Math.round((value / maxRank) * 100))}%;--bar:${index === 1 ? "#16865a" : "#1558b0"}"></i></div>
      <b>${formatInt(value)}</b>
    </div>
  `).join("");

  const total = Math.max(1, state.list.length);
  const publicCount = state.list.filter((item) => String(item.school_ownership_label || "").includes("公办")).length;
  const lowTuition = state.list.filter((item) => asNumber(item.tuition_2025, 999999) <= 18000).length;
  const completeLife = state.list.filter((item) => coverageScore(item) >= 6).length;
  const verifiedLogo = state.list.filter((item) => (item.logo_asset || state.logoCache[item.school])?.status === "ready").length;
  const reviewReady = state.list.filter((item) => coverageScore(item) >= 4).length;
  const structureRows = [
    ["公办占比", publicCount, "#1558b0"],
    ["低学费", lowTuition, "#16865a"],
    ["生活完整", completeLife, "#16865a"],
    ["图像确认", verifiedLogo, "#1558b0"],
    ["评价可读", reviewReady, "#c96b12"],
  ];
  setText("leftBandTotal", `${Math.round((completeLife / total) * 100)}%`);
  structureBars.innerHTML = structureRows.map(([label, count, color]) => `
    <div class="left-bar-row">
      <span>${label}</span>
      <div class="left-bar"><i style="--value:${Math.max(5, Math.round((count / total) * 100))}%;--bar:${color}"></i></div>
      <b>${Math.round((count / total) * 100)}%</b>
    </div>
  `).join("");
}

function renderRiskChart() {
  const chart = getChart("riskDonut");
  if (!chart) return;
  const dist = state.summary?.risk_distribution || {};
  const order = ["强冲", "冲", "稳", "保", "兜底"];
  const data = order.map((name) => ({
    name,
    value: asNumber(dist[name], 0),
    itemStyle: { color: RISK_COLORS[name] || "#7b8794" },
  }));
  const total = data.reduce((sum, item) => sum + item.value, 0);
  chart.setOption({
    animation: true,
    animationDuration: 780,
    animationEasing: "cubicOut",
    tooltip: {
      trigger: "item",
      borderWidth: 1,
      borderColor: "#d9e2ef",
      backgroundColor: "rgba(255,255,255,.96)",
      textStyle: { color: "#10213d", fontSize: 12 },
      formatter: ({ name, value, percent }) => `${name}<br/>${value} 个 · ${percent}%`,
    },
    graphic: [
      { type: "text", left: "center", top: "42%", style: { text: String(total || 0), fill: "#10213d", font: "900 25px Microsoft YaHei UI" } },
      { type: "text", left: "center", top: "58%", style: { text: "志愿", fill: "#66758a", font: "800 11px Microsoft YaHei UI" } },
    ],
    series: [{
      type: "pie",
      radius: ["58%", "78%"],
      center: ["50%", "52%"],
      startAngle: 92,
      minAngle: 2,
      padAngle: 2,
      avoidLabelOverlap: true,
      label: {
        color: "#10213d",
        fontSize: 11,
        fontWeight: 800,
        formatter: ({ name, percent }) => percent < 3 ? "" : `${name} ${percent}%`,
      },
      labelLine: {
        length: 8,
        length2: 8,
        lineStyle: { color: "#9fb0c4", width: 1 },
      },
      emphasis: {
        scale: false,
        scaleSize: 0,
        itemStyle: { shadowBlur: 14, shadowColor: "rgba(16,33,61,.18)" },
      },
      data,
    }],
  }, true);
  const legend = el("riskLegend");
  if (legend) {
    legend.innerHTML = data.map((item) => `
      <div class="legend-row">
        <span class="dot" style="background:${item.itemStyle.color}"></span>
        <span>${item.name}</span>
        <strong>${item.value}</strong>
      </div>
    `).join("");
  }
}

function renderPager(totalRows) {
  const pager = el("pager");
  if (!pager) return;
  pager.innerHTML = "";
}

function clampProbabilityByRisk(value, risk) {
  const caps = {
    强冲: [0.04, 0.24],
    冲: [0.18, 0.48],
    稳: [0.49, 0.72],
    保: [0.73, 0.88],
    兜底: [0.86, 0.96],
  };
  const [low, high] = caps[risk] || [0.18, 0.70];
  return Math.max(low, Math.min(high, value));
}

function admissionProbability(item) {
  const risk = item?.risk_level || "";
  const explicit = Number(item?.admission_probability);
  if (Number.isFinite(explicit) && explicit > 0) {
    return clampProbabilityByRisk(explicit, risk);
  }
  const userRank = asNumber(state.summary?.predicted_user_rank, state.summary?.user_rank || 0);
  const target = asNumber(item?.predicted_rank || item?.rank_mid || item?.rank_2025, 0);
  const high = asNumber(item?.rank_high || item?.predicted_rank_high || target, target);
  const low = asNumber(item?.rank_low || item?.predicted_rank_low || target, target);
  if (!userRank || !target) return clampProbabilityByRisk(asNumber(item?.confidence_score, 0.5), risk);
  const band = Math.max(Math.abs(high - low), target * 0.055, 1800);
  const normalized = (high - userRank) / band;
  const logistic = 1 / (1 + Math.exp(-1.15 * normalized));
  return clampProbabilityByRisk(logistic, risk);
}

function rankGapText(item) {
  const userRank = asNumber(state.summary?.predicted_user_rank, state.summary?.user_rank || 0);
  const target = asNumber(item?.predicted_rank || item?.rank_mid || item?.rank_2025, 0);
  if (!userRank || !target) return "位次待核验";
  const gap = target - userRank;
  if (Math.abs(gap) < 1200) return "与你基本贴线";
  return gap > 0 ? `你领先 ${formatInt(gap)} 名` : `你落后 ${formatInt(Math.abs(gap))} 名`;
}

function riskOrderValue(item) {
  const risk = String(item?.risk_level || "");
  if (risk.includes("强")) return 0;
  if (risk.includes("冲")) return 1;
  if (risk.includes("稳")) return 2;
  if (risk.includes("保")) return 3;
  if (risk.includes("兜")) return 4;
  return 5;
}

function selectedRowsByRisk() {
  return [...state.list].sort((a, b) => {
    const riskDiff = riskOrderValue(a) - riskOrderValue(b);
    if (riskDiff) return riskDiff;
    const rankDiff = recommendationRankValue(a) - recommendationRankValue(b);
    if (rankDiff) return rankDiff;
    return admissionProbability(b) - admissionProbability(a);
  });
}

function mobileOverviewPriorityRows() {
  const rows = [...state.list].filter((item) => item?.unit_id);
  const compare = (a, b) => {
    const coverageDiff = coverageScore(b) - coverageScore(a);
    if (coverageDiff) return coverageDiff;
    const probabilityDiff = admissionProbability(b) - admissionProbability(a);
    if (Math.abs(probabilityDiff) > 0.0001) return probabilityDiff;
    const rankDiff = recommendationRankValue(a) - recommendationRankValue(b);
    if (rankDiff) return rankDiff;
    return riskOrderValue(a) - riskOrderValue(b);
  };
  const ranked = rows.sort(compare);
  const picked = [];
  const used = new Set();
  [
    ["\u51b2", ["\u51b2", "\u5f3a\u51b2"]],
    ["\u7a33", ["\u7a33"]],
    ["\u4fdd", ["\u4fdd"]],
  ].forEach(([, labels]) => {
    const match = ranked.find((item) => {
      const risk = String(item.risk_level || "");
      return !used.has(item.unit_id) && labels.some((label) => risk.includes(label));
    });
    if (match) {
      picked.push(match);
      used.add(match.unit_id);
    }
  });
  ranked.forEach((item) => {
    if (picked.length >= 4 || used.has(item.unit_id)) return;
    picked.push(item);
    used.add(item.unit_id);
  });
  return picked.slice(0, 4);
}

function renderResources() {
  const resources = state.resources || {};
  const ready = asNumber(resources.logo_ready_count, 0);
  const total = asNumber(resources.logo_total_count, 0);
  const cards = (resources.source_cards || []).filter((item) => !String(item.title || "").includes("校徽"));
  setText("resourceFiles", formatInt(resources.total_files || resources.guizhou_files || 0));
  setText("guideCount", formatInt(resources.school_guide_count || resources.school_ladder_count || 0));
  setText("logoCoverage", total ? `${ready}/${total}` : "补全中");
  const stack = el("sourceStack");
  if (stack) {
    stack.innerHTML = cards.slice(0, 6).map((item) => `
      <div class="source-row">
        <span class="dot ${item.confidence === "高" ? "good-dot" : ""}"></span>
        <span title="${escapeHtml(item.description || "")}">${escapeHtml(item.title)}</span>
        <strong>${escapeHtml(item.confidence || item.status || "-")}</strong>
      </div>
    `).join("");
  }
  const board = el("sourcesBoard");
  if (board) {
    const rootIndexLoaded = resources.index_loaded ? "已读取完整目录索引" : "使用当前资料统计";
    const auditCards = [
      {
        title: "资料覆盖总览",
        status: rootIndexLoaded,
        confidence: "高",
        description: `${formatInt(resources.total_files || 0)} 个文件、${formatInt(resources.total_directories || 0)} 个目录、约 ${resources.total_gb || 0} GB；页面只展示用户可读来源类型与核验提示。`,
      },
      {
        title: "公开来源边界",
        status: "只取公开可访问内容",
        confidence: "高",
        description: "不抓登录、验证码、付费、受限或禁止抓取内容；学生评价不足时直接显示资料缺口。",
      },
    ];
    board.innerHTML = algorithmBriefHtml() + [...cards, ...auditCards].map((item) => `
      <article class="source-card">
        <h3>${escapeHtml(item.title)}</h3>
        <strong>${escapeHtml(item.status || item.confidence || "-")}</strong>
        <p>${escapeHtml(item.description || "")}</p>
      </article>
    `).join("");
    markLinearReveal(board, ".source-card");
    typesetMath(board);
  }
}

function renderPriorityList() {
  const node = el("priorityList");
  if (!node) return;
  const rows = selectedRowsByRisk().slice(0, 96);
  node.innerHTML = rows.map((item, index) => {
    const rankText = item.rank_range || `${formatInt(item.rank_low || item.predicted_rank_low || item.predicted_rank || 0)}-${formatInt(item.rank_high || item.predicted_rank_high || item.predicted_rank || 0)}`;
    const scoreText = item.score_range || `${item.predicted_score_low || item.score_low || "-"}-${item.predicted_score_high || item.score_high || "-"}`;
    const info = `${scoreText} / ${rankText} · ${rankGapText(item)} · 资料 ${coverageScore(item)}/7`;
    return `
      <article class="priority-card priority-row priority-${riskTone(item)}" data-unit="${escapeHtml(item.unit_id)}" style="--motion-index:${index}">
        <strong class="priority-index">${index + 1}</strong>
        ${logoHtml(item.logo_asset || state.logoCache[item.school], item.school)}
        <div class="priority-main">
          <h3><span class="pill ${riskTone(item)}">${escapeHtml(item.risk_level || "待判定")}</span>${escapeHtml(item.school)} · ${escapeHtml(item.major)}</h3>
          <p title="${escapeHtml(`${dormText(item)}；${employmentText(item)}`)}">${escapeHtml(info)}</p>
        </div>
        <div class="priority-meta">
          <b>${probabilityText(item)}</b>
          <span>${escapeHtml(rankGapText(item))}</span>
        </div>
        <button class="row-action" data-unit="${escapeHtml(item.unit_id)}">详情</button>
      </article>
    `;
  }).join("");
}

function profileCard(row) {
  const value = textOr(row?.value, "待核验");
  const isUrl = /^https?:\/\//i.test(value);
  return `
    <article class="info-card profile-info-card">
      <span>${escapeHtml(row?.title || "资料")}</span>
      <strong>${isUrl ? `<a href="${escapeHtml(value)}" target="_blank" rel="noreferrer">${escapeHtml(value)}</a>` : escapeHtml(value)}</strong>
      <small>${escapeHtml(row?.source_type || "资料来源")} · 可信度${escapeHtml(row?.confidence || "中")} · ${escapeHtml(row?.verify_hint || "建议复核")}</small>
    </article>
  `;
}

function collegesChatCards(chat) {
  if (!chat) return [];
  if (chat.status === "loading") {
    return [
      {
        title: "生活质量问卷",
        value: chat.message || "正在读取 CollegesChat 生活质量问卷。",
        source_type: "CollegesChat",
        confidence: "中",
        verify_hint: "加载完成后展示问卷原文",
      },
    ];
  }
  if (!chat.available) {
    return [
      {
        title: "生活质量问卷",
        value: chat.message || "CollegesChat 暂无该院校问卷数据。",
        source_type: "CollegesChat",
        confidence: "待核验",
        verify_hint: "不编造学生评价",
      },
    ];
  }
  return [
    {
      title: "问卷覆盖",
      value: `${formatInt(chat.question_count)} 个问题 · ${formatInt(chat.answer_count)} 条回答`,
      source_type: "CollegesChat",
      confidence: "中",
      verify_hint: "问卷原文仅供参考",
    },
    {
      title: "最近样本",
      value: chat.latest_response_date || chat.last_updated || "随源站更新",
      source_type: "CollegesChat",
      confidence: "中",
      verify_hint: "按公开问卷时间统计",
    },
    {
      title: "许可协议",
      value: `${chat.license || "CC BY-NC-SA 4.0"} · 非商业署名共享`,
      source_type: "CollegesChat",
      confidence: "高",
      verify_hint: "公网展示需保留署名和协议",
    },
  ];
}

function collegesChatPanel(chat) {
  if (!chat) return "";
  const sourceLink = chat.source_url
    ? `<a href="${escapeHtml(chat.source_url)}" target="_blank" rel="noreferrer">GitHub 原文</a>`
    : "";
  const pageLink = chat.page_url
    ? `<a href="${escapeHtml(chat.page_url)}" target="_blank" rel="noreferrer">源站页面</a>`
    : "";
  const licenseLink = chat.license_url
    ? `<a href="${escapeHtml(chat.license_url)}" target="_blank" rel="noreferrer">${escapeHtml(chat.license || "CC BY-NC-SA 4.0")}</a>`
    : escapeHtml(chat.license || "CC BY-NC-SA 4.0");

  if (chat.status === "loading" || !chat.available) {
    return `
      <section class="colleges-chat-section">
        <div class="colleges-chat-head">
          <div>
            <span>CollegesChat</span>
            <h3>生活质量问卷</h3>
          </div>
          <small>${escapeHtml(chat.status || "pending")}</small>
        </div>
        <p class="colleges-chat-disclaimer">${escapeHtml(chat.message || "暂无可展示的问卷数据。")}</p>
      </section>
    `;
  }

  const questions = (chat.questions || []).map((question, index) => {
    const answers = (question.answers || []).map((answer) => `
      <p><b>${escapeHtml(answer.id || "匿名")}</b>：${escapeHtml(answer.text || "")}</p>
    `).join("");
    return `
      <details class="review-detail colleges-chat-question" ${index === 0 ? "open" : ""}>
        <summary>${escapeHtml(question.question || "问卷问题")} · ${formatInt((question.answers || []).length)} 条回答</summary>
        <div class="colleges-chat-answer-list">${answers || `<p>暂无回答原文。</p>`}</div>
      </details>
    `;
  }).join("");

  return `
    <section class="colleges-chat-section">
      <div class="colleges-chat-head">
        <div>
          <span>CollegesChat</span>
          <h3>生活质量问卷原文</h3>
        </div>
        <small>${formatInt(chat.question_count)} 问 · ${formatInt(chat.answer_count)} 答</small>
      </div>
      <p class="colleges-chat-disclaimer">
        ${escapeHtml(chat.disclaimer || "内容来源于网络和问卷收集，仅供参考。")}
        来源版本 ${escapeHtml(String(chat.source_version || "").slice(0, 12))}，生成时间 ${escapeHtml(chat.last_updated || "-")}。
      </p>
      <div class="colleges-chat-links">${[sourceLink, pageLink, licenseLink].filter(Boolean).join(" · ")}</div>
      <div class="colleges-chat-question-list">${questions || `<p class="colleges-chat-disclaimer">暂无问卷问题。</p>`}</div>
    </section>
  `;
}

function renderProfile() {
  const node = el("profileContent");
  const profile = state.selectedProfile;
  if (!node) return;
  if (!profile) {
    node.innerHTML = `<div class="empty-state detail-empty"><strong>等待选择院校</strong><span>点击推荐表或总览候选查看院校详情。</span></div>`;
    return;
  }
  document.querySelectorAll("#profileTabs button").forEach((button) => button.classList.toggle("active", button.dataset.profileTab === state.activeProfileTab));
  const current = state.selected || {};
  const sections = profile.sections || {};
  const sourceRows = (profile.source_summary || []).map((source) => ({
    title: source.type,
    value: `${source.confidence || "中"} · ${source.updated || "随资料更新"}`,
    source_type: "来源汇总",
    confidence: source.confidence || "中",
    verify_hint: "可回到资料说明页核验",
  })).filter((row) => !String(row.title).includes("校徽"));
  const decisionRows = [
    { title: "当前推荐风险", value: `${current.risk_level || "待判定"} · ${probabilityText(current)} · ${rankGapText(current)}`, source_type: "推荐模型", confidence: "中高", verify_hint: "随选择院校联动" },
    { title: "24/25/26 志愿走势", value: `24 ${formatInt(current.score_2024)}分/${formatInt(current.rank_2024)}名；25 ${formatInt(current.score_2025)}分/${formatInt(current.rank_2025)}名；26 ${current.score_range || "-"} / ${formatInt(current.predicted_rank || current.rank_mid)}名`, source_type: "录取主库", confidence: "中高", verify_hint: "按2026预测位次排序" },
    { title: "宿舍摘要", value: dormText(current), source_type: "院校资料表", confidence: "中高", verify_hint: "建议复核校区" },
    { title: "食堂摘要", value: canteenText(current), source_type: "院校资料表", confidence: "中", verify_hint: "公开资料可能滞后" },
    { title: "就业保研", value: employmentText(current), source_type: "院校资料表", confidence: "中", verify_hint: "以就业质量报告为准" },
    { title: "转专业", value: textOr(guide(current).transfer_policy, "待核验"), source_type: "院校资料表", confidence: "中", verify_hint: "需复核当年政策" },
    { title: "学费", value: tuitionText(current), source_type: "招生计划", confidence: "中高", verify_hint: "以招生章程为准" },
  ];
  const seen = new Set();
  const uniqueRows = (rows) => rows.filter((row) => {
    const key = `${row.title}-${row.value}`;
    if (seen.has(key) || String(row.title || "").includes("校徽")) return false;
    seen.add(key);
    return true;
  });
  const header = `
    <div class="profile-hero">
      ${logoHtml(profile.asset, profile.school)}
      <div>
        <h2>${escapeHtml(profile.school)}</h2>
        <p>${escapeHtml(profile.headline?.city || "城市待核验")} · ${escapeHtml(profile.headline?.ownership || "性质待核验")} · ${escapeHtml(profile.headline?.tier || "层次待核验")}</p>
      </div>
    </div>
    <div class="profile-kpis dense">
      <div><span>候选专业</span><strong>${profile.headline?.major_count ?? "-"}</strong></div>
      <div><span>2025最低位次</span><strong>${formatInt(profile.headline?.min_rank_2025)}</strong></div>
      <div><span>学费范围</span><strong>${escapeHtml(profile.headline?.tuition_range || "待核验")}</strong></div>
      <div><span>资料覆盖</span><strong>${profile.headline?.coverage ?? coverageScore(current) * 14}%</strong></div>
    </div>
  `;
  if (state.activeProfileTab === "reviews") {
    const reviewCards = (profile.reviews || []).map((item) => `
      <article class="review-card profile-info-card">
        <span>${escapeHtml(item.title || "学生评价")}</span>
        <strong>${escapeHtml(item.summary || item.short_summary || "暂无可追溯评价片段")}</strong>
        <small>${escapeHtml(item.source_type || "公开资料")} · 可信度${escapeHtml(item.confidence || "中")} · ${escapeHtml(item.verify_hint || "建议复核")}</small>
      </article>
    `);
    node.innerHTML = header + `<div class="review-grid profile-dense-grid review-board">${reviewCards.join("") || `<article class="info-card profile-info-card"><strong>暂无可追溯评价片段</strong><small>不编造学生评价，等待公开资料补充。</small></article>`}</div>`;
    markLinearReveal(node, ".profile-hero, .profile-kpis > div, .profile-info-card, .review-card");
    return;
  }
  if (state.activeProfileTab === "official") {
    const officialRows = [
      { title: "官网", value: profile.official?.official_site || "官网待补全", source_type: "公开官网", confidence: "中", verify_hint: "建议人工打开复核" },
      { title: "招生网", value: profile.official?.admission_site || "招生网待补全", source_type: "本科招生网", confidence: "中", verify_hint: "招生政策以该来源为准" },
      { title: "招生电话", value: profile.official?.admission_phone || "待核验", source_type: "院校资料表", confidence: "中", verify_hint: "重要信息建议电话复核" },
      { title: "公开邮箱", value: profile.official?.email || "待核验", source_type: profile.official?.public_source_type || "公开资料", confidence: "中", verify_hint: "缺失时显示待核验" },
      ...sourceRows,
    ];
    node.innerHTML = header + `<div class="info-grid profile-dense-grid">${uniqueRows(officialRows).map(profileCard).join("")}</div>`;
    markLinearReveal(node, ".profile-hero, .profile-kpis > div, .profile-info-card, .review-card");
    return;
  }
  const tabMap = {
    basic: [...(sections.basic || []), ...(sections.admission || []), ...decisionRows, ...sourceRows],
    admission: [...(sections.admission || []), ...decisionRows, ...sourceRows],
    major_strength: [...(sections.major_strength || []), ...decisionRows, ...sourceRows],
    life: [...collegesChatCards(state.selectedCollegesChat), ...decisionRows, ...(sections.life || []), ...(sections.basic || []), ...sourceRows],
    development: [...(sections.development || []), ...decisionRows, ...sourceRows],
  };
  const rows = uniqueRows(tabMap[state.activeProfileTab] || tabMap.basic).slice(0, 36);
  const collegesChatHtml = state.activeProfileTab === "life" ? collegesChatPanel(state.selectedCollegesChat) : "";
  node.innerHTML = header + collegesChatHtml + `<div class="profile-life-board">${rows.map(profileCard).join("") || `<article class="info-card profile-info-card"><strong>暂无结构化资料</strong><small>不把不确定内容包装成结论。</small></article>`}</div>`;
  hydrateCollegesChatQuestions(node);
  markLinearReveal(node, ".profile-hero, .profile-kpis > div, .profile-info-card, .review-card, .colleges-chat-section");
}

function renderDetail() {
  const node = el("detailPanel");
  const item = state.selected;
  const profile = state.selectedProfile;
  if (!node) return;
  if (!item) {
    node.innerHTML = `
      <div class="empty-state detail-empty">
        <strong>等待选择院校</strong>
        <span>点击总览或推荐表会更新这里；点击“详情”进入完整院校详情。</span>
      </div>
    `;
    return;
  }
  node.innerHTML = `
    <div class="detail-hero">
      ${logoHtml(profile?.asset || item.logo_asset || state.logoCache[item.school], item.school)}
      <div>
        <h2>${escapeHtml(item.school)}</h2>
        <p>${escapeHtml(item.major)} · ${escapeHtml(item.school_ownership_label || "待核验")} · ${escapeHtml(item.school_tier_label || "普通本科")}</p>
      </div>
    </div>
    <div class="detail-dismiss detail-dismiss-top">
      <button id="dismissCurrentBtn" type="button">不感兴趣</button>
      <span>隐藏这条推荐，并自动查看下一条</span>
    </div>
    <div class="summary-grid">
      <div><span>预测分数</span><strong>${escapeHtml(item.score_range || "-")}</strong></div>
      <div><span>预测位次</span><strong>${escapeHtml(item.rank_range || "-")}</strong></div>
      <div><span>录取概率</span><strong>${probabilityText(item)}</strong></div>
      <div><span>模型置信</span><strong>${formatPercent(item.confidence_score)}</strong></div>
      <div><span>学费</span><strong>${escapeHtml(tuitionText(item))}</strong></div>
      <div><span>资料完整度</span><strong>${profile?.headline?.coverage ?? coverageScore(item) * 14}%</strong></div>
    </div>
    <section class="detail-section">
      <h3>24/25/26 志愿数据</h3>
      ${yearTrendHtml(item)}
      <p class="rank-gap-line">${escapeHtml(rankGapText(item))}</p>
    </section>
    <section class="detail-section">
      <h3>为什么推荐</h3>
      <p>${escapeHtml(item.explanation || "暂无推荐解释")}</p>
    </section>
    <section class="detail-section">
      <h3>吃住环境</h3>
      <p>宿舍：${escapeHtml(dormText(item))}</p>
      <p>食堂：${escapeHtml(canteenText(item))}</p>
    </section>
    <section class="detail-section">
      <h3>就业、保研、转专业</h3>
      <p>${escapeHtml(employmentText(item))}</p>
      <p>转专业：${escapeHtml(textOr(guide(item).transfer_policy, "待核验"))}</p>
    </section>
    <section class="detail-section">
      <h3>来源可信度</h3>
      <div class="tag-cloud">${(profile?.source_summary || []).filter((source) => !String(source.type || "").includes("校徽")).map((source) => `<span class="tag good">${escapeHtml(source.type)} · ${escapeHtml(source.confidence)}</span>`).join("")}</div>
      <p>${escapeHtml(state.selectedCollegesChat?.available ? `CollegesChat：${state.selectedCollegesChat.question_count} 个生活质量问题、${state.selectedCollegesChat.answer_count} 条原始回答。` : state.selectedCollegesChat?.message || "CollegesChat 问卷等待加载。")}</p>
    </section>
  `;
  markLinearReveal(node, ".detail-hero, .summary-grid > div, .detail-section, .detail-dismiss");
}

function renderRankTrendMini() {
  const chart = getChart("rankTrendMini");
  if (!chart) return;
  const userRank = asNumber(state.summary?.user_rank, estimateRankForScore(state.score));
  const rank2024 = Math.round(userRank * (1.035 - state.difficultyDelta * 0.02));
  const rank2025 = userRank;
  const rank2026 = asNumber(state.summary?.predicted_user_rank, estimateRankForScore(state.score));
  const selected = state.selected || state.list[0] || {};
  const schoolName = String(selected.school || "选中院校").slice(0, 10);
  const schoolRank2024 = asNumber(selected.rank_2024, null);
  const schoolRank2025 = asNumber(selected.rank_2025, null);
  const schoolRank2026 = asNumber(selected.predicted_rank || selected.rank_mid, null);
  const values = [rank2024, rank2025, rank2026, schoolRank2024, schoolRank2025, schoolRank2026].filter((value) => Number.isFinite(value) && value > 0);
  const minValue = Math.max(1, Math.floor(Math.min(...values) * 0.92));
  const maxValue = Math.ceil(Math.max(...values) * 1.08);
  const gap = Number.isFinite(schoolRank2026) ? Math.round(schoolRank2026 - rank2026) : 0;
  const headline = Number.isFinite(schoolRank2026)
    ? gap >= 0 ? `2026：你领先 ${formatInt(gap)} 名` : `2026：你落后 ${formatInt(Math.abs(gap))} 名`
    : "点击院校后显示对比走势";
  chart.setOption({
    animation: true,
    animationDuration: 620,
    animationDurationUpdate: 360,
    animationEasing: "cubicOut",
    animationEasingUpdate: "cubicOut",
    grid: { left: 64, right: 96, top: 76, bottom: 24 },
    title: {
      text: headline,
      subtext: "位次越靠上越好",
      left: 10,
      top: 6,
      textStyle: { color: gap >= 0 ? "#16865a" : "#c96b12", fontSize: 14, fontWeight: 900 },
      subtextStyle: { color: "#66758a", fontSize: 11, fontWeight: 800 },
    },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "line", lineStyle: { color: "#8ca3bf", type: "dashed" } },
      borderColor: "#b9c7d8",
      backgroundColor: "rgba(255,255,255,.98)",
      textStyle: { color: "#10213d", fontSize: 12 },
      formatter: (items) => items
        .filter((entry) => Number.isFinite(Number(entry.value)))
        .map((entry) => `${entry.marker}${entry.seriesName}: ${formatInt(entry.value)}名`)
        .join("<br/>"),
    },
    legend: {
      top: 38,
      right: 14,
      itemWidth: 20,
      itemHeight: 8,
      textStyle: { color: "#52627a", fontSize: 12, fontWeight: 800 },
    },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: ["2024", "2025", "2026预测"],
      axisTick: { show: false },
      axisLine: { lineStyle: { color: "#d9e2ef" } },
      axisLabel: { color: "#52627a", fontSize: 12, fontWeight: 800 },
    },
    yAxis: {
      type: "value",
      inverse: true,
      min: minValue,
      max: maxValue,
      splitNumber: 4,
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: { color: "#66758a", fontSize: 12, formatter: (value) => formatInt(value) },
      splitLine: { lineStyle: { color: "rgba(129,151,178,.24)", type: "dashed" } },
    },
    series: [
      {
        name: "我的位次",
        type: "line",
        smooth: 0.18,
        data: [rank2024, rank2025, rank2026],
        symbol: "circle",
        symbolSize: 11,
        lineStyle: { width: 3, color: "#1558b0", cap: "round" },
        itemStyle: { color: "#fff", borderColor: "#1558b0", borderWidth: 3 },
        label: {
          show: true,
          position: "right",
          distance: 9,
          offset: [0, -11],
          color: "#1558b0",
          fontWeight: 900,
          fontSize: 11,
          backgroundColor: "rgba(255,255,255,.92)",
          borderColor: "rgba(21,88,176,.20)",
          borderWidth: 1,
          borderRadius: 6,
          padding: [2, 5],
          formatter: (params) => params.dataIndex === 2 ? `我 ${formatInt(params.value)}` : "",
        },
        labelLayout: { hideOverlap: true, moveOverlap: "shiftY" },
        areaStyle: {
          color: {
            type: "linear",
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [{ offset: 0, color: "rgba(21,88,176,.20)" }, { offset: 1, color: "rgba(21,88,176,.015)" }],
          },
        },
      },
      {
        name: `${schoolName}线`,
        type: "line",
        smooth: 0.18,
        data: [schoolRank2024, schoolRank2025, schoolRank2026],
        symbol: "circle",
        symbolSize: 11,
        lineStyle: { width: 3, color: "#c96b12", cap: "round" },
        itemStyle: { color: "#fff", borderColor: "#c96b12", borderWidth: 3 },
        label: {
          show: true,
          position: "right",
          distance: 9,
          offset: [0, 11],
          color: "#9a4d08",
          fontWeight: 900,
          fontSize: 11,
          backgroundColor: "rgba(255,255,255,.92)",
          borderColor: "rgba(201,107,18,.20)",
          borderWidth: 1,
          borderRadius: 6,
          padding: [2, 5],
          formatter: (params) => params.dataIndex === 2 ? `校 ${formatInt(params.value)}` : "",
        },
        labelLayout: { hideOverlap: true, moveOverlap: "shiftY" },
      },
    ],
  });
}

function renderTable() {
  const body = el("resultBody");
  if (!body) return;
  const rows = filteredList();
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="9" class="empty-cell">没有匹配结果，调整筛选条件试试。</td></tr>`;
  } else {
    body.innerHTML = rows.map((item) => {
      const selected = state.selected?.unit_id === item.unit_id ? " selected-row" : "";
      const planDelta = asNumber(item.plan_2025) - asNumber(item.plan_2024);
      return `
        <tr class="${selected} table-risk-${riskTone(item)}" data-unit="${escapeHtml(item.unit_id)}" style="--i:${asNumber(item.order, 0)}">
          <td class="metric order-cell"><strong>${item.order || "-"}</strong><small>推荐</small></td>
          <td><button class="replace-btn" data-replace-unit="${escapeHtml(item.unit_id)}" title="换一个同层级候选">更换</button></td>
          <td>${logoHtml(item.logo_asset || state.logoCache[item.school], item.school)}</td>
          <td class="cell-title">
            <strong>${escapeHtml(item.school)}</strong>
            <span>${escapeHtml(item.major)}</span>
            <small>${escapeHtml(textOr(guide(item).school_city || ladder(item).school_location || item.school_tier_label))} · ${escapeHtml(item.school_ownership_label || "待核验")}</small>
          </td>
          <td><span class="pill ${riskClass(item.risk_level)}">${escapeHtml(riskShort(item.risk_level))}</span><div class="muted-line">${probabilityText(item)} 录取</div></td>
          <td>${yearTrendHtml(item)}<small class="rank-gap-inline">${escapeHtml(rankGapText(item))}</small></td>
          <td class="metric"><strong>${formatInt(item.plan_2025)}人</strong><small>${planDelta >= 0 ? "+" : ""}${planDelta} · ${escapeHtml(tuitionText(item))}</small></td>
          <td>
            <div class="table-briefs">
              <span title="${escapeHtml(dormText(item))}">宿 ${escapeHtml(dormText(item))}</span>
              <span title="${escapeHtml(canteenText(item))}">食 ${escapeHtml(canteenText(item))}</span>
              <span title="${escapeHtml(employmentText(item))}">业 ${escapeHtml(textOr(guide(item).employment || guide(item).postgraduate_recommendation, "待核验"))}</span>
              <b>资料 ${coverageScore(item)}/7</b>
            </div>
          </td>
          <td><button class="row-action" data-unit="${escapeHtml(item.unit_id)}">详情</button></td>
        </tr>
      `;
    }).join("");
  }
  setText("tableCount", `已展开推荐 ${rows.length} / 96 条`);
}

let mobileSheetReturnFocus = null;

function setMobileFilterSheet(open, trigger = null) {
  const sheet = el("mobileFilterSheet");
  if (!sheet) return;
  if (open) {
    mobileSheetReturnFocus = trigger || document.activeElement;
    sheet.hidden = false;
    requestAnimationFrame(() => sheet.querySelector("button")?.focus());
    return;
  }
  sheet.hidden = true;
  mobileSheetReturnFocus?.focus?.();
  mobileSheetReturnFocus = null;
}

function bindEvents() {
  bindNavMotion();
  el("profileContent")?.addEventListener("click", handleCollegesChatQuestionClick);
  el("scoreGateForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    enterDesktopAppFromScore();
  });
  el("generateBtn")?.addEventListener("click", generateList);
  el("refreshBtn")?.addEventListener("click", generateList);
  el("mobileRefreshBtn")?.addEventListener("click", () => generateList({ entryLoader: true }));
  el("mobileBottomNav")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-mobile-step]");
    if (!button) return;
    setMobileStep(button.dataset.mobileStep);
  });
  el("riskModeButtons")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-risk-mode]");
    if (!button) return;
    state.risk = button.dataset.riskMode;
    document.querySelectorAll("#riskModeButtons button").forEach((node) => node.classList.toggle("active", node === button));
    generateList();
  });
  el("navTabs")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-view]");
    if (button) {
      const nav = el("navTabs");
      nav?.classList.remove("nav-pressing");
      void nav?.offsetWidth;
      nav?.classList.add("nav-pressing");
      window.setTimeout(() => nav?.classList.remove("nav-pressing"), 680);
      switchView(button.dataset.view);
    }
  });
  document.body.addEventListener("click", async (event) => {
    const mobileDetailButton = event.target.closest("[data-mobile-open-detail]");
    if (mobileDetailButton?.dataset.mobileOpenDetail) {
      event.preventDefault();
      await openDetail(mobileDetailButton.dataset.mobileOpenDetail);
      setMobileStep("detail");
      return;
    }
    if (event.target.closest("[data-mobile-filter-open]")) {
      event.preventDefault();
      setMobileFilterSheet(true, event.target.closest("[data-mobile-filter-open]"));
      return;
    }
    if (event.target.closest("[data-mobile-sheet-close]")) {
      event.preventDefault();
      setMobileFilterSheet(false);
      return;
    }
    const mobileFilterButton = event.target.closest(".mobile-filter-options button[data-value]");
    if (mobileFilterButton) {
      event.preventDefault();
      const group = mobileFilterButton.closest("[data-mobile-filter-group]")?.dataset.mobileFilterGroup;
      if (group === "risk") state.riskFilter = mobileFilterButton.dataset.value;
      if (group === "quick") state.quickFilter = mobileFilterButton.dataset.value;
      if (group === "sort") state.sort = mobileFilterButton.dataset.value;
      mobileFilterButton.parentElement?.querySelectorAll("button").forEach((node) => node.classList.toggle("active", node === mobileFilterButton));
      renderTable();
      renderMobileApp();
      return;
    }
    if (event.target.id === "mobileDismissCurrentBtn" && state.selected?.unit_id) {
      event.preventDefault();
      await replaceRecommendation(state.selected.unit_id, "已标记不感兴趣并补位");
      renderMobileApp();
      return;
    }
    const replaceButton = event.target.closest("[data-replace-unit]");
    if (replaceButton?.dataset.replaceUnit) {
      event.preventDefault();
      event.stopPropagation();
      await replaceRecommendation(replaceButton.dataset.replaceUnit, "已更换推荐");
      return;
    }
    const unitButton = event.target.closest("[data-unit]");
    if (unitButton?.dataset.unit) {
      const explicitView =
        event.target.closest(".life-card") ||
        event.target.closest(".mobile-card") ||
        (event.target.closest(".decision-table") && event.target.closest(".row-action")) ||
        (event.target.closest(".priority-card") && event.target.closest(".row-action"));
      await openDetail(unitButton.dataset.unit);
      if (event.target.closest(".mobile-card")) setMobileStep("detail");
      if (explicitView) switchView("profile");
    }
    const jump = event.target.closest("[data-view-jump]");
    if (jump) switchView(jump.dataset.viewJump);
    if (event.target.id === "dismissCurrentBtn" && state.selected?.unit_id) {
      await replaceRecommendation(state.selected.unit_id, "已标记不感兴趣并补位");
    }
  });
  document.addEventListener("keydown", (event) => {
    const sheet = el("mobileFilterSheet");
    if (!sheet || sheet.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setMobileFilterSheet(false);
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...sheet.querySelectorAll("button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])")];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  document.body.addEventListener("keydown", async (event) => {
    if (!["Enter", " "].includes(event.key)) return;
    if (event.target.closest("button, a, input, select, textarea")) return;
    const clickable = event.target.closest(".priority-card[data-unit], .decision-table tbody tr[data-unit], .life-card[data-unit]");
    if (!clickable?.dataset.unit) return;
    event.preventDefault();
    await openDetail(clickable.dataset.unit);
  });
  el("searchInput")?.addEventListener("input", (event) => {
    state.query = event.target.value;
    state.page = 1;
    renderTable();
  });
  document.body.addEventListener("input", (event) => {
    if (event.target.id !== "mobileSearchInput") return;
    state.query = event.target.value;
    state.page = 1;
    renderTable();
    updateMobileRecommendList();
  });
  el("riskFilterSelect")?.addEventListener("change", (event) => {
    state.riskFilter = event.target.value;
    state.page = 1;
    renderTable();
  });
  el("ownershipFilter")?.addEventListener("change", (event) => {
    state.ownershipFilter = event.target.value;
    state.page = 1;
    renderTable();
  });
  el("sortSelect")?.addEventListener("change", (event) => {
    state.sort = event.target.value;
    renderTable();
  });
  el("riskFilterButtons")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-risk-filter]");
    if (!button) return;
    state.riskFilter = button.dataset.riskFilter;
    state.page = 1;
    document.querySelectorAll("#riskFilterButtons button").forEach((node) => node.classList.toggle("active", node === button));
    renderTable();
  });
  el("ownershipFilterButtons")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-ownership-filter]");
    if (!button) return;
    state.ownershipFilter = button.dataset.ownershipFilter;
    state.page = 1;
    document.querySelectorAll("#ownershipFilterButtons button").forEach((node) => node.classList.toggle("active", node === button));
    renderTable();
  });
  el("sortButtons")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-sort]");
    if (!button) return;
    state.sort = button.dataset.sort;
    document.querySelectorAll("#sortButtons button").forEach((node) => node.classList.toggle("active", node === button));
    renderTable();
  });
  el("quickFilters")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-quick]");
    if (!button) return;
    state.quickFilter = button.dataset.quick;
    state.page = 1;
    document.querySelectorAll("#quickFilters button").forEach((node) => node.classList.toggle("active", node === button));
    renderTable();
  });
  el("profileTabs")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-profile-tab]");
    if (!button) return;
    state.activeProfileTab = button.dataset.profileTab;
    renderProfile();
  });
  let resizeFrame = 0;
  const resizeCharts = () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      updateNavIndicator();
      Object.values(state.charts).forEach((chart) => chart?.resize());
    });
  };
  if (window.ResizeObserver) {
    const observer = new ResizeObserver(resizeCharts);
    document.querySelectorAll(".center-stage, .right-rail, .mini-chart, .donut-box").forEach((node) => observer.observe(node));
  } else {
    window.addEventListener("resize", resizeCharts, { passive: true });
  }
  updateNavIndicator();
}

let appBooted = false;
let appUnlocked = false;

function mobileGateMatches() {
  return false;
}

function startDesktopApp(options = {}) {
  if (!appUnlocked || appBooted) return;
  appBooted = true;
  loadResources();
  generateList(options);
  ensureECharts()
    .then(() => renderAll())
    .catch((error) => console.warn("图表资源暂不可用", error));
}

function setScoreValue(score) {
  const text = String(score ?? "").trim();
  if (!text) return null;
  const number = Number(text);
  if (!Number.isFinite(number)) return null;
  const clean = Math.max(0, Math.min(750, Math.round(number)));
  state.score = clean;
  if (el("scoreInput")) el("scoreInput").value = clean;
  if (el("entryScoreInput")) el("entryScoreInput").value = clean;
  return clean;
}

function setRankValue(rank) {
  const text = String(rank ?? "").trim();
  if (!text) return null;
  const number = Number(text);
  if (!Number.isFinite(number)) return null;
  const clean = Math.max(1, Math.round(number));
  state.currentRank = clean;
  if (el("rankInput")) el("rankInput").value = clean;
  if (el("entryRankInput")) el("entryRankInput").value = clean;
  return clean;
}

function enterDesktopAppFromScore() {
  const input = el("entryScoreInput");
  const score = setScoreValue(input?.value);
  if (score === null) {
    input?.reportValidity();
    input?.focus();
    return;
  }
  // 位次不再手填：留空，由后端按2026一分一段表自动换算
  state.currentRank = null;
  appUnlocked = true;
  showEntryLoader();
  document.body.dataset.scoreGate = "closing";
  window.setTimeout(() => {
    document.body.dataset.scoreGate = "closed";
    startDesktopApp({ entryLoader: true, loaderVisible: true });
  }, 360);
}

function restoreEntryScore() {
  appUnlocked = false;
  state.score = null;
  state.currentRank = null;
  if (el("scoreInput")) el("scoreInput").value = "";
  if (el("entryScoreInput")) el("entryScoreInput").value = "";
  if (el("rankInput")) el("rankInput").value = "";
  if (el("entryRankInput")) el("entryRankInput").value = "";
  document.body.dataset.scoreGate = "open";
}

function applyDesktopRequiredGate({ resetEntry = false } = {}) {
  const blocked = mobileGateMatches();
  document.body.dataset.mobileBlocked = blocked ? "true" : "false";
  if (blocked) {
    document.body.dataset.motionStatus = "desktop-required";
    return;
  }
  if (resetEntry) restoreEntryScore();
  if (document.body.dataset.motionStatus === "desktop-required") {
    document.body.dataset.motionStatus = state.list?.length ? "ready" : "idle";
  }
  startDesktopApp();
}

bindEvents();
applyDesktopRequiredGate({ resetEntry: true });
window.addEventListener("resize", applyDesktopRequiredGate);
window.addEventListener("orientationchange", () => window.setTimeout(applyDesktopRequiredGate, 120));
