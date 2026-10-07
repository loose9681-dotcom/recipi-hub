// Dependency-free control-flow checks; this is not a browser or layout test.
// Run: node tests/recipe-hub-logic.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8")
  .replace(/const API_URL = "[^"]*";/, 'const API_URL = "ここにGASのウェブアプリURLを貼り付け";');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const cached = [{ title: "保存カレー", rating: 3, tags: ["夕食"], memo: "保存メモ" }];
const fresh = [{ title: "新スープ", rating: 4, tags: ["朝食"] }];
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.value = ""; }
  set innerHTML(_) { throw new Error("HTML insertion is forbidden"); }
  append(...nodes) { this.children.push(...nodes.flatMap(n => n.tag === "#fragment" ? n.children : [n])); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
}
function setup(options = {}) {
  const elements = Object.fromEntries(["container", "status", "search"].map(id => [id, new Element("div")]));
  const original = options.cache === undefined ? JSON.stringify(cached) : options.cache;
  let stored = original;
  let calls = 0;
  const context = vm.createContext({
    document: {
      getElementById: id => elements[id],
      createElement: tag => new Element(tag),
      createDocumentFragment: () => new Element("#fragment")
    },
    localStorage: {
      getItem: () => { if (options.readFail) throw Error("blocked"); return stored; },
      setItem: (_, value) => { if (options.writeFail) throw Error("quota"); stored = value; }
    },
    console: { error() {} }, URL, AbortController,
    setTimeout: callback => { if (options.timeout) queueMicrotask(callback); return 1; },
    clearTimeout() {},
    fetch: async (_, { signal }) => {
      calls++;
      if (options.pending) return new Promise(() => {});
      if (options.timeout) return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(Error("aborted")));
      });
      if (options.fail) throw Error("network");
      return {
        ok: !options.httpFail, status: options.httpFail ? 500 : 200,
        json: async () => {
          if (options.jsonFail) throw SyntaxError("invalid JSON");
          return options.data === undefined ? fresh : options.data;
        }
      };
    }
  });
  vm.runInContext(options.configured ? script.replace("ここにGASのウェブアプリURLを貼り付け", "https://example.com/api") : script, context);
  return { context, elements, stored: () => stored, original, calls: () => calls };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const nodes = el => [el, ...el.children.flatMap(nodes)];
