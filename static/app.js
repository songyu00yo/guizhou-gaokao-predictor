import { state } from "./js/state.js";
import { fetchJson, fetchRecommendations, isAbortError } from "./js/api.js";
import { prefersReducedMotion } from "./js/motion.js";

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

// 入场动画只对第一次出现的内容播放；同一份数据重渲染时不再重放，避免整屏闪烁。
const enteredContent = new Set();

function markEntering(node, key) {
  if (!node || !key || enteredContent.has(key)) return;
  enteredContent.add(key);
  // 动画结束后摘掉类名，下一次换内容才能重新触发一次入场。
  node.classList.remove("is-entering");
  node.classList.add("is-entering");
  // 每次触发带一个序号，快速连续切换时旧回调不会掐掉新动画。
  const token = (node.__enterToken || 0) + 1;
  node.__enterToken = token;
  const clear = () => {
    if (node.__enterToken === token) node.classList.remove("is-entering");
  };
  node.addEventListener("animationend", clear, { once: true });
  // 隐藏视图里的动画不会触发 animationend，兜底清掉类名。
  window.setTimeout(clear, 600);
}

// 列表首帧只整体淡入一次：逐行动画在筛选/排序时会造成整表闪烁。
function markFirstPaint(root, scope) {
  markEntering(root, `${scope}:first-paint`);
}

function toast(message) {
  const node = el("toast");
  if (!node) return;
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 2300);
}

// 开场只用于覆盖首屏等待：数据就绪后 1.2s 内必收束，不再强制浏览 5 秒动画。
const ENTRY_MIN_DURATION = 1200;
const ENTRY_FADE_DURATION = 220;

function setEntryLoaderStep(step, text) {
  const loader = el("entryLoader");
  if (!loader) return;
  loader.dataset.step = step || "";
  setText("entryLoaderText", text || "");
}

function showEntryLoader() {
  const loader = el("entryLoader");
  if (!loader) return;
  loader.hidden = false;
  loader.dataset.visible = "true";
  state.entryStarted = performance.now();
  state.entryMinimum = new Promise(resolve => setTimeout(resolve, prefersReducedMotion() ? 120 : ENTRY_MIN_DURATION));
  setText("entryLoaderTitle", "正在生成你的志愿决策表");
  setText("entryNumbers", `${state.score} 分`);
  setEntryLoaderStep("rank", "正在按2026一分一段表换算位次并校准基准。");
}

async function hideEntryLoader() {
  const loader = el("entryLoader");
  if (!loader || loader.hidden) return;
  await state.entryMinimum;
  loader.dataset.visible = "false";
  await new Promise((resolve) => window.setTimeout(resolve, prefersReducedMotion() ? 0 : ENTRY_FADE_DURATION));
  loader.hidden = true;
  renderRankTrendMini();
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
  if (item && Object.hasOwn(item, "tuition")) {
    const tuition = item.tuition;
    if (tuition === null || tuition === undefined || tuition === "") return "待核验";
    const text = String(tuition).trim();
    return /元\s*\/\s*年/.test(text) ? text : `${text}元/年`;
  }
  if (item?.tuition_range_2025) return `${item.tuition_range_2025}元/年`;
  const value = asNumber(item?.tuition_2025, 0);
  return value ? `${formatInt(value)}元/年` : "待核验";
}

function tuitionSortValue(item) {
  const raw = item && Object.hasOwn(item, "tuition") ? item.tuition : item?.tuition_2025;
  if (raw === null || raw === undefined || raw === "") return 999999;
  const value = Number(String(raw).replaceAll(",", "").match(/\d+(?:\.\d+)?/)?.[0]);
  return Number.isFinite(value) ? value : 999999;
}

function schoolCity(item) {
  return textOr(item?.city || guide(item).school_city || guide(item).location || ladder(item).school_location, "城市待核验");
}

function schoolOwnership(item) {
  return textOr(item?.ownership || item?.school_ownership_label, "性质待核验");
}

