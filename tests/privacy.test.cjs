const assert = require("node:assert/strict");
const { once } = require("node:events");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawn } = require("node:child_process");
const { test } = require("node:test");

const source = readFileSync(join(__dirname, "../viewport-translator.user.js"), "utf8");

async function browserTests() {
  const script = await fetch("/source").then(response => response.text());
  const generation = "a".repeat(32);
  const oldCacheKey = "translation:v1:" + "1".repeat(64);
  const diskKeys = values => Array.from(values.keys()).filter(name => name.startsWith("translation:v"));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const until = async (predicate, message) => {
    for (let i = 0; i < 100 && !predicate(); i += 1) await sleep(30);
    assert(predicate(), message);
  };
  const defaultKey = ["api-key:openai", "fixture-api-key"];
  const site = (enabled, allow = [], deny = []) => ({ enabled, allow, deny });
  const opened = [];

  function storage(entries = [defaultKey]) {
    const values = new Map(entries);
    const listeners = new Map();
    const notify = (name, previous, value, origin) => {
      for (const { tab, callback } of listeners.get(name) ?? []) {
        callback(name, previous, value, tab !== origin);
      }
    };
    return {
      values, listeners,
      write(name, value, { origin, notifyTabs = true } = {}) {
        const previous = values.get(name);
        if (value === undefined) values.delete(name);
        else values.set(name, value);
        if (notifyTabs) notify(name, previous, value, origin);
      },
    };
  }

  async function open(options = {}) {
    const {
      path = "/", host = "example.test", scheme = "https:", html = "<p>Public article text</p>",
      shared = storage(), incognito = false, managerVersion = "5.5.1", touch = false, setup,
      scriptHandler = "Tampermonkey", browserName = "Firefox", injectInto = "content", firefoxContent = true,
    } = options;
    const frame = document.createElement("iframe");
    const ready = new Promise(resolve => { frame.onload = resolve; });
    frame.src = "/fixture";
    frame.width = 900;
    frame.height = 300;
    frame.style.cssText = "position:fixed; top:0; left:0; border:0";
    document.body.append(frame);
    await ready;
    opened.push(frame);
    const win = frame.contentWindow;
    const doc = frame.contentDocument;
    win.history.replaceState(null, "", path);
    doc.body.innerHTML = html;
    setup?.(doc);
    const requests = [];
    const menus = new Map();
    const watches = new Set();
    let nextMenu = 0;
    const realLocation = win.location;
    const location = {
      hostname: host.split(":")[0],
      port: host.split(":")[1] ?? "",
      protocol: scheme,
      origin: scheme + "//" + host,
      get pathname() { return realLocation.pathname; },
      get search() { return realLocation.search; },
      get hash() { return realLocation.hash; },
    };
    const mocks = {
      location,
      GM_info: { scriptHandler, version: managerVersion, isIncognito: incognito, injectInto, platform: { browserName } },
      content: firefoxContent ? { fetch() {} } : undefined,
      fetch(url, init) {
        return new Promise((resolve, reject) => {
          const details = {
            url, method: init.method, headers: init.headers, data: init.body,
            onload(response) {
              resolve({
                ok: response.status >= 200 && response.status < 300, status: response.status,
                url: response.finalUrl, text: async () => response.responseText,
                headers: new win.Headers(),
              });
            },
          };
          const call = { details, fetchOptions: init, aborted: false };
          requests.push(call);
          init.signal.addEventListener("abort", () => {
            call.aborted = true;
            reject(new Error("Aborted"));
          }, { once: true });
        });
      },
      GM_getValue: name => shared.values.get(name),
      GM_setValue: (name, value) => shared.write(name, value, { origin: frame }),
      GM_deleteValue: name => shared.write(name, undefined, { origin: frame }),
      GM_listValues: () => Array.from(shared.values.keys()),
      GM_addValueChangeListener(name, callback) {
        if (!shared.listeners.has(name)) shared.listeners.set(name, []);
        shared.listeners.get(name).push({ tab: frame, callback });
      },
      GM_registerMenuCommand(label, handler) {
        menus.set(nextMenu, { label, handler });
        return nextMenu++;
      },
      GM_unregisterMenuCommand: id => menus.delete(id),
      GM_xmlhttpRequest(details) {
        const call = { details, aborted: false };
        requests.push(call);
        return { abort() { call.aborted = true; details.onabort(); } };
      },
      IntersectionObserver: class extends win.IntersectionObserver {
        constructor(callback, options) { super(callback, options); watches.add(this); }
        disconnect() { watches.delete(this); super.disconnect(); }
      },
      MutationObserver: class extends win.MutationObserver {
        constructor(callback) { super(callback); watches.add(this); }
        disconnect() { watches.delete(this); super.disconnect(); }
      },
    };
    const nativeMatch = win.matchMedia.bind(win);
    if (touch) win.matchMedia = query => query === "(pointer: coarse)"
      ? { matches: true, addEventListener() {} } : nativeMatch(query);
    new win.Function(...Object.keys(mocks), script)(...Object.values(mocks));
    return {
      doc, win, requests, watches, shared,
      navigate(url) {
        win.history.pushState(null, "", url);
        win.dispatchEvent(new win.Event("urlchange"));
      },
      menu(pattern) {
        const item = Array.from(menus.values()).find(({ label }) => pattern.test(label));
        assert(item, "Missing menu " + pattern);
        item.handler();
      },
    };
  }

  const noSend = async (tab, message) => {
    await sleep(300);
    assert(tab.requests.length === 0, message);
  };
  const inputGroups = call => JSON.parse(JSON.parse(call.details.data).input);
  const complete = call => {
    const translations = inputGroups(call).map(({ id, parts }) =>
      ({ id, parts: parts.map(() => "Translated text") }));
    call.details.onload({
      status: 200,
      finalUrl: call.details.url,
      responseText: JSON.stringify({
        status: "completed", output: [{ type: "message", content: [{
          type: "output_text", text: JSON.stringify({ translations }),
        }] }],
      }),
    });
  };
  const waitRequest = tab => until(() => tab.requests.length > 0, "No request for eligible content");

  const cases = [
    ["fresh install and fabricated page events", async () => {
      const tab = await open({ shared: storage([]), host: "boards.4chan.org", path: "/g/" });
      tab.win.dispatchEvent(new tab.win.KeyboardEvent("keydown", { code: "KeyT", altKey: true, shiftKey: true }));
      tab.doc.dispatchEvent(new tab.win.Event("PostsInserted", { bubbles: true }));
      tab.win.dispatchEvent(new tab.win.Event("urlchange"));
      await noSend(tab, "Fresh install sent a request");
      assert(tab.watches.size === 0, "Fresh install attached a DOM observer");
      assert(tab.shared.values.size === 0, "Fabricated events wrote to storage");
    }],
    ["provider ready, different site enabled", async () => {
      const tab = await open({ shared: storage([defaultKey, ["enabled-sites", ["other.test"]]]) });
      tab.win.dispatchEvent(new tab.win.KeyboardEvent("keydown", { code: "KeyT", altKey: true, shiftKey: true }));
      await noSend(tab, "No matching opt-in but a request was sent");
      assert(tab.watches.size === 0, "Unapproved site attached a DOM observer");
    }],
    ["allow list, deny precedence, and alternate origins", async () => {
      const shared = storage([defaultKey, ["site-policy:example.test", site(true, ["/docs"], ["/docs/members"])]]);
      for (const options of [
        { path: "/docsets" }, { path: "/docs/MeMbErS" }, { path: "/docs/%6dembers/team" },
        { path: "/docs%2Fmembers" }, { path: "/docs?view=messages" }, { path: "/docs#/messages/abc" },
        { path: "/docs", scheme: "http:" }, { path: "/docs", host: "example.test:8443" },
      ]) {
        const tab = await open({ shared, ...options });
        await noSend(tab, "An unapproved path or origin sent text");
        assert(tab.watches.size === 0, "A blocked route attached a DOM observer");
      }
      const tab = await open({ shared, path: "/docs/guide", touch: true });
      await waitRequest(tab);
      assert(inputGroups(tab.requests[0]).flatMap(group => group.parts).includes("Public article text"), "Allowed path did not send article");
    }],
    ["permanent site block beats legacy consent and enable menu", async () => {
      const shared = storage([defaultKey, ["enabled-sites", ["example.test"]], ["site-block:example.test", true]]);
      const tab = await open({ shared, host: "www.example.test" });
      tab.menu(/^Enable on/);
      await noSend(tab, "Permanent block allowed a request");
      assert(!shared.values.has("site-policy:example.test"), "Menu re-enabled a blocked site");
    }],
    ["privacy signals on an otherwise enabled route", async () => {
      const shared = storage([defaultKey, ["enabled-sites", ["example.test"]]]);
      for (const options of [
        { path: "/a/%256Cogin" }, { path: "/account/billing" }, { path: "/?state=xyz&code=fixture" },
        { path: "/#access_token=fixture" }, { html: "<p>Private content</p><input type=password>" },
        { html: "<meta name=rating content=adult><p>Private content</p>" },
      ]) {
        const tab = await open({ shared, ...options });
        await noSend(tab, "Sensitive page sent text");
        assert(tab.watches.size === 0, "Sensitive page started observation");
      }
    }],
    ["Reddit mixed feed and marked thread/comments", async () => {
      const shared = storage([defaultKey, ["enabled-sites", ["reddit.com", "m.reddit.com"]]]);
      const story = "<span slot=title>Private post title</span><shreddit-nsfw-badge></shreddit-nsfw-badge>";
      const feed = await open({
        shared, host: "www.reddit.com", path: "/r/fixture",
        html: `<shreddit-post>${story}</shreddit-post><shreddit-post over18=false><span slot=title>Public Reddit title</span></shreddit-post>`,
      });
      await waitRequest(feed);
      assert(JSON.stringify(inputGroups(feed.requests[0])).includes("Public Reddit title"), "Safe item was skipped");
      assert(!feed.requests[0].details.data.includes("Private post title"), "NSFW item leaked from mixed list");
      const mobileFeed = await open({
        shared, host: "m.reddit.com", path: "/r/fixture",
        html: "<shreddit-post nsfw><p>Private mobile post</p></shreddit-post><shreddit-post><p>Public mobile post</p></shreddit-post>",
      });
      await waitRequest(mobileFeed);
      assert(mobileFeed.requests[0].details.data.includes("Public mobile post") &&
        !mobileFeed.requests[0].details.data.includes("Private mobile post"), "Mobile fallback missed post privacy metadata");
      for (const options of [
        { host: "www.reddit.com", html: `<shreddit-post id=t3_abc>${story}</shreddit-post>` },
        { host: "old.reddit.com", html: "<div class='thing link over18' data-fullname='t3_abc'><div class=entry><a class=title>Private title</a></div></div>" },
        { host: "m.reddit.com", html: "<shreddit-post id=t3_other><span slot=title>Unrelated title</span></shreddit-post>" },
      ]) {
        const tab = await open({
          ...options, shared, path: "/r/fixture/comments/abc/title",
          html: options.html + "<shreddit-comment><p slot=comment>Private comment text</p></shreddit-comment>",
        });
        await noSend(tab, "A marked or unclassified Reddit thread sent text");
      }
      const safe = await open({
        shared, host: "www.reddit.com", path: "/r/fixture/comments/abc/title",
        html: "<shreddit-post post-id=t3_abc><p slot=title>Public thread title</p></shreddit-post><shreddit-comment><p slot=comment>Public comment</p></shreddit-comment>",
      });
      await waitRequest(safe);
      assert(safe.requests[0].details.data.includes("Public comment"), "Safe thread comments did not translate");
    }],
    ["4chan board classification and synthetic native-style DOM event", async () => {
      const shared = storage([defaultKey, ["enabled-sites", ["4chan.org"]]]);
      const html = "<form id=delform name=delform><div class=post><blockquote class=postMessage>Board text sample</blockquote></div></form>";
      for (const path of ["/b/", "/pol/thread/123", "/unknown/"]) {
        const tab = await open({ shared, host: "boards.4chan.org", path, html });
        tab.doc.querySelector(".post").dispatchEvent(new tab.win.Event("PostsInserted", { bubbles: true }));
        await noSend(tab, "An NSFW or unclassified board sent text");
      }
      const safe = await open({ shared, host: "boards.4chan.org", path: "/g/", html });
      await waitRequest(safe);
      assert(safe.requests[0].details.data.includes("Board text sample"), "A worksafe board did not translate");
    }],
    ["Bilibili public views and Linux.do topic classification", async () => {
      const shared = storage([defaultKey, ["enabled-sites", ["bilibili.com", "m.bilibili.com", "linux.do"]]]);
      const desktop = await open({
        shared, host: "www.bilibili.com", path: "/video/BVfixture",
        html: "<h1 class=video-title>Public video title</h1><bili-comments></bili-comments>",
        setup(doc) {
          let parent = doc.querySelector("bili-comments");
          for (const tag of ["bili-comment-thread-renderer", "bili-comment-renderer", "bili-rich-text"]) {
            const next = doc.createElement(tag);
            parent.attachShadow({ mode: "open" }).append(next);
            parent = next;
          }
          parent.attachShadow({ mode: "open" }).innerHTML = "<p id=contents>Public shadow comment</p>";
        },
      });
      await waitRequest(desktop);
      assert(desktop.requests[0].details.data.includes("Public shadow comment"), "Bilibili shadow comments did not translate");
      const mobile = await open({ shared, host: "m.bilibili.com", path: "/video/BVfixture", touch: true });
      await waitRequest(mobile);
      const topic = { shared, host: "linux.do", path: "/t/fixture/123", html: "<div class=topic-post><p class=cooked>Topic text</p></div>" };
      const privateTopic = await open({ ...topic, setup: doc => { doc.body.className = "archetype-private_message"; } });
      await noSend(privateTopic, "Linux.do private message sent text");
      const publicTopic = await open({ ...topic, setup: doc => { doc.body.className = "archetype-regular"; } });
      await waitRequest(publicTopic);
    }],
    ["disable locally aborts and disconnects", async () => {
      const tab = await open({ shared: storage([defaultKey, ["enabled-sites", ["example.test"]]]) });
      await waitRequest(tab);
      tab.menu(/^Disable on/);
      assert(tab.requests[0].aborted && tab.watches.size === 0, "Local opt-out left a request or observer active");
      tab.doc.body.insertAdjacentHTML("beforeend", "<p>After opt-out</p>");
      await sleep(300);
      assert(tab.requests.length === 1, "New request after local opt-out");
    }],
    ["original view aborts and blocks subsequent work", async () => {
      const tab = await open({ shared: storage([defaultKey, ["enabled-sites", ["example.test"]]]) });
      await waitRequest(tab);
      tab.menu(/^Show Original Text/);
      assert(tab.requests[0].aborted && tab.watches.size === 0, "Original view did not stop translation");
      tab.doc.body.insertAdjacentHTML("beforeend", "<p>Original view text</p>");
      tab.win.dispatchEvent(new tab.win.Event("scroll"));
      await sleep(300);
      assert(tab.requests.length === 1, "Original view sent more text");
    }],
    ["SPA private navigation aborts and quarantines stale content", async () => {
      const tab = await open({ shared: storage([defaultKey, ["enabled-sites", ["example.test"]]]) });
      await waitRequest(tab);
      tab.navigate("/messages/conversation");
      assert(tab.requests[0].aborted && tab.watches.size === 0, "SPA navigation did not abort and disconnect");
      tab.doc.body.innerHTML = "<p>Private stale message text</p>";
      await sleep(300);
      tab.navigate("/public");
      await sleep(300);
      assert(tab.requests.length === 1, "A new or stale message was sent");
      tab.doc.body.innerHTML = "<p>New public text</p>";
      await until(() => tab.requests.length === 2, "Public SPA route did not resume");
      assert(!tab.requests[1].details.data.includes("Private stale message text"), "Stale text crossed routes");
    }],
    ["SPA URL checked without a URL notification", async () => {
      const tab = await open({ shared: storage([defaultKey, ["enabled-sites", ["example.test"]]]) });
      tab.win.history.pushState(null, "", "/private-messages");
      tab.doc.body.innerHTML = "<p>Private replacement text</p>";
      await noSend(tab, "SPA with no userscript URL notification sent text");
    }],
    ["remote disable and storage recheck before notification", async () => {
      const shared = storage([defaultKey, ["site-policy:example.test", site(true)]]);
      const tab = await open({ shared });
      await waitRequest(tab);
      const second = await open({ shared, path: "/other" });
      second.menu(/^Disable on/);
      assert(tab.requests[0].aborted && tab.watches.size === 0, "Remote opt-out left request or observer active");
      await noSend(second, "Opt-out raced a queued request");
      shared.write("site-policy:example.test", site(true));
      const pending = await open({ shared });
      shared.write("site-policy:example.test", site(false), { notifyTabs: false });
      pending.menu(/^Disable on/);
      assert(!shared.values.get("site-policy:example.test").enabled, "Stale Disable menu enabled the site");
      await noSend(pending, "Queued batch used stale consent");
      assert(pending.watches.size === 0, "Stale consent left an observer");

      shared.write("site-policy:example.test", site(true));
      const queued = await open({ shared, path: "/queued" });
      shared.write("site-policy:example.test", site(false), { notifyTabs: false });
      await noSend(queued, "Queued batch used stale consent before the storage notification");
    }],
    ["request data, input exclusions, and provider flags", async () => {
      const tab = await open({
        shared: storage([defaultKey, ["enabled-sites", ["example.test"]]]),
        path: "/public?opaque=do-not-send#anchor",
        html: "<p>Public text<input value='private input'></p><div data-private><p>Private region</p></div>" +
          "<p>Authorization: Bearer token12345678901234567890</p><form><p>Private form text</p></form>",
      });
      await waitRequest(tab);
      const { details } = tab.requests[0];
      assert(details.url === "https://api.openai.com/v1/responses" && details.anonymous && details.redirect === "error", "Unexpected transport");
      assert(JSON.parse(details.data).store === false, "OpenAI storage was enabled");
      assert(details.headers.Authorization === "Bearer fixture-api-key", "Incorrect API authorization");
      assert(!/private|token123|fixture-api-key|do-not-send|example\.test|anchor/i.test(details.data), "Payload contained private data");
      assert(!("Cookie" in details.headers) && !("Referer" in details.headers), "Page headers were copied");
      complete(tab.requests[0]);
      await until(() => tab.doc.body.textContent.includes("Translated text"), "Normal response did not render");
      assert(diskKeys(tab.shared.values).length === 0, "Default settings persisted a translation");
    }],
    ["Violentmonkey Firefox translates public Reddit posts with redirect protection", async () => {
      const shared = storage([defaultKey, ["enabled-sites", ["reddit.com"]]]);
      const config = {
        shared, scriptHandler: "Violentmonkey", managerVersion: "2.50.0",
        host: "www.reddit.com", path: "/r/fixture",
        html: "<shreddit-post><p slot=title>Public Reddit post</p></shreddit-post>" +
          "<shreddit-post nsfw><p slot=title>Private marked post</p></shreddit-post>",
      };
      const tab = await open(config);
      await waitRequest(tab);
      const call = tab.requests[0];
      assert(call.fetchOptions?.redirect === "error" && call.fetchOptions.credentials === "omit" &&
        call.fetchOptions.mode === "same-origin" && call.fetchOptions.referrerPolicy === "no-referrer",
      "Violentmonkey did not use the isolated Firefox request with redirect and credential restrictions");
      assert(call.details.data.includes("Public Reddit post") && !call.details.data.includes("Private marked post"),
        "Violentmonkey did not preserve Reddit post filtering");
      complete(call);
      await until(() => tab.doc.body.textContent.includes("Translated text"), "Violentmonkey response did not render");

      for (const flags of [
        { browserName: "Chrome" }, { firefoxContent: false }, { injectInto: "page" }, { incognito: true },
      ]) {
        const blocked = await open({ ...config, ...flags });
        await noSend(blocked, "Violentmonkey sent text without a verified private transport");
        assert(blocked.watches.size === 0, "Violentmonkey started observation in an unsupported context");
      }
    }],
    ["provider compatibility and custom endpoint key binding", async () => {
      const providers = [
        ["anthropic", "https://api.anthropic.com/v1/messages", "x-api-key", false],
        ["gemini", "https://generativelanguage.googleapis.com/v1beta/interactions", "x-goog-api-key", true],
        ["xai", "https://api.x.ai/v1/responses", "Authorization", true],
        ["deepseek", "https://api.deepseek.com/chat/completions", "Authorization", false],
      ];
      for (const [provider, url, header, noStore] of providers) {
        const tab = await open({ shared: storage([
          ["api-key:" + provider, "fixture-provider-key"],
          ["settings", { provider }], ["enabled-sites", ["example.test"]],
        ]) });
        await waitRequest(tab);
        const { details } = tab.requests[0];
        assert(details.url === url && details.headers[header]?.endsWith("fixture-provider-key"), "Wrong provider request for " + provider);
        assert(!noStore || JSON.parse(details.data).store === false, "Storage was enabled for " + provider);
      }
      const custom = base => storage([
        ["settings", { provider: "custom", customBaseUrl: base, model: "fixture-model" }],
        ["api-key:custom", { baseUrl: "https://other.test/v1", value: "wrong-endpoint-key" }],
        ["enabled-sites", ["example.test"]],
      ]);
      const rejected = await open({ shared: custom("http://api.test/v1") });
      await noSend(rejected, "Insecure remote endpoint received a request");
      const local = await open({ shared: custom("http://localhost:11434/v1") });
      await waitRequest(local);
      assert(local.requests[0].details.url === "http://localhost:11434/v1/chat/completions" &&
        !local.requests[0].details.headers.Authorization, "Custom endpoint was wrong or received a key for a different URL");
    }],
    ["cache expiry, opt-in and generation reset", async () => {
      const expiredKey = "translation:v2:" + "2".repeat(64);
      const shared = storage([
        defaultKey, ["enabled-sites", ["example.test"]],
        ["translation-cache-policy", { persistent: true, generation }],
        [oldCacheKey, { text: "Legacy cached text", savedAt: Date.now() }],
        [expiredKey, { text: "Expired text", savedAt: Date.now() - 86400001, generation }],
      ]);
      const tab = await open({ shared });
      await waitRequest(tab);
      assert(diskKeys(shared.values).length === 0, "Legacy or expired cache was not physically deleted");
      complete(tab.requests[0]);
      await until(() => diskKeys(shared.values).length === 1, "Opted-in cache did not persist");
      const keys = diskKeys(shared.values);
      shared.write("translation-cache-policy", { persistent: true, generation: "b".repeat(32) });
      await until(() => tab.requests.length === 2, "Old cache was reused after reset");
      await until(() => keys.every(key => !shared.values.has(key)), "Reset left an old generation on disk");
    }],
    ["incognito, undetectable private state, and obsolete redirect transport", async () => {
      for (const options of [{ incognito: true }, { incognito: null }, { managerVersion: "4.9" }]) {
        const shared = storage([defaultKey, ["enabled-sites", ["example.test"]], [oldCacheKey, { text: "Legacy fixture", savedAt: Date.now() }]]);
        const tab = await open({ shared, ...options });
        await noSend(tab, "Untrusted privacy or transport context sent text");
        assert(tab.watches.size === 0, "Untrusted context started watching the DOM");
        if (options.incognito !== undefined) assert(shared.values.has(oldCacheKey), "Private context wrote to storage");
      }
    }],
  ];

  const failures = [];
  for (const [name, run] of cases) {
    try {
      await run();
    } catch (error) {
      failures.push(`${name}: ${error.message}\n${error.stack}`);
    } finally {
      for (const frame of opened.splice(0)) frame.remove();
    }
  }
  return { count: cases.length, failures };
}

