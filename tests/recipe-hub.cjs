// Run: npm install --no-save playwright && npx playwright install chromium
//      node tests/recipe-hub.cjs
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
const api = "https://api.recipe.test/recipes";
const old = [{ title: "保存済みカレー", tags: ["夕食"], rating: 3, memo: "前回のメモ" }];
const fresh = [{ title: "新しいスープ", tags: ["朝食"], rating: 4, keepUrl: "https://keep.google.com/" }];

(async () => {
  const browser = await chromium.launch({ headless: true });
  let passed = 0;
  async function check(name, options, verify) {
    const context = await browser.newContext({ viewport: options.viewport || { width: 960, height: 720 } });
    const page = await context.newPage();
    const errors = [];
    let requests = 0;
    page.on("pageerror", e => errors.push(e.message));
    await context.addInitScript(({ cache, storageMode, quickTimeout }) => {
      if (cache !== null) localStorage.setItem("recipe_cache", cache);
      if (storageMode === "read") Storage.prototype.getItem = () => { throw new Error("blocked"); };
      if (storageMode === "write") Storage.prototype.setItem = () => { throw new Error("quota"); };
      if (quickTimeout) {
        const originalTimeout = window.setTimeout;
        window.setTimeout = (callback, delay, ...args) =>
          originalTimeout(callback, delay === 15000 ? 50 : delay, ...args);
      }
    }, {
      cache: options.cache === undefined ? JSON.stringify(old) : options.cache,
      storageMode: options.storageMode,
      quickTimeout: options.timeout
    });
    await page.route("https://app.recipe.test/", route => route.fulfill({
      contentType: "text/html",
      body: options.configured
        ? html.replace("ここにGASのウェブアプリURLを貼り付け", api) : html
    }));
    await page.route(api, async route => {
      requests++;
      if (options.fail) return route.abort("failed");
      if (options.pending || options.timeout) return;
      return route.fulfill({
        status: options.httpStatus || 200,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: options.body === undefined ? JSON.stringify(fresh) : options.body
      });
    });
    try {
      await page.goto("https://app.recipe.test/");
      const state = options.state || (options.configured ? "success" : "warning");
      await page.waitForFunction(expected => document.querySelector("#status").dataset.state === expected, state);
      await verify(page, () => requests);
      assert.deepEqual(errors, [], "uncaught browser errors");
      console.log("PASS " + name);
      passed++;
    } finally {
      await context.close();
    }
  }
  const cacheValue = page => page.evaluate(() => localStorage.getItem("recipe_cache"));
  const keepOld = async page => {
    assert.equal(await page.locator(".title").textContent(), old[0].title);
    assert.equal(await cacheValue(page), JSON.stringify(old));
    await page.locator("#search").fill("夕食");
    assert.equal(await page.locator(".card").count(), 1);
    await page.locator("#search").fill("見つからない");
    assert.equal(await page.locator(".card").count(), 0);
  };
  try {
    await check("API未設定: 通信なし・キャッシュ維持・検索可能", {}, async (page, count) => {
      assert.equal(count(), 0);
      assert.match(await page.locator("#status").textContent(), /APIが未設定/);
      await keepOld(page);
    });
    await check("API未設定: キャッシュなしの明示", { cache: null }, async page => {
      assert.match(await page.locator("#status").textContent(), /保存済みのレシピはありません/);
    });
    await check("通信中に先行キャッシュ表示", { configured: true, pending: true, state: "loading" }, keepOld);
    for (const [name, options] of [
      ["通信失敗", { fail: true }],
      ["HTTP 500", { httpStatus: 500 }],
      ["不正JSON", { body: "not-json" }],
      ["不正レスポンス形式", { body: '{"error":"denied"}' }],
      ["不正レシピ項目", { body: "[null]" }],
      ["15秒タイムアウト（時計を短縮）", { timeout: true }]
    ]) {
      await check(name + ": 利用者向け表示・キャッシュ維持", { configured: true, state: "error", ...options }, async page => {
        assert.match(await page.locator("#status").textContent(), /取得できませんでした/);
        await keepOld(page);
      });
    }
    await check("成功: 表示・キャッシュ更新・リンク属性", { configured: true }, async page => {
      assert.equal(await page.locator(".title").textContent(), fresh[0].title);
      assert.equal(JSON.parse(await cacheValue(page))[0].title, fresh[0].title);
      assert.equal(await page.locator("a").getAttribute("rel"), "noopener noreferrer");
      assert.equal(await page.locator("a").getAttribute("target"), "_blank");
    });
    await check("成功した空配列は古いデータをクリア", { configured: true, body: "[]" }, async page => {
      assert.equal(await page.locator(".card").count(), 0);
      assert.equal(await cacheValue(page), "[]");
    });
    await check("更新時に検索条件を維持", { configured: true, pending: true, state: "loading" }, async page => {
      await page.locator("#search").fill("夕食");
      await page.unroute(api);
      await page.route(api, route => route.fulfill({
        contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify(fresh)
      }));
      await page.evaluate(() => loadRecipes());
      assert.equal(await page.locator("#search").inputValue(), "夕食");
      assert.equal(await page.locator(".card").count(), 0);
      await page.locator("#search").fill("朝食");
      assert.equal(await page.locator(".card").count(), 1);
    });
    for (const cache of ["broken-json", '{"wrong":true}']) {
      await check("壊れたキャッシュでも起動: " + cache, { cache }, async page => {
        assert.match(await page.locator("#status").textContent(), /保存済みデータを読み込めません/);
        assert.equal(await cacheValue(page), cache);
      });
    }
    await check("ストレージ読込拒否でも取得可能", { configured: true, storageMode: "read" }, async page => {
      assert.equal(await page.locator(".title").textContent(), fresh[0].title);
    });
    await check("ストレージ保存失敗でも最新表示・既存キャッシュ維持",
      { configured: true, storageMode: "write", state: "warning" }, async page => {
        assert.equal(await page.locator(".title").textContent(), fresh[0].title);
        assert.match(await page.locator("#status").textContent(), /保存できません/);
        assert.equal(await cacheValue(page), JSON.stringify(old));
      });
    const payload = '<img src=x onerror="window.xss=1"><svg onload="window.xss=1">';
    const malicious = [{
      title: payload, tags: [payload], memo: payload, rating: 99,
      keepUrl: "javascript:window.xss=1", videoUrl: "data:text/html,<script>opener.xss=1</script>",
      photoUrl: 'https://example.com/" onclick="window.xss=1'
    }];
    for (const source of ["cache", "API"]) {
      await check("XSS: " + source + "の文字列・危険URL・属性注入",
        source === "cache" ? { cache: JSON.stringify(malicious) }
          : { configured: true, body: JSON.stringify(malicious) }, async page => {
          assert.equal(await page.locator(".title").textContent(), payload);
          assert.equal(await page.locator(".tag").textContent(), payload);
          assert.equal(await page.locator(".memo").textContent(), payload);
          assert.equal(await page.locator("#container img, #container svg, #container script, [onclick]").count(), 0);
          assert.equal(await page.locator("a").count(), 1);
          assert.equal(await page.evaluate(() => window.xss), undefined);
          assert.equal(await page.locator(".rating").textContent(), "★★★★★");
        });
    }
    await check("URL: javascript/data/vbscript/相対URLを拒否・HTTP(S)のみ",
      { cache: JSON.stringify([
        { keepUrl: "JaVaScRiPt:alert(1)", videoUrl: "java\nscript:alert(1)", photoUrl: "vbscript:msgbox(1)" },
        { keepUrl: "//example.com/", videoUrl: "/relative", photoUrl: "data:text/html,x" },
        { keepUrl: " https://example.com/path?a=1&b=2 ", videoUrl: "http://example.com/" }
      ]) }, async page => {
        assert.equal(await page.locator("a").count(), 2);
        assert.equal(await page.locator("a").first().getAttribute("href"), "https://example.com/path?a=1&b=2");
      });
    await check("評価値・欠落タグ・型不一致を安全に表示",
      { cache: JSON.stringify([{ title: 42, tags: null, rating: -2 }, { title: "正常", tags: [null, "タグ"], rating: "NaN" }, { rating: "2.9" }]) },
      async page => {
        assert.deepEqual(await page.locator(".rating").allTextContents(), ["☆☆☆☆☆", "☆☆☆☆☆", "★★☆☆☆"]);
        await page.locator("#search").fill("タグ");
        assert.equal(await page.locator(".card").count(), 1);
      });
    for (const width of [320, 390, 960]) {
      await check("幅" + width + "px: 長文・タグ・リンクが横にはみ出さない",
        { viewport: { width, height: 720 }, cache: JSON.stringify([{ ...fresh[0], title: "長".repeat(250), memo: "x".repeat(1000), tags: ["T".repeat(150)] }]) },
        async page => {
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        });
    }
    console.log(passed + " checks passed");
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