function normalizeOwnershipCategory(value) {
  const text = textOr(value, "");
  if (text === "待核验" || text === "性质待核验") return "待核验";
  return text.replace(/本科\s*$/, "");
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value ?? "").trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function httpLinkHtml(value, label = value) {
  const url = safeHttpUrl(value);
  if (!url) return "";
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`;
}

function officialSiteHtml(value) {
  const text = String(value ?? "").trim();
  return httpLinkHtml(text) || escapeHtml(text || "官网待补全");
}

function historyYearIndex(history, year) {
  const target = String(year);
  return (history?.years || []).findIndex((label) => String(label).match(/20\d{2}/)?.[0] === target);
}

function nullableHistoryValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function historyRecord(item, year) {
  const record = item?.[`history_${year}`];
  if (record && typeof record === "object") {
    return {
      year: record.year ?? year,
      score: nullableHistoryValue(record.min_score),
      rank: nullableHistoryValue(record.min_rank),
      plan: nullableHistoryValue(record.plan_count),
      admitted: nullableHistoryValue(record.admitted_count),
      sourceUrl: record.source_url || null,
    };
  }
  const history = item?.history;
  const label = year === 2027 ? "2027预测" : String(year);
  const index = historyYearIndex(history, year);
  if (index >= 0) {
    return {
      year: history.years[index],
      rank: nullableHistoryValue(history.rank?.[index]),
      score: nullableHistoryValue(history.score?.[index]),
      plan: nullableHistoryValue(history.plan?.[index]),
      admitted: nullableHistoryValue(history.admitted?.[index]),
      sourceUrl: null,
    };
  }
  if (year === 2027) {
    const scoreRange = String(item?.score_range || "");
    const predictedScore = nullableHistoryValue(item?.predicted_score);
    return {
      year: label,
      rank: nullableHistoryValue(item?.predicted_rank || item?.rank_mid),
      score: predictedScore,
      scoreRange: scoreRange || null,
      plan: null,
      admitted: null,
      sourceUrl: null,
    };
  }
  return { year: label, score: null, rank: null, plan: null, admitted: null, sourceUrl: null };
}

function historyScoreText(record, year) {
  if (record.score !== null) return `${formatInt(record.score)}分`;
  if (year === 2027 && record.scoreRange) return `${escapeHtml(record.scoreRange)}分`;
  return "-分";
}

function historyLineText(item, year) {
  const record = historyRecord(item, year);
  const label = year === 2027 ? "27预测" : String(year).slice(-2);
  const plan = record.plan === null ? "-" : formatInt(record.plan);
  const admitted = record.admitted === null ? "-" : formatInt(record.admitted);
  const scoreRank = `${historyScoreText(record, year)} / ${record.rank === null ? "待核验" : `${formatInt(record.rank)}名`}`;
  const detail = `${scoreRank} · 计划${plan} / 录取${admitted}`;
  // 行内只放分数与位次，计划/录取放进 title，避免窄列被撑成多行。
  return `<span title="${escapeHtml(`${year}年：${detail}`)}"><b>${label}</b>${scoreRank}</span>`;
}

function historySummaryText(item) {
  return [2024, 2025, 2026, 2027].map((year) => {
    const record = historyRecord(item, year);
    const label = year === 2027 ? "2027预测" : String(year);
    const rank = record.rank === null ? "位次待核验" : `${formatInt(record.rank)}名`;
    return `${label} ${historyScoreText(record, year)}/${rank}`;
  }).join("；");
}

function profileCoverageText(profile) {
  const coverage = profile?.headline?.coverage;
  if (coverage === null || coverage === undefined || coverage === "") return "未提供";
  return typeof coverage === "number" || /^\d+(\.\d+)?$/.test(String(coverage)) ? `${coverage}%` : String(coverage);
}

function validCount(value) {
  if (value === null || value === undefined || value === "") return null;
  const count = Number(value);
  return Number.isFinite(count) ? count : null;
}

function coverageStats(coverage) {
  const schoolsTotal = validCount(coverage?.schools_total);
  const programsTotal = validCount(coverage?.programs_total);
  return [
    ["院校基础资料", validCount(coverage?.schools_with_basic), schoolsTotal],
    ["院校生活资料", validCount(coverage?.schools_with_life), schoolsTotal],
    ["院校官网", validCount(coverage?.schools_with_official_site), schoolsTotal],
    ["2024录取历史", validCount(coverage?.programs_with_history_2024), programsTotal],
    ["2025录取历史", validCount(coverage?.programs_with_history_2025), programsTotal],
    ["2026录取历史", validCount(coverage?.programs_with_history_2026), programsTotal],
    ["学费", validCount(coverage?.programs_with_tuition), programsTotal],
    ["选科要求", validCount(coverage?.programs_with_subject_requirement), programsTotal],
  ].filter(([, count, total]) => count !== null && total !== null);
}

function coverageCountText(count, total) {
  return `${formatCount(count)}/${formatCount(total)} · ${coveragePercentText(count, total)}`;
}

function coveragePercentText(count, total) {
  return total > 0 ? `${((count / total) * 100).toFixed(1)}%` : "比例待核验";
}

function formatCount(value) {
  const count = validCount(value);
  return count === null ? "待提供" : Math.round(count).toLocaleString("zh-CN");
}

function resourceCoverageCards(coverage) {
  return coverageStats(coverage).map(([title, count, total]) => ({
    title,
    status: coverageCountText(count, total),
    description: "资料覆盖统计由后端按可用院校或专业记录汇总。",
    confidence: "统计值",
  }));
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
  const probability = admissionProbability(item);
  return probability === null ? "未提供" : formatPercent(probability);
}

function trendDirection(item) {
  const r24 = historyRecord(item, 2024).rank || 0;
  const r25 = historyRecord(item, 2025).rank || 0;
  if (!r24 || !r25) return "历史待核验";
  const delta = r25 - r24;
  if (Math.abs(delta) < Math.max(800, r24 * 0.015)) return "基本持平";
  return delta < 0 ? "竞争增强" : "竞争放缓";
}

function yearTrendHtml(item) {
  return `
    <div class="year-stack">
      ${[2024, 2025, 2026, 2027].map((year) => historyLineText(item, year)).join("")}
      <em>${escapeHtml(trendDirection(item))}</em>
    </div>
  `;
}

function coverageScore(item) {
  const values = [
    hasLifeData(item),
    guide(item).dormitory,
    guide(item).canteen,
    guide(item).transfer_policy,
    ladder(item).campus_facilities,
    guide(item).location || ladder(item).school_location,
  ];
  return values.filter((value) => typeof value === "boolean" ? value : Boolean(textOr(value, ""))).length;
}

function hasLifeData(item) {
  return item?.has_life_data === true || item?.has_life_data === 1;
}

const logoKey = school => String(school || "").normalize("NFKC").replace(/\s+/g, "");

// 校徽索引落在 localStorage：刷新页面不再重复请求接口，避免撞上 5 次/分钟限流。
const LOGO_CACHE_KEY = "gz-logo-cache-v1";
const LOGO_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

function readLogoCache() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LOGO_CACHE_KEY) || "{}");
    const now = Date.now();
    const fresh = {};
    Object.entries(parsed || {}).forEach(([key, entry]) => {
      if (!entry?.logo_url) return;
      if (entry.at && now - entry.at > LOGO_CACHE_TTL) return;
      fresh[key] = entry;
    });
    return fresh;
  } catch {
    return {};
  }
}

let logoCacheTimer = 0;
function persistLogoCache() {
  clearTimeout(logoCacheTimer);
  logoCacheTimer = window.setTimeout(() => {
    try {
      window.localStorage.setItem(LOGO_CACHE_KEY, JSON.stringify(state.logoCache));
    } catch {
      // 隐私模式或配额不足时忽略，不影响渲染。
    }
  }, 300);
}

function primeLogoCache() {
  Object.assign(state.logoCache, readLogoCache());
  [...state.list, ...(state.alternates || [])].forEach(item => {
    const cached = state.logoCache[logoKey(item.school)];
    if (cached?.logo_url) item.logo_asset = item.logo_asset || cached;
  });
}

const logoPending = new Map();
const logoInFlight = new Set();
function attachLogoAsset(school, asset) {
  const key = logoKey(school);
  state.logoCache[key] = asset?.logo_url ? { ...asset, at: Date.now() } : asset;
  if (asset?.logo_url) persistLogoCache();
  [...state.list, ...(state.alternates || [])].forEach(item => {
    if (logoKey(item.school) === key) item.logo_asset = asset;
  });
  if (logoKey(state.selected?.school) === key) {
    state.selected.logo_asset = asset;
    if (state.selectedProfile) state.selectedProfile.asset = asset;
  }
  document.querySelectorAll(".school-logo[data-school]").forEach(node => {
    if (logoKey(node.dataset.school) !== key) return;
    const holder = document.createElement("div");
    holder.innerHTML = logoHtml(asset, school);
    node.replaceWith(holder.firstElementChild);
  });
  updateLogoCount();
}
function updateLogoCount() {
  const schools = [...new Set(state.list.map(item => logoKey(item.school)))];
  // 以是否拿到可用图片为准：状态字段有 ready/cached 等多种取值，只看 status 会误报 0。
  const ready = schools.filter(key => Boolean(state.logoCache[key]?.logo_url)).length;
  setText("logoCoverage", `${ready}/${schools.length} 所`);
}
let logoRetryTimer = 0;
let logoRetryCount = 0;

// 被限流时不丢批次：等窗口过去后自动续跑，用户不需要刷新页面。
function scheduleLogoRetry(response) {
  if (logoRetryTimer || logoRetryCount >= 6) return;
  logoRetryCount += 1;
  const advice = Number(response?.headers?.get?.("Retry-After") || 60);
  const wait = Math.min(30, Math.max(10, advice)) * 1000;
  logoRetryTimer = window.setTimeout(() => {
    logoRetryTimer = 0;
    void autoFetchLogos([]);
  }, wait);
}

function releaseLogoBatch(batch, { requeue = true } = {}) {
  batch.forEach(school => {
    const key = logoKey(school);
    logoInFlight.delete(key);
    if (requeue) logoPending.set(key, school);
  });
}

async function autoFetchLogos(rows) {
  for (const item of rows || []) {
    const key = logoKey(item.school);
    if (state.logoCache[key]?.logo_url || logoInFlight.has(key)) continue;
    logoPending.set(key, item.school);
  }
  if (state.logoQueueRunning) return state.logoQueuePromise;
  state.logoQueueRunning = true;
  state.logoQueuePromise = (async () => {
    while (logoPending.size) {
      // 后端 LogoBatchRequest 限制单批最多 20 个，这里与之对齐。
      const batch = [...logoPending.values()].slice(0, 20);
      batch.forEach(school => { logoPending.delete(logoKey(school)); logoInFlight.add(logoKey(school)); });
      let response;
      try {
        response = await fetch("/api/school-assets/batch", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ schools: batch }),
        });
      } catch (error) {
        releaseLogoBatch(batch);
        console.warn("校徽补取暂不可用", error);
        return;
      }
      if (response.status === 429) {
        releaseLogoBatch(batch);
        scheduleLogoRetry(response);
        return;
      }
      if (!response.ok) {
        releaseLogoBatch(batch);
        return;
      }
      const data = await response.json();
      Object.entries(data.assets || {}).forEach(([school, asset]) => attachLogoAsset(school, asset));
      releaseLogoBatch(batch, { requeue: false });
      logoRetryCount = 0;
    }
  })().finally(() => { logoInFlight.clear(); state.logoQueueRunning = false; });
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

// 视图切换只依靠 CSS 里的 .view.active 入场；不再强制回流重放动画。
function resizeCharts() {
  Object.values(state.charts).forEach((chart) => chart?.resize());
}

function switchView(view) {
  document.querySelectorAll(".primary-nav button").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  document.querySelectorAll(".view").forEach((node) => {
    node.classList.toggle("active", node.id === `view-${view}`);
  });
  updateNavIndicator();
  requestAnimationFrame(resizeCharts);
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
    renderLeftAnalytics();
    renderMobileApp();
  } catch (error) {
    console.error(error);
    toast("资料摘要加载失败");
  }
}

async function loadModelReport() {
  state.modelReport = null;
  try {
    state.modelReport = await fetchJson("/api/v1/model-report");
  } catch (error) {
    console.warn("模型回测报告暂不可用", error);
  }
  renderPrecisionPanels();
}

async function generateList(options = {}) {
  const showLoader = Boolean(options.entryLoader);
  const scoreInput = el("scoreInput");
  const rankInput = el("rankInput");
  if (!scoreInput?.reportValidity()) {
    scoreInput?.focus();
    return;
  }
  if (rankInput && !rankInput.reportValidity()) {
    rankInput.focus();
    return;
  }
  const scoreText = String(scoreInput.value ?? "").trim();
  const score = Number(scoreText);
  const currentRank = state.currentRank;
  if (!Number.isInteger(score) || score < 0 || score > 750) {
    scoreInput.reportValidity();
    scoreInput.focus();
    return;
  }
  if (currentRank !== null && (!Number.isInteger(currentRank) || currentRank < 1)) {
    rankInput?.reportValidity();
    rankInput?.focus();
    return;
  }
  if (showLoader && !options.loaderVisible) showEntryLoader();
  state.score = score;
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

    // 请求与品牌开场同时开始，开场结束后仅在请求未完成时显示等待。
    if (showLoader) state.entryMinimum.then(() => { if (document.body.dataset.motionStatus === "loading") setEntryLoaderStep("school", "仍在等待推荐数据，请稍候…"); });
    const request = { score: state.score, risk: state.risk };
    if (state.currentRank !== null) request.current_rank = state.currentRank;
    const data = await fetchRecommendations(request);
    const hidden = new Set(state.hiddenUnitIds || []);
    state.list = (data.list || []).filter((item) => !hidden.has(item.unit_id));
    state.alternates = (data.alternates || []).filter((item) => !hidden.has(item.unit_id));
    fillOpenSlots();
    primeLogoCache();
    state.list.forEach((item) => {
      if (item.logo_asset) attachLogoAsset(item.school, item.logo_asset);
    });
    if (showLoader) setEntryLoaderStep("plan", "已完成计划校准和风险分层。");

    state.summary = data.summary || {};
    if (showLoader) setText("entryNumbers", `${state.score} 分 · ${formatInt(state.summary.predicted_user_rank ?? state.summary.user_rank)} 名`);
    renderAll();
    if (showLoader) setEntryLoaderStep("school", "正在生成院校排序、详情卡片和资料说明。");

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
      item.city,
      item.subject_requirement,
      schoolCity(item),
      guide(item).dormitory,
      guide(item).canteen,
      guide(item).employment,
      guide(item).postgraduate_recommendation,
      guide(item).transfer_policy,
      ladder(item).campus_facilities,
    ].join(" ").toLowerCase();
    const riskOk = state.riskFilter === "all" || (state.riskFilter === "冲" ? ["强冲", "冲"].includes(item.risk_level) : item.risk_level === state.riskFilter);
    const ownershipOk = state.ownershipFilter === "all" || normalizeOwnershipCategory(schoolOwnership(item)) === normalizeOwnershipCategory(state.ownershipFilter);
    const quickOk =
      state.quickFilter === "all" ||
      (state.quickFilter === "life" && hasLifeData(item));
    return riskOk && ownershipOk && quickOk && (!query || guideText.includes(query));
  });
  const sorters = {
    order: (a, b) => asNumber(a.order, 999) - asNumber(b.order, 999),
    confidence: compareProbabilityDesc,
    life: (a, b) => coverageScore(b) - coverageScore(a),
    tuition: (a, b) => tuitionSortValue(a) - tuitionSortValue(b),
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
  requestAnimationFrame(resizeCharts);
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
        ${logoHtml(item.logo_asset || state.logoCache[logoKey(item.school)], item.school)}
        <div>
          <h2>${escapeHtml(item.school)}</h2>
          <p>${escapeHtml(item.major)} · ${escapeHtml(schoolOwnership(item))}</p>
        </div>
        <span class="pill ${riskTone(item)}">${escapeHtml(item.risk_level || "待判断")}</span>
      </div>
      <div class="mobile-card-meta">
        <span>分数 ${escapeHtml(item.score_range || "-")}</span>
        <span>位次 ${escapeHtml(item.rank_range || "-")}</span>
        <span>概率 ${probabilityText(item)}</span>
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
        ${mobileKpi("资料源文件", formatCount(state.resources?.coverage?.source_files ?? state.resources?.total_files), "资料统计")}
      </div>
      <article class="mobile-detail-block">
        <h2>风险分布</h2>
        <div class="mobile-risk-list">${riskRows || "<p>等待生成推荐。</p>"}</div>
      </article>
      <div class="mobile-section-title">
        <div>
          <h1>优先查看</h1>
          <p>按录取概率、可用生活信息和性价比综合排序。</p>
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
        ${logoHtml(profile?.asset || item.logo_asset || state.logoCache[logoKey(item.school)], item.school)}
        <div>
          <h2>${escapeHtml(item.school)}</h2>
          <p>${escapeHtml(item.major)} · ${escapeHtml(schoolOwnership(item))} · ${escapeHtml(textOr(item.school_tier_label, "层次待核验"))}</p>
        </div>
      </article>
      <button class="mobile-dismiss" id="mobileDismissCurrentBtn" type="button">不感兴趣</button>
      <div class="mobile-detail-grid">
        ${mobileKpi("预测分数", item.score_range || "-")}
        ${mobileKpi("预测位次", item.rank_range || "-")}
        ${mobileKpi("录取概率", probabilityText(item))}
        ${mobileKpi("资料覆盖", profileCoverageText(profile))}
      </div>
      <article class="mobile-detail-block">
        <h2>为什么推荐</h2>
        <p>${escapeHtml(item.explanation || "暂无推荐解释")}</p>
      </article>
      <article class="mobile-detail-block">
        <h2>院校与选科</h2>
        <p>城市：${escapeHtml(schoolCity(item))}</p>
        <p>选科要求：${escapeHtml(textOr(item.subject_requirement, "待核验"))}</p>
        <p>学校官网：${officialSiteHtml(item.official_site)}</p>
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
  const cards = [...(resources.source_cards || []), ...resourceCoverageCards(resources.coverage)];
  const backtest = state.modelReport?.time_out_2026_metrics_without_future_plan;
  const backtestSummary = backtest
    ? `${formatCount(backtest.rows)} 个样本 · 平均绝对位次误差 ${formatCount(backtest.mae_rank)} 名 · 10%误差内 ${formatPercent(backtest.within_10pct, 1)}`
    : "模型回测报告未提供。";
  return `
    <section class="mobile-step">
      <div class="mobile-section-title">
        <div>
          <h1>资料说明</h1>
          <p>展示实际模型结构、回测指标与资料覆盖统计。</p>
        </div>
      </div>
      <div class="mobile-sources-grid">
        <article class="mobile-source-card">
          <h2>CatBoost 位次回归</h2>
          <p>按招生历史和院校专业特征预测2027投档位次。</p>
        </article>
        <article class="mobile-source-card">
          <h2>残差分位区间</h2>
          <p>使用交叉校准残差估计位次预测区间；区间不是录取保证。</p>
        </article>
        <article class="mobile-source-card">
          <h2>2026时间外回测</h2>
          <p>${escapeHtml(backtestSummary)}</p>
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
}