const titles = app => nodes(app.elements.container).filter(n => n.className === "title").map(n => n.textContent);
let passed = 0;
async function check(name, options, verify) {
  const app = setup(options);
  await settle();
  await verify(app);
  console.log("PASS " + name);
  passed++;
}
(async () => {
  await check("API未設定・通信なし・保存データ維持", {}, app => {
    assert.equal(app.calls(), 0);
    assert.equal(app.elements.status.dataset.state, "warning");
    assert.deepEqual(titles(app), ["保存カレー"]);
    assert.equal(app.stored(), app.original);
  });
  await check("キャッシュなしの状態表示", { cache: null }, app => {
    assert.match(app.elements.status.textContent, /保存済みのレシピはありません/);
  });
  await check("取得中にキャッシュを先行表示", { configured: true, pending: true }, app => {
    assert.equal(app.elements.status.dataset.state, "loading");
    assert.deepEqual(titles(app), ["保存カレー"]);
  });
  for (const [name, options] of [
    ["通信失敗", { fail: true }], ["HTTP失敗", { httpFail: true }],
    ["JSON失敗", { jsonFail: true }], ["配列以外", { data: { error: "denied" } }],
    ["不正項目", { data: [null] }], ["タイムアウト", { timeout: true }]
  ]) await check(name + "時に表示と保存データ維持", { configured: true, ...options }, app => {
    assert.equal(app.elements.status.dataset.state, "error");
    assert.deepEqual(titles(app), ["保存カレー"]);
    assert.equal(app.stored(), app.original);
    app.elements.search.value = "夕食";
    vm.runInContext("filterRecipes()", app.context);
    assert.deepEqual(titles(app), ["保存カレー"]);
  });
  await check("成功時だけ更新", { configured: true }, app => {
    assert.equal(app.elements.status.dataset.state, "success");
    assert.deepEqual(titles(app), ["新スープ"]);
    assert.equal(JSON.parse(app.stored())[0].title, "新スープ");
  });
  await check("成功の空配列は保存データ更新", { configured: true, data: [] }, app => {
    assert.deepEqual(titles(app), []);
    assert.equal(app.stored(), "[]");
  });
  await check("更新時にも検索条件維持", { configured: true, pending: true }, async app => {
    app.elements.search.value = "夕食";
    app.context.fetch = async () => ({ ok: true, json: async () => fresh });
    await vm.runInContext("loadRecipes()", app.context);
    assert.equal(app.elements.search.value, "夕食");
    assert.deepEqual(titles(app), []);
    app.elements.search.value = "朝食";
    vm.runInContext("filterRecipes()", app.context);
    assert.deepEqual(titles(app), ["新スープ"]);
  });
  for (const cache of ["bad-json", '{"wrong":true}']) await check("壊れたキャッシュ: " + cache, { cache }, app => {
    assert.match(app.elements.status.textContent, /保存済みデータを読み込めません/);
    assert.equal(app.stored(), cache);
  });
  await check("ストレージ読込拒否でも取得", { configured: true, readFail: true }, app => {
    assert.deepEqual(titles(app), ["新スープ"]);
  });
  await check("保存失敗でも最新表示と古い保存データ維持", { configured: true, writeFail: true }, app => {
    assert.equal(app.elements.status.dataset.state, "warning");
    assert.deepEqual(titles(app), ["新スープ"]);
    assert.equal(app.stored(), app.original);
  });
  const payload = '<img src=x onerror="alert(1)">';
  for (const source of ["cache", "API"]) {
    const data = [{ title: payload, tags: [payload], memo: payload, rating: 99,
      keepUrl: "javascript:alert(1)", videoUrl: "data:text/html,x", photoUrl: 'https://example.com/" onclick="alert(1)' }];
    await check("安全なDOM構築: " + source,
      source === "cache" ? { cache: JSON.stringify(data) } : { configured: true, data }, app => {
        const all = nodes(app.elements.container);
        assert.equal(all.filter(n => n.tag === "a").length, 1);
        const link = all.find(n => n.tag === "a");
        assert.equal(link.rel, "noopener noreferrer");
        assert.equal(link.target, "_blank");
        assert.equal(all.find(n => n.className === "title").textContent, payload);
        assert.equal(all.find(n => n.className === "tag").textContent, payload);
        assert.equal(all.find(n => n.className === "memo").textContent, payload);
        assert.equal(all.find(n => n.className === "rating").textContent, "★★★★★");
      });
  }
  await check("危険スキーム・相対URLを拒否", {}, app => {
    for (const url of ["javascript:alert(1)", "java\nscript:alert(1)", "data:text/html,x", "vbscript:x", "/relative", "//example.com/"]) {
      app.context.testUrl = url;
      assert.equal(vm.runInContext("safeHttpUrl(testUrl)", app.context), null);
    }
    assert.equal(vm.runInContext('safeHttpUrl(" https://example.com/ ")', app.context), "https://example.com/");
  });
  await check("型不一致・評価範囲・欠落タグでも検索可能", {
    cache: JSON.stringify([{ title: 2, tags: null, rating: -1 }, { title: "正常", tags: [null, "朝食"], rating: "NaN" }, { rating: "2.9" }])
  }, app => {
    assert.deepEqual(nodes(app.elements.container).filter(n => n.className === "rating").map(n => n.textContent), ["☆☆☆☆☆", "☆☆☆☆☆", "★★☆☆☆"]);
    app.elements.search.value = "朝食";
    vm.runInContext("filterRecipes()", app.context);
    assert.deepEqual(titles(app), ["正常"]);
  });
  console.log(passed + " logic checks passed (DOM double; no browser/layout validation)");
})().catch(error => { console.error(error); process.exitCode = 1; });
