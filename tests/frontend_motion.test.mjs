import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../static/app.js', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../static/styles.css', import.meta.url), 'utf8');

function functionSource(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  const end = source.indexOf('\n}', start) + 2;
  return source.slice(start, end);
}

for (const reduced of [false, true]) {
  test(`entry loader releases as soon as data is ready, reduced=${reduced}`, async () => {
    const delays = [];
    const loader = { hidden: true, dataset: {} };
    let resolveMinimum;
    const context = vm.createContext({
      state: { score: 500 },
      performance: { now: () => 0 },
      el: () => loader,
      setText() {},
      setEntryLoaderStep() {},
      prefersReducedMotion: () => reduced,
      setTimeout(fn, ms) { delays.push(ms); resolveMinimum = fn; },
      window: { setTimeout(fn, ms) { delays.push(ms); fn(); } },
      renderRankTrendMini() {},
    });
    vm.runInContext(
      'const ENTRY_MIN_DURATION = 1200; const ENTRY_FADE_DURATION = 220;\n' + functionSource('showEntryLoader') + '\n' + functionSource('hideEntryLoader'),
      context,
    );
    context.showEntryLoader();
    assert.equal(loader.hidden, false);
    assert.equal(loader.dataset.visible, 'true');
    const ending = context.hideEntryLoader();
    await Promise.resolve();
    assert.equal(loader.hidden, false, '早到的数据不能绕过最短展示时间');
    assert.equal(delays[0], reduced ? 120 : 1200, '开场时长必须收敛到 1.2s 以内');
    resolveMinimum();
    await ending;
    assert.equal(loader.hidden, true);
    assert.equal(loader.dataset.visible, 'false');
    assert.equal(delays[1], reduced ? 0 : 220, '淡出只留 220ms');
  });
}

test('入场标记对同一 key 只触发一次', () => {
  const context = vm.createContext({ window: { setTimeout() {} } });
  vm.runInContext('const enteredContent = new Set();', context);
  vm.runInContext(functionSource('markEntering'), context);
  const classes = new Set();
  const node = {
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
    },
    addEventListener() {},
  };
  context.markEntering(node, 'table:u1');
  assert.equal(classes.has('is-entering'), true);
  classes.delete('is-entering');
  context.markEntering(node, 'table:u1');
  assert.equal(classes.has('is-entering'), false, '重渲染不能重放入场动画');
  context.markEntering(node, 'table:u2');
  assert.equal(classes.has('is-entering'), true, '新内容仍然入场');
});

test('样式表不再包含常驻图层、无限动画与滤镜动画', () => {
  assert.equal(/^\s*will-change\s*:/m.test(styles), false, '不允许常驻 will-change');
  assert.equal(/animation[^;]*infinite/.test(styles), false, '不允许无限循环动画');
  assert.equal(/^\s*filter\s*:/m.test(styles), false, '不允许 filter 动画/过渡');
  assert.equal(/backdrop-filter/.test(styles), false, '大面积背景模糊会造成重绘抖动');
});

test('入场动画只有一个入口并允许降级', () => {
  assert.equal(styles.includes('.is-entering {'), true);
  assert.equal(styles.includes('@keyframes contentIn'), true);
  const durations = [...styles.matchAll(/animation:[^;]*?(\d+)ms/g)].map((match) => Number(match[1]));
  assert.ok(durations.every((value) => value <= 800), `存在过长动画: ${durations.filter((v) => v > 800)}`);
});

// 只拼装队列相关的函数，避免把 attachLogoAsset 的真实实现覆盖测试桩。
const queueSource = () => source.slice(source.indexOf('const logoKey ='), source.indexOf('function attachLogoAsset('))
  + '\n' + source.slice(source.indexOf('let logoRetryTimer'), source.indexOf('function setNavIndicatorToButton('));

test('logo queue consumes assets, merges simultaneous work and updates without rerender', async () => {
  let calls = 0;
  const attached = [];
  const context = vm.createContext({
    state: { logoCache: {} },
    console,
    setTimeout,
    window: { setTimeout },
    fetch: async () => { calls++; return { ok: true, status: 200, json: async () => ({ assets: { '测试大学': { status: 'ready' } } }) }; },
    attachLogoAsset: (name, asset) => attached.push([name, asset.status]),
  });
  vm.runInContext(queueSource(), context);
  const rows = [{ school: '测试大学' }, { school: '测试大学' }];
  await Promise.all([context.autoFetchLogos(rows), context.autoFetchLogos(rows)]);
  assert.equal(calls, 1);
  assert.deepEqual(attached, [['测试大学', 'ready']]);
});

test('已缓存校徽的院校不再发起请求', async () => {
  let calls = 0;
  const context = vm.createContext({
    state: { logoCache: { '测试大学': { logo_url: '/api/school-logo/abc.jpg', at: Date.now() } } },
    console,
    setTimeout,
    window: { setTimeout },
    fetch: async () => { calls++; return { ok: true, status: 200, json: async () => ({ assets: {} }) }; },
    attachLogoAsset() {},
  });
  vm.runInContext(queueSource(), context);
  await context.autoFetchLogos([{ school: '测试大学' }, { school: ' 测试 大学 ' }]);
  assert.equal(calls, 0, '命中本地缓存时不应再打接口');
});

test('被限流时不丢批次，并安排窗口结束后续跑', async () => {
  let calls = 0;
  let bodies = [];
  const retries = [];
  const context = vm.createContext({
    state: { logoCache: {} },
    console,
    setTimeout,
    window: { setTimeout: (fn, ms) => { retries.push(ms); return 1; } },
    fetch: async (_url, init) => {
      calls++;
      bodies.push(JSON.parse(init.body).schools);
      return { ok: false, status: 429, headers: { get: () => '60' }, json: async () => ({}) };
    },
    attachLogoAsset() {},
  });
  vm.runInContext(queueSource(), context);
  await context.autoFetchLogos([{ school: '测试大学' }]);
  assert.equal(calls, 1, '第一次请求被限流');
  assert.equal(retries.length, 1, '应安排一次自动续跑');
  assert.ok(retries[0] >= 10000 && retries[0] <= 30000, `续跑等待应在 10-30s: ${retries[0]}`);
  await context.autoFetchLogos([]);
  assert.equal(calls, 2, '批次被回填，下一轮仍会请求同一院校');
  assert.deepEqual(bodies[1], ['测试大学']);
});