function normalizeDecisionTableHeader() {
  const headRow = document.querySelector(".decision-table thead tr");
  if (!headRow) return;
  const labels = ["序", "更换", "校徽", "院校 / 专业", "风险", "2024 / 2025 / 2026 / 2027预测", "计划 / 学费", "吃住 / 发展 / 评价", "操作"];
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
  setText("metricRankCurrent", formatInt(summary.user_rank));
  setText("metricRankCurrentLabel", state.currentRank === null ? "当前分数映射位次" : "手动输入位次");
  setText("metricRankCurrentBasis", state.currentRank === null ? "按2026一分一段表" : "用户输入");
  setText("metricRank", formatInt(state.currentRank ?? summary.predicted_user_rank ?? summary.user_rank));
  setText("metricRankBasis", state.currentRank === null ? "按2026一分一段表" : "手动输入位次");
  // 自动换算时展示后端位次；手动输入后保留用户填写值。
  const rankInput = el("rankInput");
  if (rankInput) rankInput.value = state.currentRank ?? summary.predicted_user_rank ?? summary.user_rank ?? "";
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
      const recommendation = [...state.list, ...state.alternates].find((item) => item.unit_id === unitId);
      if (recommendation) Object.assign(recommendation, detail);
      renderDetail();
      renderTable();
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
    historyRecord(item, 2026).rank ||
    item?.rank_high ||
    999999999,
    999999999,
  );
}

