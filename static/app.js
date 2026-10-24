import { state } from "./js/state.js?v=20261023s";
import { fetchJson, fetchRecommendations, isAbortError } from "./js/api.js?v=20261023s";
import { countUp, prefersReducedMotion } from "./js/motion.js?v=20261023s";

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
  // 子元素按顺序依次入场，冒泡上来的 animationend 会提前掐断后面的动画，所以只靠定时器收尾。
  window.setTimeout(clear, ENTER_CLEAR_DELAY);
}

const ENTER_CLEAR_DELAY = 2600;

// 开场遮罩下已经播完的入场动画，在界面露出时再播一遍。
function replayEntering(node, className = "is-entering", duration = ENTER_CLEAR_DELAY) {
  if (!node || prefersReducedMotion()) return;
  node.classList.remove("is-entering", "is-refreshing");
  void node.offsetWidth;
  node.classList.add(className);
  const token = (node.__enterToken || 0) + 1;
  node.__enterToken = token;
  window.setTimeout(() => {
    if (node.__enterToken === token) node.classList.remove(className);
  }, duration);
}

const formatCountUp = (value) => Math.round(value).toLocaleString("zh-CN");

// 数字从 0 滚动到目标值。
function setCount(id, value, format = formatCountUp) {
  const node = el(id);
  if (!node) return;
  const number = value === null || value === undefined || value === "" ? NaN : Number(value);
  if (!Number.isFinite(number)) {
    node.textContent = "-";
    delete node.dataset.countValue;
    return;
  }
  if (node.dataset.countValue === String(number)) return;
  countUp(node, number, { format });
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

// 开场动画固定播放约 5 秒（数据更慢时等数据），结束后界面依次入场。
const ENTRY_MIN_DURATION = 5200;
const ENTRY_FADE_DURATION = 600;

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
  revealApp();
  renderRankTrendMini();
}