test("privacy regression suite in Firefox", { timeout: 60_000 }, async t => {
  const profile = mkdtempSync(join(tmpdir(), "viewport-translator-firefox-"));
  writeFileSync(join(profile, "user.js"), [
    'user_pref("app.update.auto", false);',
    'user_pref("app.normandy.enabled", false);',
    'user_pref("extensions.update.enabled", false);',
    'user_pref("network.captive-portal-service.enabled", false);',
    'user_pref("network.connectivity-service.enabled", false);',
    'user_pref("toolkit.telemetry.enabled", false);',
  ].join("\n"));
  let resolveResult;
  const result = new Promise(resolve => { resolveResult = resolve; });
  const server = createServer(async (request, response) => {
    if (request.url === "/result" && request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      response.end("ok");
      resolveResult(JSON.parse(Buffer.concat(chunks)));
    } else if (request.url === "/source") {
      response.end(source);
    } else if (request.url === "/") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><body><script>
        (${browserTests.toString()})().catch(error => ({ failures: [error.stack] })).then(result =>
          fetch("/result", { method: "POST", body: JSON.stringify(result) }));
      </script>`);
    } else {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end("<!doctype html><html lang=en><head><meta charset=utf-8></head><body></body></html>");
    }
  });
  let browser;
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      browser.kill();
      await once(browser, "close");
    }
    rmSync(profile, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let logs = "";
  browser = spawn(process.env.FIREFOX ?? "firefox", [
    "--headless", "--no-remote", "--profile", profile, `http://127.0.0.1:${server.address().port}/`,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  browser.stderr.on("data", chunk => { logs = (logs + chunk).slice(-2000); });
  const report = await Promise.race([result, once(browser, "exit").then(([code]) => {
    throw new Error(`Firefox exited (${code})\n${logs}`);
  })]);
  assert.deepEqual(report.failures, []);
  t.diagnostic(`${report.count} browser scenarios passed with mocked userscript storage and HTTP requests.`);
});