function algorithmBriefHtml() {
  const report = state.modelReport || {};
  const backtest = report.time_out_2026_metrics_without_future_plan;
  const calibration = report.crossfit_calibration || {};
  const backtestText = backtest
    ? `${formatCount(backtest.rows)} 个样本；平均绝对位次误差 ${formatCount(backtest.mae_rank)} 名；误差在10%内 ${formatPercent(backtest.within_10pct, 1)}`
    : "模型回测报告未提供。";
  const coverageValue = calibration.q10_q90_coverage;
  const intervalText = coverageValue === null || coverageValue === undefined
    ? "交叉校准覆盖率未提供。"
    : `Q10—Q90区间的交叉校准覆盖率为 ${formatPercent(coverageValue, 1)}。`;
  return `
    <section class="algorithm-brief source-card">
      <div class="algorithm-showcase">
        <div class="algorithm-hero">
          <span>实际部署模型</span>
          <h2>CatBoost 位次回归</h2>
          <p>模型输出2027预测投档位次，并使用校准后的残差分位数生成不确定区间。</p>
        </div>
      </div>
      <div class="formula-grid">
        <article class="formula-card">
          <span>预测方法</span>
          <h3>CatBoost 回归</h3>
          <p>对招生历史中的院校专业位次进行回归预测。</p>
        </article>
        <article class="formula-card">
          <span>预测区间</span>
          <h3>残差分位校准</h3>
          <p>${escapeHtml(intervalText)}</p>
        </article>
        <article class="formula-card">
          <span>2026时间外回测</span>
          <h3>真实评估统计</h3>
          <p>${escapeHtml(backtestText)}</p>
        </article>
      </div>
    </section>
  `;
}

function renderSources() {
  const node = el("sourcesBoard");
  if (!node) return;
  const resources = state.resources || {};
  const cards = [...(resources.source_cards || []), ...resourceCoverageCards(resources.coverage)];
  node.innerHTML = algorithmBriefHtml() + cards.map((item) => `
    <article class="source-card">
      <span>${escapeHtml(item.status || item.confidence || "-")}</span>
      <h3>${escapeHtml(item.title || "资料来源")}</h3>
      <p>${escapeHtml(item.description || "")}</p>
      <small>重要填报前请以招生章程和学校官方发布为准。</small>
    </article>
  `).join("");
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
  const predictedRank = nullableHistoryValue(state.summary?.score_mapped_rank ?? state.summary?.user_rank);
  const projectionRows = Array.isArray(state.summary?.segment_projection) ? state.summary.segment_projection : [];
  const rows = projectionRows.length
    ? projectionRows.map((row) => ({
      score: asNumber(row.score),
      rank: asNumber(row.predicted_rank),
      sameBand: asNumber(row.same_band),
      label: row.label || "待核验",
    })).filter((row) => row.score >= 0 && row.rank > 0)
    : predictedRank === null ? [] : [{ score: state.score, rank: predictedRank, sameBand: null, label: "当前分" }];
  setText("segmentScore", state.score);
  setText("segmentRank", predictedRank === null ? "待核验" : formatInt(predictedRank));
  setText("segmentShift", "2026表");
  body.innerHTML = rows.length ? rows.map((row) => `
    <tr>
      <td>${row.score}</td>
      <td>${formatInt(row.rank)}</td>
      <td>${row.sameBand === null ? "-" : formatInt(row.sameBand)}</td>
      <td><span class="status-chip ${segmentTone(row.label)}">${escapeHtml(row.label)}</span></td>
    </tr>
  `).join("") : `<tr><td colspan="4">位次资料未提供</td></tr>`;
  renderRankTrendMini();
}