function revealApp() {
  document.body.dataset.revealed = "true";
  // 开场入场动画只在这几秒内生效，之后切换页面不会重播。
  document.body.classList.add("is-revealing");
  window.setTimeout(() => document.body.classList.remove("is-revealing"), 3000);
  replayEntering(el("priorityList"));
  replayEntering(el("detailPanel"));
  // 风险环形图在开场遮罩下已经画完，清掉重画一次，让扇形展开动画露出来。
  ["riskDonut", "chartScatter", "chartProb", "chartCity"].forEach((id) => {
    state.charts[id]?.clear();
    if (state.charts[id]) state.charts[id].__key = null;
  });
  renderRiskChart();
  renderDashboardCharts();
  // 顶部数字在遮罩下已经滚完，清掉记录再从 0 滚一次。
  document.querySelectorAll(".hero-strip strong").forEach((node) => delete node.dataset.countValue);
  renderSummary();
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

const ANIMATED_CHART_IDS = new Set(["rankTrendMini", "riskDonut", "chartDiag", "chartSelection", "chartBaseline", "chartResidual", "chartProbCurve", "chartScatter", "chartProb", "chartCity", "chartMajors", "chartCoverage", "chartModel"]);

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
  // 详情页、资料页的图表节点会随内容重新渲染，旧实例脱离页面后要重建。
  if (state.charts[id] && state.charts[id].getDom() !== node) {
    state.charts[id].dispose();
    delete state.charts[id];
  }
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
  // 列表接口只带 4 年位次（rank_trend），详情接口才有分数、计划等完整历史。
  if (!history && Array.isArray(item?.rank_trend)) {
    const index = year - 2024;
    return {
      year: label,
      rank: nullableHistoryValue(item.rank_trend[index]),
      score: year === 2026 ? nullableHistoryValue(item.score_2026) : null,
      plan: year === 2026 ? nullableHistoryValue(item.plan_2026) : null,
      admitted: year === 2026 ? nullableHistoryValue(item.admitted_2026) : null,
      sourceUrl: null,
    };
  }
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

// 院校资料还在加载时显示占位条，不写“未提供”；只有数据确实缺失时才写“未提供”。
function detailCoverageHtml(profile) {
  if (!profile && state.selectedProfileStatus === "loading") return `<strong class="value-loading" aria-label="资料加载中"></strong>`;
  const coverage = profile?.headline?.coverage;
  const number = coverage === null || coverage === undefined || coverage === "" ? NaN : Number(coverage);
  if (Number.isFinite(number)) return `<strong data-coverage="${number}">${number}%</strong>`;
  return `<strong>${escapeHtml(profileCoverageText(profile))}</strong>`;
}

// 同一院校只滚动一次；之后的静默重绘直接显示最终值。
function animateDetailCoverage(node, item) {
  const target = node.querySelector("[data-coverage]");
  if (!target) return;
  const key = `${item.unit_id}:${target.dataset.coverage}`;
  if (node.dataset.coverageShown === key) return;
  node.dataset.coverageShown = key;
  // 先写 0%，否则第一帧会直接显示终值，看起来还是“跳”出来的。
  target.textContent = "0%";
  target.dataset.countValue = "0";
  countUp(target, Number(target.dataset.coverage), { format: (value) => `${Math.round(value)}%`, duration: 1000 });
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
  el("logoCoverage")?.classList.remove("value-loading");
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
// 只重算看得见、且尺寸真的变了的图表；以前每次切换都把所有图表重算一遍，是卡顿来源之一。
function resizeCharts() {
  Object.values(state.charts).forEach((chart) => {
    if (!chart || chart.isDisposed?.()) return;
    const dom = chart.getDom();
    if (!dom?.offsetWidth) return;
    if (chart.getWidth() === dom.clientWidth && chart.getHeight() === dom.clientHeight) return;
    chart.resize();
  });
}

// 四个页面统一转场：旧页面轻微缩小上浮淡出（左栏同时滑走），布局在不可见的一瞬间切换，
// 新页面内容带一点 3D 倾角依次翻起浮现。只用位移和透明度，不加遮挡层、不给整页拍快照。
const VIEW_LEAVE_MS = 200;
let viewSwitchToken = 0;

function switchView(view) {
  const from = document.body.dataset.view;
  if (from === view || prefersReducedMotion() || document.body.dataset.revealed !== "true") {
    applyView(view);
    return;
  }
  const token = ++viewSwitchToken;
  document.querySelectorAll(".primary-nav button").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  updateNavIndicator();
  const leaving = el(`view-${from}`);
  leaving?.classList.remove("view-entering");
  leaving?.classList.add("view-leaving");
  if (from === "dashboard") document.querySelector(".left-rail")?.classList.add("rail-leaving");
  window.setTimeout(() => {
    if (token !== viewSwitchToken) return;
    document.querySelectorAll(".view-leaving").forEach((node) => node.classList.remove("view-leaving"));
    document.querySelector(".left-rail")?.classList.remove("rail-leaving");
    // 入场类必须和显示新页面在同一刻挂上：晚一帧的话新页面会先完整闪现一下，再变透明重新浮现。
    el(`view-${view}`)?.classList.add("view-entering");
    applyView(view);
    replayEntering(el(`view-${view}`), "view-entering", 1600);
  }, VIEW_LEAVE_MS);
}

function applyView(view) {
  document.querySelectorAll(".primary-nav button").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  document.querySelectorAll(".view").forEach((node) => {
    node.classList.toggle("active", node.id === `view-${view}`);
  });
  updateNavIndicator();
  const from = document.body.dataset.view;
  document.body.dataset.view = view;
  // 图表的尺寸计算和绘制在这里同步做完：此时旧页面已淡出、新页面还没开始入场，
  // 这一下停顿落在画面空白的瞬间，不会打断后面的入场动画。
  resizeCharts();
  if (view === "dashboard") renderDashboardCharts();
  if (view === "profile" && state.activeProfileTab === "admission") renderMajorsChart();
  if (view === "sources") renderSourceCharts();
  if (view === "dashboard" && from !== "dashboard") replayEntering(document.querySelector(".left-rail"), "rail-entering", 600);
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

async function loadModelReport() {
  state.modelReport = null;
  try {
    state.modelReport = await fetchJson("/api/v1/model-report");
  } catch (error) {
    console.warn("模型回测报告暂不可用", error);
  }
  renderPrecisionPanels();
  renderSources();
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
    if (showLoader) {
      el("entryNumbers").innerHTML = `<span id="entryScoreCount">${state.score}</span> 分 · <span id="entryRankCount">0</span> 名`;
      setCount("entryRankCount", state.summary.predicted_user_rank ?? state.summary.user_rank);
    }
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
  renderTierSummary();
  renderDashboardCharts();
  renderPriorityList();
  renderTable();
  normalizeDecisionTableHeader();
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
  const labels = ["序", "院校 / 专业", "风险 · 概率", "位次走势（2024—2027）", "计划 / 学费", "生活资料", "操作"];
  if (headRow.children.length !== labels.length || headRow.children[1]?.textContent.trim() !== "院校 / 专业") {
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
  setCount("metricRankCurrent", summary.user_rank);
  setText("metricRankCurrentLabel", state.currentRank === null ? "当前分数映射位次" : "手动输入位次");
  setText("metricRankCurrentBasis", state.currentRank === null ? "按2026一分一段表" : "用户输入");
  setCount("metricRank", state.currentRank ?? summary.predicted_user_rank ?? summary.user_rank);
  setText("metricRankBasis", state.currentRank === null ? "按2026一分一段表" : "手动输入位次");
  // 自动换算时展示后端位次；手动输入后保留用户填写值。
  const rankInput = el("rankInput");
  if (rankInput) rankInput.value = state.currentRank ?? summary.predicted_user_rank ?? summary.user_rank ?? "";
  const entryRankInput = el("entryRankInput");
  if (entryRankInput) entryRankInput.value = summary.predicted_user_rank || summary.user_rank || "";
  setCount("metricTotal", total || null);
  const probabilities = state.list.map(admissionProbability).filter((value) => value !== null);
  setCount("metricAvgProb", probabilities.length ? (probabilities.reduce((sum, value) => sum + value, 0) / probabilities.length) * 100 : null, (value) => `${value.toFixed(1)}%`);
  setCount("metricReach", reach);
  setCount("metricStable", stable);
  setCount("metricSafe", safe);
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
  if (state.selectedProfile?.school !== fallback.school) {
    state.selectedProfile = null;
    state.selectedProfileStatus = "loading";
  }
  syncSelectedRows();
  // 列表数据缺历年位次，先不画右侧详情，等详情接口回来只画一次，避免先空后满闪两下。
  // 已经拿过详情（带 history）的直接画；接口太慢时 600ms 后先用简略数据兜底。
  const hasDetail = Boolean(fallback.history || fallback.history_2026);
  if (hasDetail) renderDetail();
  const slowTimer = hasDetail ? 0 : window.setTimeout(() => {
    if (state.selected?.unit_id === unitId && el("detailPanel")?.dataset.unit !== unitId) renderDetail();
  }, 600);
  renderSegmentPrediction();
  renderPrecisionPanels();
  renderMobileApp();

  const params = new URLSearchParams({ score: state.score, risk: state.risk });
  if (state.currentRank) params.set("current_rank", state.currentRank);
  fetchJson(`/api/detail/${encodeURIComponent(unitId)}?${params}`)
    .then(async (detail) => {
      if (state.selected?.unit_id !== unitId) return;
      const recommendation = [...state.list, ...state.alternates].find((item) => item.unit_id === unitId);
      if (recommendation) {
        // 详情接口不带推荐序号，合并时保留原序号，避免表格里显示成“-”。
        const order = recommendation.order;
        Object.assign(recommendation, detail);
        recommendation.order = order;
      }
      state.selected = recommendation || detail;
      window.clearTimeout(slowTimer);
      renderDetail();
      updateTableRow(state.selected);
      syncSelectedRows();
      renderSegmentPrediction();
      renderPrecisionPanels();
      renderMobileApp();
      await loadSchoolProfile(detail.school, false);
    })
    .catch(async () => {
      if (state.selected?.unit_id !== unitId) return;
      window.clearTimeout(slowTimer);
      renderDetail();
      await loadSchoolProfile(fallback.school, false);
    });
}

async function loadSchoolProfile(school, fetchLogo = false) {
  if (state.selectedProfile?.school !== school) state.selectedProfileStatus = "loading";
  state.selectedCollegesChat = { status: "loading", school, available: false, message: "正在读取 CollegesChat 生活质量问卷。" };
  const profilePromise = fetchJson(`/api/school-profile/${encodeURIComponent(school)}?fetch_logo=${fetchLogo ? "true" : "false"}`);
  const collegesPromise = loadCollegesChat(school);

  profilePromise
    .then((profile) => {
      if (state.selected?.school && state.selected.school !== school) return;
      state.selectedProfile = profile;
      state.selectedProfileStatus = "ready";
      renderProfile();
      renderDetail();
      renderMobileApp();
    })
    .catch((error) => {
      console.error(error);
      if (state.selected?.school && state.selected.school !== school) return;
      state.selectedProfile = null;
      state.selectedProfileStatus = "error";
      renderProfile();
      renderDetail();
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
  const arrived = state.list[index];
  if (arrived) document.querySelector(`#resultBody tr[data-unit="${CSS.escape(arrived.unit_id)}"]`)?.classList.add("row-arrive");
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
  // 覆盖率改用图表展示，不再逐条重复成文字卡片。
  const cards = (resources.source_cards || []).filter((item) => !String(item.title || "").includes("校徽"));
  node.innerHTML = modelLabHtml() + `
    <section class="source-card chart-card">
      <h3>资料覆盖</h3>
      <p>按院校或专业组合统计；缺失项保持为空，不按相似名称猜测合并。</p>
      <div class="chart-box chart-tall" id="chartCoverage"></div>
    </section>
    <section class="source-card chart-card">
      <h3>2026 时间外回测：误差范围</h3>
      <p>预测位次与实际投档位次的相对误差落在各范围内的专业占比。</p>
      <div class="chart-box chart-tall" id="chartModel"></div>
    </section>
  ` + cards.map((item) => `
    <article class="source-card">
      <span>${escapeHtml(item.status || item.confidence || "-")}</span>
      <h3>${escapeHtml(item.title || "资料来源")}</h3>
      <p>${escapeHtml(item.description || "")}</p>
      <small>重要填报前请以招生章程和学校官方发布为准。</small>
    </article>
  `).join("");
  renderSourceCharts();
}

// 资料页“模型方法”：公式与图表全部对应 backend/backtest.py、train_forecast.py、runtime_store.py 的实际计算。
const MODEL_FORMULAS = [
  {
    step: "① 年度位次归一化",
    math: `<math display="block"><msub><mi>f</mi><mrow><mi>i</mi><mo>,</mo><mi>t</mi></mrow></msub><mo>=</mo><mfrac><msub><mi>r</mi><mrow><mi>i</mi><mo>,</mo><mi>t</mi></mrow></msub><msub><mi>N</mi><mi>t</mi></msub></mfrac></math>`,
    note: "r 为专业 i 在第 t 年的最低投档位次，N 为当年物理类累计位次规模：N₂₀₂₄ = 155,799，N₂₀₂₅ = 158,061，N₂₀₂₆ = 158,893。消除每年考生人数变化的影响。",
  },
  {
    step: "② 预测目标：对数位次增量",
    math: `<math display="block"><msub><mi>Δ</mi><mrow><mi>i</mi><mo>,</mo><mi>t</mi></mrow></msub><mo>=</mo><mi>ln</mi><mo>&#x2061;</mo><msub><mi>f</mi><mrow><mi>i</mi><mo>,</mo><mi>t</mi></mrow></msub><mo>−</mo><mi>ln</mi><mo>&#x2061;</mo><msub><mi>f</mi><mrow><mi>i</mi><mo>,</mo><mi>t</mi><mo>−</mo><mn>1</mn></mrow></msub></math>`,
    note: "模型不直接猜位次，而是学习“今年比去年热了多少”。训练样本为 2024→2025、2025→2026 两组跨年匹配，共 26,883 条。",
  },
  {
    step: "③ CatBoost 梯度提升回归",
    math: `<math display="block"><mover><mi>Δ</mi><mo>^</mo></mover><mo>(</mo><mi mathvariant="bold">x</mi><mo>)</mo><mo>=</mo><munderover><mo>∑</mo><mrow><mi>k</mi><mo>=</mo><mn>1</mn></mrow><mi>K</mi></munderover><mi>η</mi><mspace width="0.15em"/><msub><mi>h</mi><mi>k</mi></msub><mo>(</mo><mi mathvariant="bold">x</mi><mo>)</mo><mo>,</mo><mspace width="0.8em"/><munder><mi>min</mi><mi>h</mi></munder><munder><mo>∑</mo><mi>i</mi></munder><mrow><mo>|</mo><msub><mi>Δ</mi><mi>i</mi></msub><mo>−</mo><mover><mi>Δ</mi><mo>^</mo></mover><mo>(</mo><msub><mi mathvariant="bold">x</mi><mi>i</mi></msub><mo>)</mo><mo>|</mo></mrow><mo>+</mo><mi>λ</mi><msup><mrow><mo>‖</mo><mi>w</mi><mo>‖</mo></mrow><mn>2</mn></msup></math>`,
    note: "K = 900 棵对称树，学习率 η = 0.03，树深 5，损失 MAE，L2 正则 λ = 8。院校、专业、录取类型作为类别特征，由 CatBoost 有序目标编码处理。",
  },
  {
    step: "④ 反变换得到 2027 预测位次",
    math: `<math display="block"><msub><mover><mi>r</mi><mo>^</mo></mover><mrow><mi>i</mi><mo>,</mo><mn>2027</mn></mrow></msub><mo>=</mo><msub><mi>N</mi><mn>2026</mn></msub><mo>·</mo><mi>exp</mi><mo>&#x2061;</mo><mrow><mo>(</mo><mi>ln</mi><mo>&#x2061;</mo><msub><mi>f</mi><mrow><mi>i</mi><mo>,</mo><mn>2026</mn></mrow></msub><mo>+</mo><mover><mi>Δ</mi><mo>^</mo></mover><mo>(</mo><msub><mi mathvariant="bold">x</mi><mi>i</mi></msub><mo>)</mo><mo>)</mo></mrow></math>`,
    note: "2027 年一分一段表尚未发布，暂用 2026 年规模换算；结果裁剪到 [1, 300000]。",
  },
  {
    step: "⑤ 残差分位校准（按预测十分位）",
    math: `<math display="block"><msub><mi>e</mi><mi>i</mi></msub><mo>=</mo><msub><mi>r</mi><mi>i</mi></msub><mo>−</mo><msub><mover><mi>r</mi><mo>^</mo></mover><mi>i</mi></msub><mo>,</mo><mspace width="0.6em"/><msub><mi>Q</mi><mi>d</mi></msub><mo>(</mo><mi>q</mi><mo>)</mo><mo>=</mo><msub><mi>Quantile</mi><mi>q</mi></msub><mo>{</mo><msub><mi>e</mi><mi>i</mi></msub><mo>:</mo><msub><mover><mi>r</mi><mo>^</mo></mover><mi>i</mi></msub><mo>∈</mo><msub><mi>D</mi><mi>d</mi></msub><mo>}</mo><mo>,</mo><mspace width="0.6em"/><msubsup><mover><mi>r</mi><mo>^</mo></mover><mi>i</mi><mrow><mo>(</mo><mi>q</mi><mo>)</mo></mrow></msubsup><mo>=</mo><msub><mover><mi>r</mi><mo>^</mo></mover><mi>i</mi></msub><mo>+</mo><msub><mi>Q</mi><mi>d</mi></msub><mo>(</mo><mi>q</mi><mo>)</mo></math>`,
    note: "按预测位次分成 10 档 D₁…D₁₀，每档取 2026 时间外残差的 q = 0.05、0.10、0.50、0.90、0.95 分位数。80% 区间即 q = 0.10 到 0.90。",
  },
  {
    step: "⑥ 录取概率：分段线性累积分布",
    math: `<math display="block"><msub><mi>P</mi><mi>i</mi></msub><mo>(</mo><mi>u</mi><mo>)</mo><mo>=</mo><mn>1</mn><mo>−</mo><msub><mi>F</mi><mi>i</mi></msub><mo>(</mo><mi>u</mi><mo>)</mo><mo>,</mo><mspace width="0.6em"/><msub><mi>F</mi><mi>i</mi></msub><mo>(</mo><mi>u</mi><mo>)</mo><mo>=</mo><msub><mi>q</mi><mi>j</mi></msub><mo>+</mo><mfrac><mrow><mi>u</mi><mo>−</mo><msubsup><mover><mi>r</mi><mo>^</mo></mover><mi>i</mi><mrow><mo>(</mo><msub><mi>q</mi><mi>j</mi></msub><mo>)</mo></mrow></msubsup></mrow><mrow><msubsup><mover><mi>r</mi><mo>^</mo></mover><mi>i</mi><mrow><mo>(</mo><msub><mi>q</mi><mrow><mi>j</mi><mo>+</mo><mn>1</mn></mrow></msub><mo>)</mo></mrow></msubsup><mo>−</mo><msubsup><mover><mi>r</mi><mo>^</mo></mover><mi>i</mi><mrow><mo>(</mo><msub><mi>q</mi><mi>j</mi></msub><mo>)</mo></mrow></msubsup></mrow></mfrac><mo>(</mo><msub><mi>q</mi><mrow><mi>j</mi><mo>+</mo><mn>1</mn></mrow></msub><mo>−</mo><msub><mi>q</mi><mi>j</mi></msub><mo>)</mo></math>`,
    note: "u 为考生位次。在相邻两个分位点之间线性插值，两端外推并把概率限制在 [0.01, 0.99]：位次越靠前（u 越小），录取概率越高。",
  },
  {
    step: "⑦ 冲稳保分层",
    math: `<math display="block"><mtext>风险</mtext><mo>(</mo><msub><mi>P</mi><mi>i</mi></msub><mo>)</mo><mo>=</mo><mrow><mo>{</mo><mtable columnalign="left left"><mtr><mtd><mtext>强冲</mtext></mtd><mtd><msub><mi>P</mi><mi>i</mi></msub><mo>&lt;</mo><mn>0.25</mn></mtd></mtr><mtr><mtd><mtext>冲</mtext></mtd><mtd><mn>0.25</mn><mo>≤</mo><msub><mi>P</mi><mi>i</mi></msub><mo>&lt;</mo><mn>0.50</mn></mtd></mtr><mtr><mtd><mtext>稳</mtext></mtd><mtd><mn>0.50</mn><mo>≤</mo><msub><mi>P</mi><mi>i</mi></msub><mo>&lt;</mo><mn>0.74</mn></mtd></mtr><mtr><mtd><mtext>保</mtext></mtd><mtd><mn>0.74</mn><mo>≤</mo><msub><mi>P</mi><mi>i</mi></msub><mo>&lt;</mo><mn>0.89</mn></mtd></mtr><mtr><mtd><mtext>兜底</mtext></mtd><mtd><msub><mi>P</mi><mi>i</mi></msub><mo>≥</mo><mn>0.89</mn></mtd></mtr></mtable></mrow></math>`,
    note: "均衡策略的名额为 强冲 8、冲 22、稳 36、保 22、兜底 8，合计 96；保守与冲刺策略按各自名额表分配。",
  },
  {
    step: "⑧ 层内排序得分",
    math: `<math display="block"><msub><mi>S</mi><mi>i</mi></msub><mo>=</mo><mn>0.78</mn><mrow><mo>(</mo><mn>1</mn><mo>−</mo><mrow><mo>|</mo><msub><mi>P</mi><mi>i</mi></msub><mo>−</mo><mi>τ</mi><mo>|</mo></mrow><mo>)</mo></mrow><mo>+</mo><mn>0.22</mn><mspace width="0.15em"/><msub><mi>c</mi><mi>i</mi></msub><mo>,</mo><mspace width="0.8em"/><mi>τ</mi><mo>∈</mo><mo>{</mo><mn>0.80</mn><mo>,</mo><mn>0.62</mn><mo>,</mo><mn>0.42</mn><mo>}</mo></math>`,
    note: "τ 为策略目标概率（保守 0.80、均衡 0.62、冲刺 0.42），c 为模型置信度。每层按 S 从高到低取满名额。",
  },
];

function modelLabHtml() {
  const report = state.modelReport || {};
  const backtest = report.time_out_2026_metrics_without_future_plan || {};
  const calibration = report.crossfit_calibration || {};
  const pipeline = [
    ["投档数据", "2024—2026 贵州物理类本科批"],
    ["跨年匹配", `${formatCount(report.training_rows)} 条样本`],
    ["归一化 f", "位次 ÷ 当年规模"],
    ["CatBoost Δ", "900 树 · 深度 5"],
    ["反变换 r̂", "2027 中位预测"],
    ["残差校准", "10 档 × 5 分位"],
    ["概率 P", "分段线性 CDF"],
    ["冲稳保 96", "名额 + 得分 S"],
  ];
  const stats = [
    ["训练样本", formatCount(report.training_rows), "2024→2025、2025→2026"],
    ["预测专业组合", formatCount(report.forecast_rows), "2027 全部候选"],
    ["交叉校准 MAE", `${formatCount(calibration.median_calibrated_metrics?.mae_rank ?? backtest.mae_rank)} 名`, `中位误差 ${formatCount(calibration.median_calibrated_metrics?.median_ae_rank ?? backtest.median_ae_rank)} 名 · 2026 时间外`],
    ["80% 区间覆盖", calibration.q10_q90_coverage === undefined ? "-" : formatPercent(calibration.q10_q90_coverage, 1), "五折交叉校准"],
  ];
  return `
    <section class="source-card model-lab">
      <div class="model-lab-head">
        <div>
          <span class="model-kicker">实际部署模型 · ${escapeHtml(report.deployment_route || "catboost_delta_d5")}</span>
          <h2>CatBoost 对数位次增量回归 + 残差分位校准</h2>
          <p>先把每年的投档位次换算成“占全省考生的比例”，再用梯度提升树学习这一比例逐年的变化量；预测值经残差分位数校准后得到区间，最后换算为录取概率并按冲稳保分层。所有参数与下方公式一致，评估全部来自模型没见过的 2026 年数据。</p>
        </div>
        <div class="model-lab-stats">
          ${stats.map(([label, value, note]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></div>`).join("")}
        </div>
      </div>
      <ol class="model-pipeline">
        ${pipeline.map(([title, note], index) => `<li style="--i:${index}"><b>${escapeHtml(title)}</b><small>${escapeHtml(note)}</small></li>`).join("")}
      </ol>
      <div class="formula-board">
        ${MODEL_FORMULAS.map((item, index) => `
          <article class="formula-tile" style="--i:${index}">
            <span>${escapeHtml(item.step)}</span>
            <div class="formula-math">${item.math}</div>
            <p>${escapeHtml(item.note)}</p>
          </article>
        `).join("")}
      </div>
      <div class="model-feature-row">
        <div>
          <h3>输入特征（24 个）</h3>
          <p><b>类别特征 3 个：</b>院校、专业、录取类型。</p>
          <p><b>数值特征 21 个：</b>上年位次对数、上年归一化位次及其对数、年度规模增长比、上年最低分、上年录取人数对数、院校/专业历史中位位次、相对院校与专业中位的中心化位次、院校专业数、开设该专业的院校数、专业名长度，以及中外合作、医学、计算机、师范、本省院校五个标记；当年计划相关 3 项在 2027 招生目录发布前统一置空。</p>
        </div>
        <div>
          <h3>选型与验证</h3>
          <p>候选模型在 2024→2025 上做 5 折分组交叉验证（按院校分组，同一学校不会同时出现在训练与验证中），按综合误差得分选出 ${escapeHtml(report.deployment_route || "catboost_delta_d5")}；2026 年数据只用来做时间外评估，不参与选型。</p>
          <p>区间校准使用五折交叉拟合：按院校专业键哈希分折，每折用其余四折的残差分位数校准，覆盖率才是诚实的样本外结果。</p>
        </div>
      </div>
    </section>
    <section class="source-card chart-card model-chart-card">
      <h3>候选模型选型：5 折分组验证平均绝对误差</h3>
      <p>2024→2025 训练集上的分组交叉验证结果，越短越好；蓝色为实际部署的模型。</p>
      <div class="chart-box chart-tall" id="chartSelection"></div>
    </section>
    <section class="source-card chart-card model-chart-card">
      <h3>2026 时间外：本模型 vs 简单基线</h3>
      <p>同一批 13,491 个专业，分别用“去年位次直接沿用”等简单方法与本模型预测 2026 年，比较平均绝对误差。</p>
      <div class="chart-box" id="chartBaseline"></div>
    </section>
    <section class="source-card chart-card model-chart-card">
      <h3>残差分位扇形：不同位次段的不确定性</h3>
      <p>横轴为预测位次十分位档，纵轴为“实际 − 预测”位次残差。深色带为 80% 区间（q10—q90），浅色带延伸到 90%（q05—q95），折线为中位残差。位次越靠后，不确定性越大。</p>
      <div class="chart-box chart-tall" id="chartResidual"></div>
    </section>
    <section class="source-card chart-card model-chart-card">
      <h3 id="probCurveTitle">位次 → 录取概率曲线</h3>
      <p>公式 ⑥ 的实际形状：以右侧当前选中的志愿为例，横轴为考生位次，纵轴为录取概率，圆点为你的位次。</p>
      <div class="chart-box chart-tall" id="chartProbCurve"></div>
    </section>
  `;
}

function renderModelLabCharts() {
  const report = state.modelReport;
  if (!report) return;
  const deployed = report.deployment_route;
  const selection = [...(report.internal_model_selection || [])]
    .filter((row) => Number.isFinite(Number(row.mae_rank)))
    .sort((a, b) => a.mae_rank - b.mae_rank);
  if (selection.length) {
    paintChart("chartSelection", {
      grid: { left: 150, right: 70, top: 8, bottom: 8 },
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, formatter: ([entry]) => {
        const row = selection[entry.dataIndex];
        return `<b>${escapeHtml(row.route)}</b><br/>平均绝对误差 ${formatInt(row.mae_rank)} 名<br/>误差中位数 ${formatInt(row.median_ae_rank)} 名<br/>10% 以内 ${formatPercent(row.within_10pct, 1)}`;
      } },
      xAxis: { type: "value", show: false },
      yAxis: { type: "category", inverse: true, data: selection.map((row) => row.route), ...CHART_AXIS, axisLine: { show: false }, axisLabel: { color: "#10213d", fontSize: 11 } },
      series: [{
        type: "bar",
        barWidth: 12,
        data: selection.map((row) => ({ value: Math.round(row.mae_rank), itemStyle: { color: row.route === deployed ? "#1558b0" : "rgba(21,88,176,.28)" } })),
        itemStyle: { borderRadius: 6 },
        label: { show: true, position: "right", color: "#10213d", fontWeight: 800, fontSize: 11, formatter: ({ value }) => formatInt(value) },
        animationDelay: (index) => index * 60,
      }],
    }, JSON.stringify(selection.map((row) => [row.route, row.mae_rank])));
  }
  const timeOut = report.time_out_2026_metrics_without_future_plan;
  const baselineNames = { last_year_rank: "去年位次直接沿用", percentile_persistence: "百分位不变", global_ratio: "全局比例缩放" };
  const baselines = [
    ...(timeOut ? [{ route: deployed, label: "本模型（部署）", mae: timeOut.mae_rank }] : []),
    ...(report.time_out_baselines || []).map((row) => ({ route: row.route, label: baselineNames[row.route] || row.route, mae: row.mae_rank })),
  ].filter((row) => Number.isFinite(Number(row.mae)));
  if (baselines.length) {
    paintChart("chartBaseline", {
      grid: { left: 120, right: 70, top: 8, bottom: 8 },
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, formatter: ([entry]) => `${entry.name}<br/>平均绝对误差 <b>${formatInt(entry.value)}</b> 名` },
      xAxis: { type: "value", show: false },
      yAxis: { type: "category", inverse: true, data: baselines.map((row) => row.label), ...CHART_AXIS, axisLine: { show: false }, axisLabel: { color: "#10213d", fontSize: 12, fontWeight: 800 } },
      series: [{
        type: "bar",
        barWidth: 14,
        data: baselines.map((row, index) => ({ value: Math.round(row.mae), itemStyle: { color: index === 0 ? "#1558b0" : "#9fb0c4" } })),
        itemStyle: { borderRadius: 7 },
        label: { show: true, position: "right", color: "#10213d", fontWeight: 800, formatter: ({ value }) => `${formatInt(value)} 名` },
        animationDelay: (index) => index * 120,
      }],
    }, JSON.stringify(baselines));
  }
  const profiles = report.calibration_profiles || [];
  if (profiles.length) {
    const labels = profiles.map((row) => `D${row.decile + 1}`);
    paintChart("chartResidual", {
      grid: { left: 58, right: 18, top: 30, bottom: 40 },
      legend: { top: 0, right: 0, itemWidth: 12, itemHeight: 8, textStyle: { color: "#52627a", fontSize: 11, fontWeight: 700 }, data: ["90% 区间", "80% 区间", "中位残差"] },
      tooltip: { trigger: "axis", formatter: (items) => {
        const row = profiles[items[0].dataIndex];
        return `<b>${labels[items[0].dataIndex]}</b>：预测位次 ${formatInt(row.predicted_min)}—${formatInt(row.predicted_max)}<br/>q05 ${formatInt(row.q05)} · q10 ${formatInt(row.q10)} · q50 ${formatInt(row.q50)}<br/>q90 ${formatInt(row.q90)} · q95 ${formatInt(row.q95)}（${formatInt(row.rows)} 个样本）`;
      } },
      xAxis: { type: "category", data: labels, ...CHART_AXIS, splitLine: { show: false }, name: "预测位次十分位（D1 最靠前）", nameLocation: "middle", nameGap: 26 },
      yAxis: { type: "value", ...CHART_AXIS, axisLabel: { ...CHART_AXIS.axisLabel, formatter: (value) => formatInt(value) } },
      // 残差有正有负，堆叠柱会把正负分开堆；这里直接按坐标画 q05—q95 与 q10—q90 两层色带。
      series: [
        {
          name: "90% 区间",
          type: "custom",
          itemStyle: { color: "rgba(21,88,176,.18)" },
          renderItem: (params, api) => {
            const width = api.size([1, 0])[0] * 0.46;
            const top = api.coord([api.value(0), api.value(2)]);
            const bottom = api.coord([api.value(0), api.value(1)]);
            return { type: "rect", shape: { x: top[0] - width / 2, y: top[1], width, height: bottom[1] - top[1], r: 4 }, style: { fill: "rgba(21,88,176,.18)" } };
          },
          encode: { x: 0, y: [1, 2] },
          data: profiles.map((row, index) => [index, row.q05, row.q95]),
        },
        {
          name: "80% 区间",
          type: "custom",
          itemStyle: { color: "rgba(21,88,176,.55)" },
          renderItem: (params, api) => {
            const width = api.size([1, 0])[0] * 0.46;
            const top = api.coord([api.value(0), api.value(2)]);
            const bottom = api.coord([api.value(0), api.value(1)]);
            return { type: "rect", shape: { x: top[0] - width / 2, y: top[1], width, height: bottom[1] - top[1], r: 3 }, style: { fill: "rgba(21,88,176,.55)" } };
          },
          encode: { x: 0, y: [1, 2] },
          data: profiles.map((row, index) => [index, row.q10, row.q90]),
          z: 3,
        },
        { name: "中位残差", type: "line", data: profiles.map((row) => row.q50), symbol: "circle", symbolSize: 7, lineStyle: { color: "#c96b12", width: 2.5 }, itemStyle: { color: "#c96b12" }, z: 5 },
      ],
    }, JSON.stringify(profiles));
  }
  renderProbCurveChart();
}

function renderProbCurveChart() {
  const item = state.selected;
  const knots = item ? [item.rank_q05, item.rank_q10, item.rank_q50, item.rank_q90, item.rank_q95].map(nullableHistoryValue) : [];
  if (!item || knots.some((value) => value === null)) return;
  const levels = [0.05, 0.10, 0.50, 0.90, 0.95];
  // 与 runtime_store._probabilities 相同的分段线性累积分布。
  const cdf = (rank) => {
    if (rank < knots[0]) return Math.min(0.05, Math.max(0.01, 0.05 * rank / Math.max(knots[0], 1)));
    for (let j = 0; j < 4; j += 1) {
      if (rank <= knots[j + 1]) return levels[j] + Math.min(1, Math.max(0, (rank - knots[j]) / Math.max(knots[j + 1] - knots[j], 1))) * (levels[j + 1] - levels[j]);
    }
    return Math.min(0.99, Math.max(0.95, 0.95 + 0.04 * (rank - knots[4]) / Math.max(knots[4] - knots[0], 1)));
  };
  const probability = (rank) => Math.min(0.99, Math.max(0.01, 1 - cdf(rank)));
  const span = knots[4] - knots[0];
  const start = Math.max(1, Math.floor(knots[0] - span * 0.35));
  const end = Math.ceil(knots[4] + span * 0.35);
  const points = Array.from({ length: 81 }, (_, index) => {
    const rank = start + ((end - start) * index) / 80;
    return [Math.round(rank), Math.round(probability(rank) * 1000) / 10];
  });
  const userRank = validCount(state.currentRank ?? state.summary?.predicted_user_rank ?? state.summary?.user_rank);
  setText("probCurveTitle", `位次 → 录取概率曲线 · ${item.school} ${item.major}`);
  paintChart("chartProbCurve", {
    grid: { left: 52, right: 24, top: 24, bottom: 40 },
    tooltip: { trigger: "axis", formatter: (items) => `位次 ${formatInt(items[0].value[0])}<br/>录取概率 <b>${items[0].value[1]}%</b>` },
    xAxis: { type: "value", min: start, max: end, ...CHART_AXIS, name: "考生位次", nameLocation: "middle", nameGap: 26, axisLabel: { ...CHART_AXIS.axisLabel, formatter: (value) => formatInt(value) } },
    yAxis: { type: "value", min: 0, max: 100, ...CHART_AXIS, axisLabel: { ...CHART_AXIS.axisLabel, formatter: "{value}%" } },
    series: [{
      type: "line",
      data: points,
      showSymbol: false,
      lineStyle: { width: 3, color: "#1558b0" },
      areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: "rgba(21,88,176,.22)" }, { offset: 1, color: "rgba(21,88,176,0)" }] } },
      markLine: {
        symbol: "none",
        silent: true,
        lineStyle: { color: "rgba(16,33,61,.35)", type: "dashed" },
        label: { color: "#52627a", fontSize: 10, formatter: ({ data }) => data.name },
        data: knots.map((rank, index) => ({ xAxis: rank, name: `q${String(levels[index] * 100).padStart(2, "0")}` })),
      },
      markPoint: userRank && userRank >= start && userRank <= end ? {
        symbol: "circle",
        symbolSize: 14,
        itemStyle: { color: "#c96b12", borderColor: "#fff", borderWidth: 2 },
        label: { show: true, position: "top", color: "#c96b12", fontWeight: 900, formatter: () => `你 ${Math.round(probability(userRank) * 100)}%` },
        data: [{ coord: [userRank, Math.round(probability(userRank) * 1000) / 10] }],
      } : undefined,
    }],
  }, JSON.stringify([item.unit_id, knots, userRank]));
}

function renderSourceCharts() {
  renderModelLabCharts();
  const rows = coverageStats(state.resources?.coverage).map(([label, count, total]) => ({ label, count, total, percent: total > 0 ? (count / total) * 100 : 0 }));
  if (rows.length) {
    paintChart("chartCoverage", {
      grid: { left: 92, right: 96, top: 6, bottom: 6 },
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, formatter: ([entry]) => `${entry.name}<br/>${coverageCountText(rows[entry.dataIndex].count, rows[entry.dataIndex].total)}` },
      xAxis: { type: "value", max: 100, show: false },
      yAxis: { type: "category", inverse: true, data: rows.map((row) => row.label), ...CHART_AXIS, axisLine: { show: false } },
      series: [{
        type: "bar",
        data: rows.map((row) => ({
          value: Math.round(row.percent * 10) / 10,
          itemStyle: { color: row.percent >= 90 ? "#16865a" : row.percent >= 60 ? "#1558b0" : "#c96b12" },
        })),
        barWidth: 12,
        showBackground: true,
        backgroundStyle: { color: "rgba(21,88,176,.05)", borderRadius: 6 },
        itemStyle: { borderRadius: 6 },
        label: { show: true, position: "right", color: "#10213d", fontWeight: 800, fontSize: 11, formatter: ({ dataIndex }) => `${formatCount(rows[dataIndex].count)}/${formatCount(rows[dataIndex].total)}` },
        animationDelay: (index) => index * 90,
      }],
    }, JSON.stringify(rows));
  }
  const report = state.modelReport;
  const metrics = report?.crossfit_calibration?.median_calibrated_metrics || report?.time_out_2026_metrics_without_future_plan;
  if (metrics) {
    const bands = [["误差 5% 以内", metrics.within_5pct], ["误差 10% 以内", metrics.within_10pct], ["误差 20% 以内", metrics.within_20pct]]
      .filter(([, value]) => Number.isFinite(Number(value)));
    paintChart("chartModel", {
      grid: { left: 92, right: 56, top: 6, bottom: 6 },
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, formatter: ([entry]) => `${entry.name}<br/><b>${entry.value}%</b> 的专业组合` },
      xAxis: { type: "value", max: 100, show: false },
      yAxis: { type: "category", inverse: true, data: bands.map(([label]) => label), ...CHART_AXIS, axisLine: { show: false } },
      series: [{
        type: "bar",
        data: bands.map(([, value]) => Math.round(Number(value) * 1000) / 10),
        barWidth: 16,
        showBackground: true,
        backgroundStyle: { color: "rgba(21,88,176,.05)", borderRadius: 8 },
        itemStyle: { color: "#1558b0", borderRadius: 8 },
        label: { show: true, position: "right", color: "#10213d", fontWeight: 800, formatter: "{c}%" },
        animationDelay: (index) => index * 140,
      }],
    }, JSON.stringify(bands));
  }
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

function diagnosticMetrics() {
  const report = state.modelReport;
  // 与资料说明页口径一致：优先用五折交叉校准后的中位指标。
  return report?.crossfit_calibration?.median_calibrated_metrics || report?.time_out_2026_metrics_without_future_plan || null;
}

function renderPrecisionPanels() {
  const diagnostic = el("diagnosticPanel");
  if (!diagnostic) return;
  const metrics = diagnosticMetrics();
  if (!metrics) {
    diagnostic.innerHTML = `<p class="dash-note">模型报告未提供。</p>`;
    return;
  }
  const stats = [
    ["回测样本", formatInt(metrics.rows), "个专业组合"],
    ["平均误差", formatInt(metrics.mae_rank), "名"],
    ["误差中位数", formatInt(metrics.median_ae_rank), "名"],
  ];
  diagnostic.innerHTML = stats.map(([label, value, unit]) => `
    <div class="diag-stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(unit)}</small></div>
  `).join("");
  renderDiagChart();
}

function renderDiagChart() {
  const metrics = diagnosticMetrics();
  if (!metrics) return;
  const rings = [["误差 ≤5%", metrics.within_5pct], ["误差 ≤10%", metrics.within_10pct], ["误差 ≤20%", metrics.within_20pct]]
    .filter(([, value]) => Number.isFinite(Number(value)));
  const key = JSON.stringify(rings);
  const previousKey = state.charts.chartDiag?.__key;
  paintChart("chartDiag", {
    tooltip: { show: false },
    series: rings.map(([label, value], index) => ({
      type: "gauge",
      center: [`${((index * 2 + 1) / (rings.length * 2)) * 100}%`, "52%"],
      radius: "78%",
      startAngle: 90,
      endAngle: -270,
      min: 0,
      max: 100,
      pointer: { show: false },
      progress: { show: true, roundCap: true, width: 10, itemStyle: { color: "#1558b0" } },
      axisLine: { lineStyle: { width: 10, color: [[1, "rgba(21,88,176,.1)"]] } },
      splitLine: { show: false },
      axisTick: { show: false },
      axisLabel: { show: false },
      title: { offsetCenter: [0, "34%"], color: "#66758a", fontSize: 11, fontWeight: 800 },
      detail: { offsetCenter: [0, "-8%"], valueAnimation: true, formatter: "{value}%", color: "#07336b", fontSize: 18, fontWeight: 900 },
      animationDuration: 1600,
      animationDurationUpdate: 1600,
      animationEasingUpdate: "cubicOut",
      animationDelay: index * 180,
      animationDelayUpdate: index * 180,
      // 先画 0，下一帧再更新到真实值：圆环才会转起来，而不只是数字在滚动。
      data: [{ value: 0, name: label }],
    })),
  }, key);
  const chart = state.charts.chartDiag;
  if (!chart || chart.__key !== key || previousKey === key) return;
  requestAnimationFrame(() => chart.setOption({
    series: rings.map(([label, value]) => ({ data: [{ value: Math.round(Number(value) * 1000) / 10, name: label }] })),
  }));
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
    animation: !prefersReducedMotion(),
    animationDuration: 1600,
    animationEasing: "cubicOut",
    animationDurationUpdate: 800,
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
      animationType: "expansion",
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
  ["resourceFiles", "guideCount", "logoCoverage"].forEach((id) => el(id)?.classList.remove("value-loading"));
  setCount("resourceFiles", coverage.source_files ?? resources.total_files ?? resources.guizhou_files);
  const schoolsWithBasic = validCount(coverage.schools_with_basic);
  const schoolsTotal = validCount(coverage.schools_total);
  if (schoolsWithBasic !== null && schoolsTotal > 0) {
    setCount("guideCount", (schoolsWithBasic / schoolsTotal) * 100, (value) => `${value.toFixed(1)}%`);
  } else {
    setText("guideCount", formatCount(resources.school_guide_count ?? resources.school_ladder_count));
  }
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
  renderSources();
}


const CHART_TOOLTIP = {
  borderWidth: 1,
  borderColor: "#d9e2ef",
  backgroundColor: "rgba(255,255,255,.97)",
  textStyle: { color: "#10213d", fontSize: 12 },
};

const CHART_AXIS = {
  axisTick: { show: false },
  axisLine: { lineStyle: { color: "#d9e2ef" } },
  axisLabel: { color: "#66758a", fontSize: 11 },
  splitLine: { lineStyle: { color: "rgba(129,151,178,.2)", type: "dashed" } },
  nameTextStyle: { color: "#8a98ab", fontSize: 11 },
};

// 统一入口：节点看不见（所在视图未打开）时先不画，切到该视图再画，生长动画才看得到。
function paintChart(id, option, key, onClick) {
  const node = el(id);
  if (!node || !window.echarts || !node.offsetWidth) return;
  const chart = getChart(id);
  if (!chart || (key !== undefined && chart.__key === key)) return;
  chart.__key = key;
  chart.setOption({
    animation: !prefersReducedMotion(),
    animationDuration: 1400,
    animationEasing: "cubicOut",
    animationDurationUpdate: 700,
    ...option,
    tooltip: { ...CHART_TOOLTIP, ...(option.tooltip || {}) },
  }, true);
  if (onClick && !chart.__clickBound) {
    chart.on("click", onClick);
    chart.__clickBound = true;
  }
}

// 左栏：冲稳保各层的志愿数、平均录取概率和预测位次范围。
function renderTierSummary() {
  const node = el("tierSummary");
  if (!node) return;
  const tiers = [["冲", ["强冲", "冲"]], ["稳", ["稳"]], ["保", ["保"]], ["兜底", ["兜底"]]];
  node.innerHTML = tiers.map(([label, levels], index) => {
    const rows = state.list.filter((item) => levels.includes(item.risk_level));
    const probabilities = rows.map(admissionProbability).filter((value) => value !== null);
    const average = probabilities.length ? probabilities.reduce((sum, value) => sum + value, 0) / probabilities.length : null;
    const ranks = rows.map(recommendationRankValue).filter((rank) => rank < 999999999);
    const range = ranks.length ? `${formatInt(Math.min(...ranks))}–${formatInt(Math.max(...ranks))} 名` : "暂无";
    return `
      <div class="tier-row" style="--tier-color:${RISK_COLORS[levels[levels.length - 1]]};--i:${index}">
        <span class="tier-name"><i></i>${label}<b>${rows.length}</b></span>
        <strong>${average === null ? "-" : formatPercent(average)}</strong>
        <div class="tier-bar"><i style="width:${average === null ? 0 : (average * 100).toFixed(1)}%"></i></div>
        <small title="预测位次 ${range}">${range}</small>
      </div>
    `;
  }).join("");
}

// 所有位次类图表统一：坐标轴范围一定包含考生位次，“你的位次”虚线始终可见。
function rankAxisRange(values, userRank, padRatio = 0.06) {
  const list = values.filter((value) => Number.isFinite(value) && value > 0);
  if (userRank) list.push(userRank);
  if (!list.length) return {};
  const min = Math.min(...list);
  const max = Math.max(...list);
  const pad = Math.max(200, (max - min) * padRatio);
  return { min: Math.max(1, Math.floor(min - pad)), max: Math.ceil(max + pad) };
}

const USER_RANK_LINE_COLOR = "#c96b12";

function userRankMarkLine(userRank, axis = "xAxis", labelAtStart = false) {
  if (!userRank) return undefined;
  return {
    symbol: "none",
    silent: true,
    lineStyle: { color: USER_RANK_LINE_COLOR, type: "dashed", width: 1.5 },
    label: { formatter: `你的位次 ${formatInt(userRank)}`, color: USER_RANK_LINE_COLOR, fontWeight: 800, fontSize: 11, position: axis === "xAxis" ? (labelAtStart ? "start" : "end") : "insideEndTop" },
    data: [{ [axis]: userRank }],
  };
}

function renderDashboardCharts() {
  renderScatterChart();
  renderProbChart();
  renderCityChart();
}

function renderScatterChart() {
  const userRank = validCount(state.currentRank ?? state.summary?.predicted_user_rank ?? state.summary?.user_rank);
  const points = state.list.map((item) => {
    const rank = nullableHistoryValue(item.rank_2026) ?? historyRecord(item, 2026).rank;
    const probability = admissionProbability(item);
    if (rank === null || probability === null) return null;
    return { value: [rank, Math.round(probability * 1000) / 10], unit: item.unit_id, school: item.school, major: item.major, risk: item.risk_level };
  }).filter(Boolean);
  const series = ["强冲", "冲", "稳", "保", "兜底"].map((risk) => ({
    name: risk,
    type: "scatter",
    symbolSize: 11,
    data: points.filter((point) => point.risk === risk),
    itemStyle: { color: RISK_COLORS[risk], opacity: .85, borderColor: "#fff", borderWidth: 1 },
    emphasis: { scale: 1.6 },
    animationDelay: (index) => index * 20,
  })).filter((item) => item.data.length);
  if (series.length) series[0].markLine = userRankMarkLine(userRank);
  paintChart("chartScatter", {
    grid: { left: 46, right: 18, top: 34, bottom: 40 },
    legend: { top: 0, right: 0, itemWidth: 9, itemHeight: 9, icon: "circle", textStyle: { color: "#52627a", fontSize: 11, fontWeight: 700 } },
    tooltip: {
      trigger: "item",
      formatter: ({ data }) => `<b>${escapeHtml(data.school)}</b><br/>${escapeHtml(data.major)}<br/>2026 投档 ${formatInt(data.value[0])} 名 · 录取概率 ${data.value[1]}%`,
    },
    xAxis: { type: "value", inverse: true, ...rankAxisRange(points.map((point) => point.value[0]), userRank), name: "2026 投档位次", nameLocation: "middle", nameGap: 26, ...CHART_AXIS, axisLabel: { ...CHART_AXIS.axisLabel, formatter: (value) => formatInt(value) } },
    yAxis: { type: "value", min: 0, max: 100, name: "录取概率 %", ...CHART_AXIS },
    series,
  }, JSON.stringify([points.map((point) => point.unit), userRank]), ({ data }) => data?.unit && openDetail(data.unit));
}

function renderProbChart() {
  const bins = Array(10).fill(0);
  state.list.forEach((item) => {
    const probability = admissionProbability(item);
    if (probability !== null) bins[Math.min(9, Math.floor(probability * 10))] += 1;
  });
  paintChart("chartProb", {
    grid: { left: 30, right: 10, top: 14, bottom: 26 },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, formatter: ([entry]) => `${entry.name}–${Number.parseInt(entry.name, 10) + 10}%<br/><b>${entry.value}</b> 个志愿` },
    xAxis: { type: "category", data: bins.map((_, index) => `${index * 10}%`), ...CHART_AXIS, splitLine: { show: false } },
    yAxis: { type: "value", minInterval: 1, ...CHART_AXIS },
    series: [{
      type: "bar",
      data: bins.map((value, index) => ({ value, itemStyle: { color: index < 3 ? RISK_COLORS["强冲"] : index < 6 ? RISK_COLORS["冲"] : index < 8 ? RISK_COLORS["稳"] : RISK_COLORS["保"] } })),
      barWidth: "60%",
      itemStyle: { borderRadius: [4, 4, 0, 0] },
      animationDelay: (index) => index * 70,
    }],
  }, JSON.stringify(bins));
}

function renderCityChart() {
  const counts = new Map();
  state.list.forEach((item) => {
    const city = schoolCity(item);
    if (city !== "城市待核验") counts.set(city, (counts.get(city) || 0) + 1);
  });
  const rows = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8);
  paintChart("chartCity", {
    grid: { left: 64, right: 28, top: 6, bottom: 6 },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, formatter: ([entry]) => `${entry.name}<br/><b>${entry.value}</b> 个志愿` },
    xAxis: { type: "value", show: false },
    yAxis: { type: "category", inverse: true, data: rows.map(([city]) => city), ...CHART_AXIS, axisLine: { show: false } },
    series: [{
      type: "bar",
      data: rows.map(([, count]) => count),
      barWidth: 11,
      showBackground: true,
      backgroundStyle: { color: "rgba(21,88,176,.05)", borderRadius: 6 },
      itemStyle: { color: "#1558b0", borderRadius: 6 },
      label: { show: true, position: "right", color: "#10213d", fontWeight: 800, fontSize: 11 },
      animationDelay: (index) => index * 80,
    }],
  }, JSON.stringify(rows));
}

function renderPriorityList() {
  const node = el("priorityList");
  if (!node) return;
  // 按冲 → 稳 → 保 → 兜底排列全部 96 个志愿，同一层内位次难的在前。
  const rows = [...state.list].sort((a, b) =>
    (riskOrderValue(a) - riskOrderValue(b))
    || (recommendationRankValue(a) - recommendationRankValue(b))
    || compareProbabilityDesc(a, b));
  node.innerHTML = rows.map((item, index) => {
    const rankText = item.rank_range || `${formatInt(item.rank_low || item.predicted_rank_low || item.predicted_rank || 0)}-${formatInt(item.rank_high || item.predicted_rank_high || item.predicted_rank || 0)}`;
    const scoreText = item.score_range || `${item.predicted_score_low || item.score_low || "-"}-${item.predicted_score_high || item.score_high || "-"}`;
    const info = `${scoreText} / ${rankText} · ${rankGapText(item)}`;
    return `
      <article class="priority-card priority-row priority-${riskTone(item)}" data-unit="${escapeHtml(item.unit_id)}" style="--i:${index}">
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
  // 每个标签页只放自己的资料：决策摘要只在“基础信息”，来源只在“公开官网”，不再每页重复。
  const tabMap = {
    basic: [...(sections.basic || []), ...decisionRows],
    admission: [...(sections.admission || [])],
    major_strength: [...(sections.major_strength || [])],
    life: [...collegesChatCards(state.selectedCollegesChat), ...(sections.life || [])],
    development: [...(sections.development || [])],
  };
  const rows = uniqueRows(tabMap[state.activeProfileTab] || tabMap.basic).slice(0, 36);
  const collegesChatHtml = state.activeProfileTab === "life" ? collegesChatPanel(state.selectedCollegesChat) : "";
  const majorsHtml = state.activeProfileTab === "admission"
    ? `<section class="insight-panel chart-card profile-chart-card">
        <div class="panel-title">
          <h1>各专业位次：2026 实际与 2027 预测</h1>
          <p>空心点是 2026 投档位次，实心点是 2027 预测，虚线是你的位次；越靠右越难考。</p>
        </div>
        <div class="chart-box" id="chartMajors" style="height:${Math.min(640, 80 + Math.min((profile.majors || []).length, 18) * 28)}px"></div>
      </section>`
    : "";
  const emptyCard = `<article class="info-card profile-info-card"><strong>暂无可核验的公开资料</strong><small>不把不确定内容包装成结论，等待公开资料补充。</small></article>`;
  node.innerHTML = header + majorsHtml + collegesChatHtml + `<div class="profile-life-board">${rows.map(profileCard).join("") || (majorsHtml ? "" : emptyCard)}</div>`;
  hydrateCollegesChatQuestions(node);
  markEntering(node, `profile:${profile.school}:${state.activeProfileTab}`);
  if (majorsHtml) renderMajorsChart();
}

function renderMajorsChart() {
  const profile = state.selectedProfile;
  const rows = (profile?.majors || [])
    .filter((major) => nullableHistoryValue(major.predicted_rank) !== null)
    .sort((a, b) => asNumber(a.predicted_rank) - asNumber(b.predicted_rank))
    .slice(0, 18);
  if (!rows.length) return;
  const userRank = validCount(state.currentRank ?? state.summary?.predicted_user_rank ?? state.summary?.user_rank);
  const selectedId = state.selected?.unit_id;
  paintChart("chartMajors", {
    grid: { left: 150, right: 24, top: 48, bottom: 28 },
    legend: { top: 0, left: 150, itemWidth: 10, itemHeight: 10, textStyle: { color: "#52627a", fontSize: 11, fontWeight: 700 } },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (items) => {
        const row = rows[items[0].dataIndex];
        return `<b>${escapeHtml(row.major)}</b><br/>2026 投档 ${formatInt(row.rank_2026)} 名 · ${row.score_2026 ?? "-"} 分<br/>2027 预测 ${formatInt(row.predicted_rank)} 名`;
      },
    },
    xAxis: { type: "value", inverse: true, ...rankAxisRange(rows.flatMap((row) => [nullableHistoryValue(row.rank_2026), nullableHistoryValue(row.predicted_rank)]), userRank), ...CHART_AXIS, axisLabel: { ...CHART_AXIS.axisLabel, formatter: (value) => formatInt(value) } },
    yAxis: {
      type: "category",
      inverse: true,
      data: rows.map((row) => row.major),
      ...CHART_AXIS,
      axisLine: { show: false },
      axisLabel: { color: "#10213d", fontSize: 12, width: 136, overflow: "truncate" },
    },
    series: [
      {
        type: "custom",
        silent: true,
        z: 1,
        renderItem: (params, api) => {
          if (!api.value(1) || !api.value(2)) return null;
          const from = api.coord([api.value(1), api.value(0)]);
          const to = api.coord([api.value(2), api.value(0)]);
          return { type: "line", shape: { x1: from[0], y1: from[1], x2: to[0], y2: to[1] }, style: { stroke: "rgba(21,88,176,.25)", lineWidth: 4, lineCap: "round" } };
        },
        encode: { x: [1, 2], y: 0 },
        data: rows.map((row, index) => [index, nullableHistoryValue(row.rank_2026), nullableHistoryValue(row.predicted_rank)]),
      },
      {
        name: "2026 实际",
        type: "scatter",
        symbolSize: 10,
        z: 2,
        data: rows.map((row) => nullableHistoryValue(row.rank_2026)),
        itemStyle: { color: "#fff", borderColor: "#1558b0", borderWidth: 2 },
      },
      {
        name: "2027 预测",
        type: "scatter",
        symbolSize: 12,
        z: 3,
        data: rows.map((row) => ({ value: nullableHistoryValue(row.predicted_rank), itemStyle: row.unit_id === selectedId ? { color: "#c96b12" } : undefined })),
        itemStyle: { color: "#1558b0", borderColor: "#fff", borderWidth: 1.5 },
        animationDelay: (index) => index * 50,
        markLine: userRankMarkLine(userRank, "xAxis", true),
      },
    ],
  }, JSON.stringify([profile.school, rows.map((row) => row.unit_id), userRank, selectedId]));
}

function renderDetail() {
  const node = el("detailPanel");
  const item = state.selected;
  const profile = state.selectedProfile;
  if (!node) return;
  if (!item) {
    node.dataset.unit = "";
    node.innerHTML = `
      <div class="empty-state detail-empty">
        <strong>等待选择院校</strong>
        <span>点击总览或推荐表会更新这里；点击“详情”进入完整院校详情。</span>
      </div>
    `;
    return;
  }
  // 同一院校的补充数据（如生活问卷）在入场动画播放中到达时，等动画播完再安静更新，不重播。
  window.clearTimeout(node.__deferRender);
  if (node.dataset.unit === item.unit_id && node.classList.contains("is-entering")) {
    node.__deferRender = window.setTimeout(renderDetail, 1250);
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
      <div><span>资料覆盖</span>${detailCoverageHtml(profile)}</div>
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
  if (node.dataset.unit !== item.unit_id) {
    node.dataset.unit = item.unit_id;
    replayEntering(node, "is-entering", 1200);
  }
  animateDetailCoverage(node, item);
}

function renderRankTrendMini() {
  if (el("entryLoader") && !el("entryLoader").hidden) return;
  const chart = getChart("rankTrendMini");
  if (!chart) return;
  const selected = state.selected || state.list[0] || {};
  // 列表数据不带历年位次，详情回来前先保持上一条曲线，避免折线先塌成空点再跳一次。
  const hasHistory = Boolean(selected.history || selected.history_2024 || selected.history_2025 || selected.history_2026);
  if (!hasHistory && chart.__trendKey) return;

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
  const rankAxis = rankAxisRange(availableRanks, applicantRank, 0.12);
  // 缺数据的年份不留空值：折线始终保持 4 个点，切换院校时才能连续变形。
  // 缺失点用相邻年份的值占位，但圆点、数字和那一段线都透明，不展示编造的数据。
  const known = ranks.map((value, index) => (value !== null && value > 0 ? index : -1)).filter((index) => index >= 0);
  const filled = ranks.map((value, index) => {
    if (!known.length) return null;
    if (known.includes(index)) return value;
    const before = known.filter((k) => k < index).pop();
    const after = known.find((k) => k > index);
    if (before === undefined) return ranks[after];
    if (after === undefined) return ranks[before];
    return Math.round(ranks[before] + ((ranks[after] - ranks[before]) * (index - before)) / (after - before));
  });
  const trendData = filled.map((value, index) => (known.includes(index)
    ? { value }
    : { value, missing: true, symbolSize: 0, label: { show: false }, itemStyle: { opacity: 0 } }));
  const visibleRange = known.length ? { gte: known[0], lte: known[known.length - 1], color: "#c96b12" } : { gte: 0, lte: 3, color: "#c96b12" };
  const trendKey = JSON.stringify([selected.unit_id, ranks, applicantRank]);
  if (chart.__trendKey === trendKey) return;
  // 首帧从左到右画线；之后切换院校时，折线、坐标轴和数字都从上一条平滑变换过去。
  chart.__trendKey = trendKey;
  chart.setOption({
    animation: !prefersReducedMotion(),
    animationDuration: 1800,
    animationDurationUpdate: 1000,
    animationEasing: "cubicOut",
    animationEasingUpdate: "cubicInOut",
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
        .filter((entry) => !entry.data?.missing && entry.value !== null && entry.value !== undefined && Number.isFinite(Number(entry.value)))
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
    visualMap: {
      show: false,
      type: "piecewise",
      dimension: 0,
      seriesIndex: 0,
      pieces: [visibleRange],
      outOfRange: { color: "rgba(201,107,18,0)" },
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
      data: trendData,
      symbol: "circle",
      symbolSize: 11,
      lineStyle: { width: 3, color: "#c96b12", cap: "round" },
      itemStyle: { color: "#fff", borderColor: "#c96b12", borderWidth: 3 },
      label: { show: true, position: "top", color: "#9a4d08", fontWeight: 900, fontSize: 10, valueAnimation: true, formatter: ({ value }) => value == null ? "" : formatInt(value) },
      markLine: userRankMarkLine(applicantRank, "yAxis"),
    }],
  });
}

// 表格里的位次迷你折线：位次越小越难考，画在上方；2027 预测用虚线连接。
function rankSparkHtml(item) {
  const values = [2024, 2025, 2026, 2027].map((year) => historyRecord(item, year).rank
    ?? (year === 2026 ? nullableHistoryValue(item.rank_2026) : null)
    ?? (year === 2027 ? nullableHistoryValue(item.predicted_rank || item.rank_mid) : null));
  const known = values.map((value, index) => [index, value]).filter(([, value]) => value !== null && value > 0);
  if (!known.length) return `<span class="spark-empty">暂无位次</span>`;
  const width = 96;
  const height = 30;
  const pad = 4;
  const ranks = known.map(([, value]) => value);
  const min = Math.min(...ranks);
  const range = Math.max(...ranks) - min || 1;
  const point = ([index, value]) => [pad + (index * (width - pad * 2)) / 3, pad + ((value - min) / range) * (height - pad * 2)];
  const history = known.filter(([index]) => index <= 2).map(point);
  const forecast = known.find(([index]) => index === 3);
  const solid = history.length > 1 ? `<polyline class="spark-line" points="${history.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")}" />` : "";
  const dashed = forecast && history.length
    ? `<line class="spark-forecast" x1="${history[history.length - 1][0].toFixed(1)}" y1="${history[history.length - 1][1].toFixed(1)}" x2="${point(forecast)[0].toFixed(1)}" y2="${point(forecast)[1].toFixed(1)}" />`
    : "";
  const dots = known.map((entry) => {
    const [x, y] = point(entry);
    return `<circle class="${entry[0] === 3 ? "spark-dot forecast" : "spark-dot"}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" />`;
  }).join("");
  return `<svg class="rank-spark" viewBox="0 0 ${width} ${height}" aria-hidden="true">${solid}${dashed}${dots}</svg>`;
}

function rankTrendCellHtml(item) {
  const record2026 = historyRecord(item, 2026);
  const rank2026 = record2026.rank ?? nullableHistoryValue(item.rank_2026);
  const score2026 = record2026.score ?? nullableHistoryValue(item.score_2026);
  const predicted = nullableHistoryValue(item.predicted_rank || item.rank_mid);
  let trend = "";
  if (rank2026 !== null && predicted !== null) {
    const delta = predicted - rank2026;
    const flat = Math.abs(delta) < Math.max(800, rank2026 * 0.015);
    trend = flat ? `<em class="trend-flat">基本持平</em>` : delta < 0 ? `<em class="trend-up">竞争增强</em>` : `<em class="trend-down">竞争放缓</em>`;
  }
  const missing = [2024, 2025].filter((year) => historyRecord(item, year).rank === null).length;
  return `
    <div class="trend-cell">
      ${rankSparkHtml(item)}
      <div class="trend-text">
        <span><b>26年</b>${score2026 === null ? "-分" : `${formatInt(score2026)}分`} · ${rank2026 === null ? "待核验" : `${formatInt(rank2026)}名`}</span>
        <span><b>27预测</b>${predicted === null ? "待核验" : `${formatInt(predicted)}名`} ${trend}</span>
        ${missing ? `<small>${missing === 2 ? "24、25 年" : "有 1 年"}历史待核验</small>` : ""}
      </div>
    </div>
  `;
}

function lifeCellHtml(item) {
  const score = coverageScore(item);
  const dots = Array.from({ length: 6 }, (_, index) => `<i class="${index < score ? "on" : ""}"></i>`).join("");
  // 列表接口不带宿舍、食堂等原文，这里只显示资料完整度；具体内容在右侧详情里看。
  return `
    <div class="life-cell">
      <div class="life-dots" title="可用资料 ${score}/6 项">${dots}<b>${score}/6</b></div>
      <small class="${hasLifeData(item) ? "has-life" : ""}">${hasLifeData(item) ? "有学生生活问卷" : "暂无生活问卷"}</small>
    </div>
  `;
}

function tableRowHtml(item, index) {
  const selected = state.selected?.unit_id === item.unit_id ? " selected-row" : "";
  const plan2025 = historyRecord(item, 2025).plan;
  const plan2026 = historyRecord(item, 2026).plan;
  const planDelta = plan2025 !== null && plan2026 !== null ? plan2026 - plan2025 : null;
  const planDeltaText = planDelta === null ? "计划变化待核验" : `较 2025 ${planDelta >= 0 ? "+" : ""}${planDelta}`;
  return `
    <tr class="${selected} table-risk-${riskTone(item)}" data-unit="${escapeHtml(item.unit_id)}" style="--i:${index}">
      <td class="order-cell"><strong>${item.order || "-"}</strong></td>
      <td>
        <div class="school-cell">
          ${logoHtml(item.logo_asset || state.logoCache[logoKey(item.school)], item.school)}
          <div class="cell-title">
            <strong>${escapeHtml(item.school)}</strong>
            <span>${escapeHtml(item.major)}</span>
            <small>${escapeHtml(schoolCity(item))} · ${escapeHtml(schoolOwnership(item))}</small>
          </div>
        </div>
      </td>
      <td class="risk-cell">
        <span class="pill ${riskClass(item.risk_level)}">${escapeHtml(riskShort(item.risk_level))}</span>
        <strong>${probabilityText(item)}</strong>
        <small>${escapeHtml(rankGapText(item))}</small>
      </td>
      <td>${rankTrendCellHtml(item)}</td>
      <td class="plan-cell">
        <strong>${plan2026 === null ? "计划待核验" : `${formatInt(plan2026)} 人`}</strong>
        <small>${escapeHtml(planDeltaText)}</small>
        <small>${escapeHtml(tuitionText(item))}</small>
      </td>
      <td>${lifeCellHtml(item)}</td>
      <td class="action-cell">
        <button class="row-action" data-unit="${escapeHtml(item.unit_id)}">详情</button>
        <button class="replace-btn" data-replace-unit="${escapeHtml(item.unit_id)}" title="换一个同层级候选">更换</button>
      </td>
    </tr>
  `;
}

function renderTable() {
  const body = el("resultBody");
  if (!body) return;
  const rows = filteredList();
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty-cell">没有匹配结果，调整筛选条件试试。</td></tr>`;
  } else {
    body.innerHTML = rows.map(tableRowHtml).join("");
  }
  markFirstPaint(body, "table");
  setText("tableCount", `已展开推荐 ${rows.length} / 96 条`);
}

// 筛选、排序、搜索后：新结果快速依次浮现。
function refreshTable() {
  renderTable();
  replayEntering(el("resultBody"), "is-refreshing", 900);
}

// 详情数据回来后只更新这一行的内容，行本身不重建，正在播的动画不会被打断。
function updateTableRow(item) {
  const row = document.querySelector(`#resultBody tr[data-unit="${CSS.escape(item.unit_id)}"]`);
  if (!row) return;
  const holder = document.createElement("tbody");
  holder.innerHTML = tableRowHtml(item, Number(row.style.getPropertyValue("--i")) || 0);
  const fresh = holder.firstElementChild;
  if (fresh) row.innerHTML = fresh.innerHTML;
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
      const leaving = replaceButton.closest("tr");
      if (leaving && !prefersReducedMotion()) {
        leaving.classList.add("row-leaving");
        await new Promise((resolve) => window.setTimeout(resolve, 320));
      }
      await replaceRecommendation(replaceButton.dataset.replaceUnit, "已更换推荐");
      return;
    }
    const unitButton = event.target.closest("[data-unit]");
    if (unitButton?.dataset.unit) {
      const explicitView =
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
    const clickable = event.target.closest(".priority-card[data-unit], .decision-table tbody tr[data-unit]");
    if (!clickable?.dataset.unit) return;
    event.preventDefault();
    await openDetail(clickable.dataset.unit);
  });
  el("searchInput")?.addEventListener("input", (event) => {
    state.query = event.target.value;
    state.page = 1;
    refreshTable();
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
    refreshTable();
  });
  el("ownershipFilterButtons")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-ownership-filter]");
    if (!button) return;
    state.ownershipFilter = button.dataset.ownershipFilter;
    state.page = 1;
    document.querySelectorAll("#ownershipFilterButtons button").forEach((node) => node.classList.toggle("active", node === button));
    refreshTable();
  });
  el("sortButtons")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-sort]");
    if (!button) return;
    state.sort = button.dataset.sort;
    document.querySelectorAll("#sortButtons button").forEach((node) => node.classList.toggle("active", node === button));
    refreshTable();
  });
  el("quickFilters")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-quick]");
    if (!button) return;
    state.quickFilter = button.dataset.quick;
    state.page = 1;
    document.querySelectorAll("#quickFilters button").forEach((node) => node.classList.toggle("active", node === button));
    refreshTable();
  });
  const tableShell = document.querySelector(".table-shell");
  tableShell?.addEventListener("scroll", () => {
    tableShell.classList.toggle("is-scrolled", tableShell.scrollTop > 4);
  }, { passive: true });
  el("dashTabs")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-dash-tab]");
    if (!button || button.classList.contains("active")) return;
    const tab = button.dataset.dashTab;
    el("dashTabs").querySelectorAll("button").forEach((node) => node.classList.toggle("active", node === button));
    document.querySelectorAll("[data-dash-pane]").forEach((pane) => pane.classList.toggle("active", pane.dataset.dashPane === tab));
    replayEntering(document.querySelector(`[data-dash-pane="${tab}"]`), "pane-entering", 500);
    // 切回趋势图时按新尺寸重绘，隐藏期间画布宽高为 0。
    if (tab === "trend") requestAnimationFrame(() => state.charts.rankTrendMini?.resize());
    // 每次打开模型诊断都重播一次环形进度动画。
    if (tab === "model") {
      if (state.charts.chartDiag) state.charts.chartDiag.__key = null;
      requestAnimationFrame(() => {
        state.charts.chartDiag?.resize();
        renderDiagChart();
      });
    }
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
    document.querySelectorAll(".center-stage, .right-rail, .mini-chart, .donut-box, #view-dashboard .chart-box").forEach((node) => observer.observe(node));
  } else {
    window.addEventListener("resize", scheduleLayoutSync, { passive: true });
  }
  updateNavIndicator();
}

let appBooted = false;
let appUnlocked = false;

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


bindEvents();
restoreEntryScore();