function logoHtml(asset, school) {
  const cached = state.logoCache[logoKey(school)];
  if (!asset?.logo_url && cached?.logo_url) asset = cached;
  const clean = String(asset?.label || school || "校").replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "");
  const label = escapeHtml(clean.slice(0, 2) || "校徽");
  const title = escapeHtml(asset?.message || "图像待核验");
  if (asset?.logo_url) {
    return `<div class="school-logo" data-school="${escapeHtml(school)}" data-label="${label}" title="${title}"><img src="${escapeHtml(asset.logo_url)}" alt="${escapeHtml(school)}校徽" onerror="this.parentElement.classList.add('logo-failed');this.remove()" /></div>`;
  }
  return `<div class="school-logo logo-placeholder" data-school="${escapeHtml(school)}" data-label="${label}" title="${title}">${label}</div>`;
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

  // 先写入起始状态，下一帧再测量并启动动画：避免同一帧内读写布局互相打断。
  const startHeight = shouldOpen ? "0px" : `${answerList.scrollHeight}px`;
  answerList.style.height = startHeight;
  answerList.style.opacity = shouldOpen ? "0" : "1";
  answerList.style.transform = shouldOpen ? "translate3d(0, -6px, 0)" : "translate3d(0, 0, 0)";
  if (shouldOpen) {
    details.open = true;
    setCollegesChatQuestionOpen(details, true);
  } else {
    setCollegesChatQuestionOpen(details, false);
  }

  let animation = null;
  const finish = () => {
    if (details.dataset.qaMotionToken !== token) return;
    animation?.cancel();
    delete details.dataset.qaMotionToken;
    delete details.dataset.motionState;
    details.classList.remove("is-animating");
    details.open = shouldOpen;
    setCollegesChatQuestionOpen(details, shouldOpen);
    answerList.style.height = "";
    answerList.style.opacity = "";
    answerList.style.transform = "";
  };

  requestAnimationFrame(() => {
    if (details.dataset.qaMotionToken !== token) return;
    const endHeight = shouldOpen ? `${answerList.scrollHeight}px` : "0px";
    animation = answerList.animate([
      { height: startHeight, opacity: shouldOpen ? 0 : 1, transform: shouldOpen ? "translate3d(0, -6px, 0)" : "translate3d(0, 0, 0)" },
      { height: endHeight, opacity: shouldOpen ? 1 : 0, transform: shouldOpen ? "translate3d(0, 0, 0)" : "translate3d(0, -4px, 0)" },
    ], {
      duration: shouldOpen ? 220 : 180,
      easing: "cubic-bezier(.22, 1, .36, 1)",
      fill: "both",
    });
    animation.finished.then(finish).catch(() => {});
  });
  window.setTimeout(finish, 600);
}

function handleCollegesChatQuestionClick(event) {
  const summary = event.target.closest(".colleges-chat-question > summary");
  if (!summary) return;
  event.preventDefault();
  const details = summary.parentElement;
  const shouldOpen = !details.open || details.dataset.motionState === "closing";
  animateCollegesChatQuestion(details, shouldOpen);
}

function renderPrecisionPanels() {
  const diagnostic = el("diagnosticPanel");
  if (!diagnostic) return;

  const report = state.modelReport;
  const metrics = report?.time_out_2026_metrics_without_future_plan;
  if (!metrics) {
    diagnostic.innerHTML = `<p>模型报告未提供。</p>`;
    return;
  }
  const rows = [
    ["回测样本", metrics.rows, "条"],
    ["平均绝对位次误差", metrics.mae_rank, "名"],
    ["位次误差中位数", metrics.median_ae_rank, "名"],
    ["误差在10%内", metrics.within_10pct, "%"],
  ].filter(([, value]) => value !== null && value !== undefined && Number.isFinite(Number(value)));
  diagnostic.innerHTML = rows.map(([label, value, unit]) => {
    const formatted = unit === "%" ? `${(Number(value) * 100).toFixed(1)}%` : `${formatInt(value)}${unit}`;
    return `<div class="diagnostic-row" style="grid-template-columns:minmax(0,1fr) auto"><span>${escapeHtml(label)}</span><strong class="diagnostic-value">${escapeHtml(formatted)}</strong></div>`;
  }).join("") || `<p>模型报告未提供。</p>`;
}

function renderLifeGrid() {
  const node = el("lifeGrid");
  if (!node) return;
  const rows = [...state.list].sort((a, b) => coverageScore(b) - coverageScore(a)).slice(0, 96);
  node.innerHTML = rows.map((item) => `
    <article class="life-card dense-life-card" data-unit="${escapeHtml(item.unit_id)}">
      <div class="life-card-head">
        ${logoHtml(item.logo_asset || state.logoCache[logoKey(item.school)], item.school)}
        <div>
          <span>${escapeHtml(schoolOwnership(item))} · ${escapeHtml(textOr(item.school_tier_label, "层次待核验"))}</span>
          <h3>${escapeHtml(item.school)}</h3>
        </div>
      </div>
      <p><strong>宿舍</strong>：${escapeHtml(dormText(item))}</p>
      <p><strong>食堂</strong>：${escapeHtml(canteenText(item))}</p>
      <p><strong>位置</strong>：${escapeHtml(schoolCity(item))}</p>
      <small>可用资料项 ${coverageScore(item)}/6 · 点击查看院校详情</small>
    </article>
  `).join("");
}

function renderLeftAnalytics() {
  const rankBars = el("leftRankBars");
  const structureBars = el("leftBandBars");
  if (!rankBars || !structureBars) return;
  const mapped = validCount(state.summary?.score_mapped_rank ?? state.summary?.user_rank);
  const predicted = validCount(state.summary?.predicted_user_rank ?? state.summary?.user_rank);
  const ranks = state.list.map(recommendationRankValue).filter((rank) => rank < 999999999);
  const avgRank = ranks.length ? Math.round(ranks.reduce((sum, rank) => sum + rank, 0) / ranks.length) : null;
  const delta = mapped !== null && predicted !== null ? predicted - mapped : null;
  setText("leftRankDelta", delta === null ? "待核验" : delta ? `${delta > 0 ? "+" : ""}${formatInt(delta)}` : "一致");
  const rankRows = [
    ["当前分数映射", mapped],
    ["系统位次结果", predicted],
    ["候选均值", avgRank],
  ];
  const maxRank = Math.max(...rankRows.map(([, value]) => value || 0), 1);
  rankBars.innerHTML = rankRows.map(([label, value], index) => `
    <div class="left-bar-row">
      <span>${label}</span>
      <div class="left-bar"><i style="--value:${value === null ? 0 : Math.round((value / maxRank) * 100)}%;--bar:${index === 1 ? "#16865a" : "#1558b0"}"></i></div>
      <b>${value === null ? "待核验" : formatInt(value)}</b>
    </div>
  `).join("");

  const structureRows = coverageStats(state.resources?.coverage);
  const basicCoverage = structureRows.find(([label]) => label === "院校基础资料");
  setText("leftBandTotal", basicCoverage?.[2] > 0 ? `${((basicCoverage[1] / basicCoverage[2]) * 100).toFixed(1)}%` : "待提供");
  structureBars.innerHTML = structureRows.map(([label, count, total], index) => {
    const percent = total > 0 ? Math.min(100, (count / total) * 100) : 0;
    const color = index < 3 ? "#1558b0" : "#16865a";
    return `
    <div class="left-bar-row">
      <span>${label}</span>
      <div class="left-bar"><i style="--value:${percent.toFixed(1)}%;--bar:${color}"></i></div>
      <b>${coverageCountText(count, total)}</b>
    </div>
  `;
  }).join("") || `<div class="left-bar-row"><span>覆盖统计</span><b>未提供</b></div>`;
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

function admissionProbability(item) {
  const raw = item?.admission_probability;
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) return null;
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  const probability = Number(raw);
  return Number.isFinite(probability) && probability >= 0 && probability <= 1 ? probability : null;
}

function compareProbabilityDesc(a, b) {
  const probabilityA = admissionProbability(a);
  const probabilityB = admissionProbability(b);
  if (probabilityA === null) return probabilityB === null ? 0 : 1;
  if (probabilityB === null) return -1;
  return probabilityB - probabilityA;
}

function rankGapText(item) {
  const userRank = asNumber(state.summary?.predicted_user_rank, state.summary?.user_rank || 0);
  const target = asNumber(item?.predicted_rank || item?.rank_mid, 0);
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
    return compareProbabilityDesc(a, b);
  });
}

function mobileOverviewPriorityRows() {
  const rows = [...state.list].filter((item) => item?.unit_id);
  const compare = (a, b) => {
    const coverageDiff = coverageScore(b) - coverageScore(a);
    if (coverageDiff) return coverageDiff;
    const probabilityDiff = compareProbabilityDesc(a, b);
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
  const coverage = resources.coverage || {};
  const ready = asNumber(resources.logo_ready_count, 0);
  const total = asNumber(resources.logo_total_count, 0);
  const cards = (resources.source_cards || []).filter((item) => !String(item.title || "").includes("校徽"));
  setText("resourceFiles", formatCount(coverage.source_files ?? resources.total_files ?? resources.guizhou_files));
  const schoolsWithBasic = validCount(coverage.schools_with_basic);
  const schoolsTotal = validCount(coverage.schools_total);
  setText("guideCount", schoolsWithBasic !== null && schoolsTotal !== null
    ? coveragePercentText(schoolsWithBasic, schoolsTotal)
    : formatCount(resources.school_guide_count ?? resources.school_ladder_count));
  updateLogoCount();
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
    board.innerHTML = algorithmBriefHtml() + [...cards, ...resourceCoverageCards(coverage)].map((item) => `
      <article class="source-card">
        <span>${escapeHtml(item.status || item.confidence || "-")}</span>
        <h3>${escapeHtml(item.title)}</h3>
        <p>${escapeHtml(item.description || "")}</p>
      </article>
    `).join("");
  }
}

function renderPriorityList() {
  const node = el("priorityList");
  if (!node) return;
  const rows = selectedRowsByRisk().slice(0, 96);
  node.innerHTML = rows.map((item, index) => {
    const rankText = item.rank_range || `${formatInt(item.rank_low || item.predicted_rank_low || item.predicted_rank || 0)}-${formatInt(item.rank_high || item.predicted_rank_high || item.predicted_rank || 0)}`;
    const scoreText = item.score_range || `${item.predicted_score_low || item.score_low || "-"}-${item.predicted_score_high || item.score_high || "-"}`;
    const info = `${scoreText} / ${rankText} · ${rankGapText(item)}`;
    return `
      <article class="priority-card priority-row priority-${riskTone(item)}" data-unit="${escapeHtml(item.unit_id)}">
        <strong class="priority-index">${index + 1}</strong>
        ${logoHtml(item.logo_asset || state.logoCache[logoKey(item.school)], item.school)}
        <div class="priority-main">
          <h3><span class="pill ${riskTone(item)}">${escapeHtml(item.risk_level || "待判定")}</span><span class="priority-name">${escapeHtml(item.school)} · ${escapeHtml(item.major)}</span></h3>
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
  markFirstPaint(node, "priority");
}

function profileCard(row) {
  const value = textOr(row?.value, "待核验");
  const valueUrl = safeHttpUrl(value);
  const source = textOr(row?.source || row?.source_type, "资料来源");
  const metadata = [
    row?.confidence ? `可信度${row.confidence}` : "",
    row?.year ? `年份 ${row.year}` : "",
    row?.retrieved_at ? `更新于 ${row.retrieved_at}` : "",
    row?.license ? `许可 ${row.license}` : "",
    row?.verify_hint || "建议复核",
  ].filter(Boolean);
  const sourceLink = httpLinkHtml(row?.source_url, "查看来源");
  return `
    <article class="info-card profile-info-card">
      <span>${escapeHtml(row?.title || "资料")}</span>
      <strong>${valueUrl ? httpLinkHtml(valueUrl) : escapeHtml(value)}</strong>
      <small>${escapeHtml([source, ...metadata].join(" · "))}${sourceLink ? ` · ${sourceLink}` : ""}</small>
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
  const sourceLink = httpLinkHtml(chat.source_url, "GitHub 原文");
  const pageLink = httpLinkHtml(chat.page_url, "源站页面");
  const licenseLink = safeHttpUrl(chat.license_url)
    ? httpLinkHtml(chat.license_url, chat.license || "CC BY-NC-SA 4.0")
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
      <p><b>${escapeHtml(answer.id || "匿名")}</b>：${escapeHtml(answer.text || "")}${answer.date ? ` <small>· ${escapeHtml(answer.date)}</small>` : ""}</p>
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
    title: source.title || source.type || "来源汇总",
    value: `${source.confidence || "中"} · ${source.updated || "随资料更新"}`,
    source: source.source || source.type || "来源汇总",
    source_type: source.source_type || "来源汇总",
    confidence: source.confidence || "中",
    year: source.year,
    retrieved_at: source.retrieved_at || source.updated,
    source_url: source.source_url,
    license: source.license,
    verify_hint: source.verify_hint || "可回到资料说明页核验",
  })).filter((row) => !String(row.title).includes("校徽"));
  const decisionRows = [
    { title: "当前推荐风险", value: `${current.risk_level || "待判定"} · ${probabilityText(current)} · ${rankGapText(current)}`, source_type: "推荐模型", confidence: "中高", verify_hint: "随选择院校联动" },
    { title: "2024—2027位次与分数", value: historySummaryText(current), source_type: "录取历史与模型预测", confidence: "中", verify_hint: "历史值缺失时显示待核验；2027为模型预测" },
    { title: "选科要求", value: textOr(current.subject_requirement, "待核验"), source_type: "招生计划", confidence: "中", verify_hint: "以当年招生章程为准" },
    { title: "宿舍摘要", value: dormText(current), source_type: "院校资料表", confidence: "中高", verify_hint: "建议复核校区" },
    { title: "食堂摘要", value: canteenText(current), source_type: "院校资料表", confidence: "中", verify_hint: "公开资料可能滞后" },
    { title: "就业保研", value: employmentText(current), source_type: "院校资料表", confidence: "中", verify_hint: "以就业质量报告为准" },
    { title: "转专业", value: textOr(guide(current).transfer_policy, "待核验"), source_type: "院校资料表", confidence: "中", verify_hint: "需复核当年政策" },
    { title: "学费", value: tuitionText(current), source_type: "招生计划", confidence: "中", verify_hint: "以招生章程为准" },
  ];
  const seen = new Set();
  const uniqueRows = (rows) => rows.filter((row) => {
    const key = `${row.title}-${row.value}-${row.source_url || ""}`;
    if (seen.has(key) || String(row.title || "").includes("校徽")) return false;
    seen.add(key);
    return true;
  });
  const header = `
    <div class="profile-hero">
      ${logoHtml(profile.asset, profile.school)}
      <div>
        <h2>${escapeHtml(profile.school)}</h2>
        <p>${escapeHtml(textOr(current.city || profile.headline?.city, "城市待核验"))} · ${escapeHtml(textOr(current.ownership || profile.headline?.ownership, "性质待核验"))} · ${escapeHtml(profile.headline?.tier || "层次待核验")}</p>
      </div>
    </div>
    <div class="profile-kpis dense">
      <div><span>候选专业</span><strong>${profile.headline?.major_count ?? "-"}</strong></div>
      <div><span>2026最低位次</span><strong>${formatInt(profile.headline?.min_rank_2026)}</strong></div>
      <div><span>学费范围</span><strong>${escapeHtml(profile.headline?.tuition_range || "待核验")}</strong></div>
      <div><span>资料覆盖</span><strong>${escapeHtml(profileCoverageText(profile))}</strong></div>
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
    markEntering(node, `profile:${profile.school}:${state.activeProfileTab}`);
    return;
  }
  if (state.activeProfileTab === "official") {
    const officialRows = [
      { title: "官网", value: profile.official?.official_site || current.official_site || "官网待补全", source_type: "公开官网", confidence: "中", verify_hint: "建议人工打开复核" },
      { title: "招生网", value: profile.official?.admission_site || "招生网待补全", source_type: "本科招生网", confidence: "中", verify_hint: "招生政策以该来源为准" },
      { title: "招生电话", value: profile.official?.admission_phone || "待核验", source_type: "院校资料表", confidence: "中", verify_hint: "重要信息建议电话复核" },
      { title: "公开邮箱", value: profile.official?.email || "待核验", source_type: profile.official?.public_source_type || "公开资料", confidence: "中", verify_hint: "缺失时显示待核验" },
      ...sourceRows,
    ];
    node.innerHTML = header + `<div class="info-grid profile-dense-grid">${uniqueRows(officialRows).map(profileCard).join("")}</div>`;
    markEntering(node, `profile:${profile.school}:${state.activeProfileTab}`);
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
  markEntering(node, `profile:${profile.school}:${state.activeProfileTab}`);
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
      ${logoHtml(profile?.asset || item.logo_asset || state.logoCache[logoKey(item.school)], item.school)}
      <div>
        <h2>${escapeHtml(item.school)}</h2>
        <p>${escapeHtml(item.major)} · ${escapeHtml(schoolOwnership(item))} · ${escapeHtml(textOr(item.school_tier_label, "层次待核验"))}</p>
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
      <div><span>资料覆盖</span><strong>${escapeHtml(profileCoverageText(profile))}</strong></div>
    </div>
    <section class="detail-section">
      <h3>2024—2027录取数据与预测</h3>
      ${yearTrendHtml(item)}
      <p class="rank-gap-line">${escapeHtml(rankGapText(item))}</p>
    </section>
    <section class="detail-section">
      <h3>选科与官网</h3>
      <p>选科要求：${escapeHtml(textOr(item.subject_requirement, "待核验"))}</p>
      <p>学校官网：${officialSiteHtml(item.official_site)}</p>
    </section>
    <section class="detail-section">
      <h3>为什么推荐</h3>
      <p>${escapeHtml(item.explanation || "暂无推荐解释")}</p>
    </section>
    <section class="detail-section">
      <h3>吃住环境</h3>
      <p>城市：${escapeHtml(schoolCity(item))}</p>
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
  // 只有换院校时才整块入场；同一院校的二次数据回填不再重放动画。
  markEntering(node, `detail:${item.unit_id}`);
}

function renderRankTrendMini() {
  if (el("entryLoader") && !el("entryLoader").hidden) return;
  const chart = getChart("rankTrendMini");
  if (!chart) return;
  const selected = state.selected || state.list[0] || {};

  const ranks = [2024, 2025, 2026, 2027].map((year) => {
    const record = historyRecord(selected, year);
    return record.rank ?? (year === 2027 ? nullableHistoryValue(selected.predicted_rank || selected.rank_mid) : null);
  });
  const availableRanks = ranks.filter((value) => value !== null && value > 0);
  const applicantRank = nullableHistoryValue(state.summary?.predicted_user_rank ?? state.summary?.user_rank);
  const predictedRank = ranks[3];
  const gap = applicantRank !== null && predictedRank !== null ? Math.round(predictedRank - applicantRank) : null;
  const headline = gap === null
    ? availableRanks.length ? "院校录取位次历史" : "暂无可展示的位次历史"
    : gap >= 0 ? `2027预测：你领先 ${formatInt(gap)} 名` : `2027预测：你落后 ${formatInt(Math.abs(gap))} 名`;
  const rankAxis = availableRanks.length
    ? { min: Math.max(1, Math.floor(Math.min(...availableRanks) * 0.92)), max: Math.ceil(Math.max(...availableRanks) * 1.08) }
    : {};
  const trendKey = JSON.stringify([selected.unit_id, ranks, applicantRank]);
  if (chart.__trendKey === trendKey) return;
  // 只有首帧允许动画；之后切换院校直接换数据，避免曲线反复重绘造成的闪动。
  const firstPaint = !chart.__trendPainted;
  chart.__trendPainted = true;
  chart.__trendKey = trendKey;
  chart.setOption({
    animation: firstPaint && !prefersReducedMotion(),
    animationDuration: 240,
    animationDurationUpdate: 0,
    animationEasing: "cubicOut",
    animationEasingUpdate: "cubicOut",
    grid: { left: 62, right: 35, top: 94, bottom: 30 },
    title: {
      text: headline,
      subtext: "历史年份读取录取数据；预测年份读取模型结果",
      left: 10,
      top: 6,
      textStyle: { color: gap !== null && gap >= 0 ? "#16865a" : "#c96b12", fontSize: 14, fontWeight: 900 },
      subtextStyle: { color: "#66758a", fontSize: 11, fontWeight: 800 },
    },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "line", lineStyle: { color: "#8ca3bf", type: "dashed" } },
      borderColor: "#b9c7d8",
      backgroundColor: "rgba(255,255,255,.98)",
      textStyle: { color: "#10213d", fontSize: 12 },
      formatter: (items) => items
        .filter((entry) => entry.value !== null && entry.value !== undefined && Number.isFinite(Number(entry.value)))
        .map((entry) => `${entry.marker}${entry.seriesName}: ${formatInt(entry.value)}名`)
        .join("<br/>"),
    },
    legend: {
      top: 61,
      left: 12,
      itemWidth: 20,
      itemHeight: 8,
      textStyle: { color: "#52627a", fontSize: 12, fontWeight: 800 },
    },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: ["2024", "2025", "2026", "2027预测"],
      axisTick: { show: false },
      axisLine: { lineStyle: { color: "#d9e2ef" } },
      axisLabel: { color: "#52627a", fontSize: 12, fontWeight: 800 },
    },
    yAxis: {
      type: "value",
      inverse: true,
      ...rankAxis,
      splitNumber: 4,
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: { color: "#66758a", fontSize: 12, formatter: (value) => formatInt(value) },
      splitLine: { lineStyle: { color: "rgba(129,151,178,.24)", type: "dashed" } },
    },
    series: [{
      id: "rank-trend",
      name: `${String(selected.school || "选中院校").slice(0, 10)}最低录取位次`,
      type: "line",
      smooth: 0.18,
      connectNulls: false,
      data: ranks,
      symbol: "circle",
      symbolSize: 11,
      lineStyle: { width: 3, color: "#c96b12", cap: "round" },
      itemStyle: { color: "#fff", borderColor: "#c96b12", borderWidth: 3 },
      label: { show: true, position: "top", color: "#9a4d08", fontWeight: 900, fontSize: 10, formatter: ({ value }) => value == null ? "" : formatInt(value) },
    }],
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
      const plan2025 = historyRecord(item, 2025).plan;
      const plan2026 = historyRecord(item, 2026).plan;
      const planDelta = plan2025 !== null && plan2026 !== null ? plan2026 - plan2025 : null;
      const planDeltaText = planDelta === null ? "计划变化待核验" : `${planDelta >= 0 ? "+" : ""}${planDelta} · 较2025`;
      return `
        <tr class="${selected} table-risk-${riskTone(item)}" data-unit="${escapeHtml(item.unit_id)}" style="--i:${asNumber(item.order, 0)}">
          <td class="metric order-cell"><strong>${item.order || "-"}</strong><small>推荐</small></td>
          <td><button class="replace-btn" data-replace-unit="${escapeHtml(item.unit_id)}" title="换一个同层级候选">更换</button></td>
          <td>${logoHtml(item.logo_asset || state.logoCache[logoKey(item.school)], item.school)}</td>
          <td class="cell-title">
            <strong>${escapeHtml(item.school)}</strong>
            <span>${escapeHtml(item.major)}</span>
            <small>${escapeHtml(schoolCity(item))} · ${escapeHtml(schoolOwnership(item))}</small>
          </td>
          <td><span class="pill ${riskClass(item.risk_level)}">${escapeHtml(riskShort(item.risk_level))}</span><div class="muted-line">${probabilityText(item)}${admissionProbability(item) === null ? "" : " 录取"}</div></td>
          <td>${yearTrendHtml(item)}<small class="rank-gap-inline">${escapeHtml(rankGapText(item))}</small></td>
          <td class="metric"><strong>${plan2026 === null ? "待核验" : `${formatInt(plan2026)}人`}</strong><small>${escapeHtml(planDeltaText)} · ${escapeHtml(tuitionText(item))}</small></td>
          <td>
            <div class="table-briefs">
              <span title="${escapeHtml(dormText(item))}">宿 ${escapeHtml(dormText(item))}</span>
              <span title="${escapeHtml(canteenText(item))}">食 ${escapeHtml(canteenText(item))}</span>
              <span title="${escapeHtml(employmentText(item))}">业 ${escapeHtml(textOr(guide(item).employment || guide(item).postgraduate_recommendation, "待核验"))}</span>
              <b>可用资料项 ${coverageScore(item)}/6</b>
            </div>
          </td>
          <td><button class="row-action" data-unit="${escapeHtml(item.unit_id)}">详情</button></td>
        </tr>
      `;
    }).join("");
  }
  markFirstPaint(body, "table");
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
  el("scoreInput")?.addEventListener("input", () => {
    state.currentRank = null;
    const rankInput = el("rankInput");
    if (rankInput) rankInput.value = "";
    setText("metricRankCurrentLabel", "当前分数映射位次");
    setText("metricRankCurrentBasis", "按2026一分一段表");
    setText("metricRankBasis", "按2026一分一段表");
  });
  el("rankInput")?.addEventListener("input", (event) => {
    const raw = String(event.currentTarget.value ?? "").trim();
    const rank = Number(raw);
    if (!raw) {
      state.currentRank = null;
      setText("metricRankCurrentLabel", "当前分数映射位次");
      setText("metricRankCurrentBasis", "按2026一分一段表");
      setText("metricRankBasis", "按2026一分一段表");
      return;
    }
    if (Number.isInteger(rank) && rank > 0) {
      state.currentRank = rank;
      setText("metricRankCurrentLabel", "手动输入位次");
      setText("metricRankCurrent", formatInt(rank));
      setText("metricRankCurrentBasis", "用户输入");
      setText("metricRankBasis", "手动输入位次");
      setText("metricRank", formatInt(rank));
      return;
    }
    state.currentRank = null;
    setText("metricRankCurrentLabel", "当前分数映射位次");
    setText("metricRankCurrentBasis", "按2026一分一段表");
    setText("metricRankBasis", "位次需为正整数");
  });
  el("generateBtn")?.addEventListener("click", generateList);
  el("refreshBtn")?.addEventListener("click", generateList);
  el("mobileRefreshBtn")?.addEventListener("click", () => generateList());
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
  const scheduleLayoutSync = () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      updateNavIndicator();
      resizeCharts();
    });
  };
  if (window.ResizeObserver) {
    const observer = new ResizeObserver(scheduleLayoutSync);
    document.querySelectorAll(".center-stage, .right-rail, .mini-chart, .donut-box").forEach((node) => observer.observe(node));
  } else {
    window.addEventListener("resize", scheduleLayoutSync, { passive: true });
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
  loadModelReport();
  generateList(options);
  ensureECharts()
    .then(() => renderAll())
    .catch((error) => console.warn("图表资源暂不可用", error));
}

function setScoreValue(score) {
  const text = String(score ?? "").trim();
  if (!text) return null;
  const number = Number(text);
  if (!Number.isInteger(number) || number < 0 || number > 750) return null;
  const clean = number;
  state.score = clean;
  if (el("scoreInput")) el("scoreInput").value = clean;
  if (el("entryScoreInput")) el("entryScoreInput").value = clean;
  return clean;
}

function enterDesktopAppFromScore() {
  const input = el("entryScoreInput");
  if (!input?.reportValidity()) {
    input?.focus();
    return;
  }
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
  document.body.dataset.scoreGate = "closed";
  startDesktopApp({ entryLoader: true, loaderVisible: true });
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
