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
                headers: new win.Headers(response.headers),
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
  const complete = (call, translate = () => "Translated text") => {
    const translations = inputGroups(call).map(({ id, parts }) =>
      ({ id, parts: parts.map(translate) }));
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

  // Freeze only the fixture window after its first request. The test runner keeps real time.
  function freezeTime(win) {
    let now = Math.floor(Date.now() / 1000) * 1000;
    let id = 0;
    const timers = new Map();
    const clearNative = win.clearTimeout.bind(win);
    win.Date.now = () => now;
    win.setTimeout = (callback, delay) => {
      assert(delay >= 0 && delay <= 2 ** 31 - 1, "Delay exceeds the browser timer range");
      timers.set(--id, { when: now + delay, callback });
      return id;
    };
    win.clearTimeout = handle => {
      if (!timers.delete(handle)) clearNative(handle);
    };
    return {
      get now() { return now; },
      scheduledAt(when) { return Array.from(timers.values()).some(timer => timer.when === when); },
      advance(ms) {
        now += ms;
        const due = Array.from(timers).sort((a, b) => a[1].when - b[1].when);
        for (const [handle, { when, callback }] of due) {
          if (when <= now && timers.delete(handle)) callback();
        }
      },
    };
  }

  function rateLimit(call, header) {
    call.details.onload({
      status: 429, finalUrl: call.details.url, responseText: "",
      headers: header == null ? {} : { "Retry-After": header },
      responseHeaders: header == null ? "" : "Content-Type: application/json\r\nrEtRy-AfTeR:\t" + header + "\r\n",
    });
  }

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
    ["Phoronix home cards translate after opt-in and on scroll, then restore", async () => {
      const tab = await open({
        host: "www.phoronix.com",
        html: "<div id=main><article><header><a href='/news/one'>First headline</a></header>" +
          "<div class=details>Story metadata</div><p>First summary</p></article>" +
          "<article style='margin-top:800px'><header><a href='/news/two'>Second headline</a></header></article></div>",
      });
      const main = tab.doc.querySelector("#main");
      const original = main.innerHTML;
      const [first, second] = main.querySelectorAll("header a");
      await noSend(tab, "Phoronix translated before site opt-in");
      tab.menu(/^Enable on/);
      await waitRequest(tab);
      const parts = inputGroups(tab.requests[0]).flatMap(group => group.parts);
      assert(parts.length === 2 && parts.includes("First headline") && parts.includes("First summary"),
        "The visible card title and summary should be the only parts in the first batch");
      complete(tab.requests[0]);
      await until(() => first.textContent === "Translated text", "Card headline did not render");
      second.scrollIntoView();
      await until(() => tab.requests.length === 2, "Scrolling to the next card did not translate it");
      assert(inputGroups(tab.requests[1])[0].parts[0] === "Second headline", "Wrong card after scrolling");
      complete(tab.requests[1]);
      await until(() => second.textContent === "Translated text", "Second headline did not render");
      tab.menu(/^Show Original Text/);
      assert(main.innerHTML === original && main.querySelector("a") === first, "Original cards or links were lost");
    }],
    ["Phoronix articles preserve bare text, inline links and review paragraphs", async () => {
      const shared = storage([defaultKey, ["site-policy:phoronix.com", site(true)]]);
      const tab = await open({
        shared, host: "phoronix.com", path: "/news/example",
        html: "<div id=main><article class=full><h1>Story headline</h1><div class=author>Byline</div>" +
          "<div class=content>Opening <a href='/news/source'>source link</a> continues.<br><br>Next paragraph." +
          "<p>Review paragraph.</p><code>Code sample</code><form>Form text</form><aside>Sidebar text</aside>" +
          "<span data-private>Private text</span></div></article></div>",
      });
      const article = tab.doc.querySelector("article");
      const original = article.innerHTML;
      const link = article.querySelector("a");
      await waitRequest(tab);
      const groups = inputGroups(tab.requests[0]);
      const parts = groups.flatMap(group => group.parts);
      const expected = ["Story headline", "Opening", "source link", "continues.", "Next paragraph.", "Review paragraph."];
      assert(parts.length === expected.length && expected.every(part => parts.includes(part)), "Incorrect article text selected");
      assert(groups.some(({ parts }) => parts.slice(0, 3).join("|") === "Opening|source link|continues."),
        "Inline link lost its surrounding sentence");
      complete(tab.requests[0]);
      await until(() => link.textContent === "Translated text", "Inline article text did not render");
      assert(article.querySelector("a") === link && link.getAttribute("href") === "/news/source" &&
        article.querySelectorAll("br").length === 2, "Rendering damaged the inline markup");
      tab.menu(/^Show Original Text/);
      assert(article.innerHTML === original, "Original article text was not restored");
    }],
    ["Phoronix review index links are scoped to the publication", async () => {
      const other = "phoronix.com.example.test";
      const shared = storage([defaultKey, ["enabled-sites", ["phoronix.com", other]]]);
      const html = "<div id=main><a href='/review/one'>Review title</a><br>" +
        "<strong><a href='/review/two'>Featured review</a></strong></div>";
      const index = await open({ shared, host: "www.phoronix.com", path: "/reviews", html });
      await waitRequest(index);
      const parts = inputGroups(index.requests[0]).flatMap(group => group.parts);
      assert(parts.includes("Review title") && parts.includes("Featured review"), "Review index titles were skipped");
      const unrelated = await open({ shared, host: other, path: "/reviews", html });
      await noSend(unrelated, "Publication-specific selectors ran on another host");
      const account = await open({ shared, host: "www.phoronix.com", path: "/account", html });
      await noSend(account, "Publication-specific selectors bypassed route exclusions");
    }],
    ["Phoronix paginated reviews and news archives keep ordinary text blocks", async () => {
      const shared = storage([defaultKey, ["enabled-sites", ["phoronix.com"]]]);
      const review = await open({
        shared, host: "www.phoronix.com", path: "/review/example/2",
        html: "<div id=main><article class=full><h1>Benchmark results</h1><div class=content>" +
          "<p>The <em>second run</em> finished sooner.</p></div>" +
          "<select><option>Next page option</option></select></article></div>",
      });
      await waitRequest(review);
      const parts = inputGroups(review.requests[0]).flatMap(group => group.parts);
      assert(parts.join("|") === "Benchmark results|The|second run|finished sooner.",
        "Nested review paragraphs were duplicated, skipped or mixed with the page selector");
      const archive = await open({
        shared, host: "www.phoronix.com", path: "/news",
        html: "<div id=main><table><tr><td><a href='/news/example'>Archive headline</a></td></tr></table></div>",
      });
      await waitRequest(archive);
      assert(inputGroups(archive.requests[0])[0].parts[0] === "Archive headline", "Archive table link was skipped");
    }],
    ["Arch homepage translates the public menu and news and restores the original links", async () => {
      const tab = await open({
        host: "archlinux.org",
        html: "<div id=page><header><div id=archnavbar><ul id=archnavbarlist>" +
          "<li><a href='/packages/'>Packages</a></li></ul></div><nav><p>Account tools</p></nav></header>" +
          "<div id=news><h3>Latest news</h3><div class=article-content>Read the " +
          "<a href='/news/example/'>release notes</a> today.<p>More details follow.</p></div></div>" +
          "<div id=pkg-updates><h3>Recent updates</h3><table><tr><td class=pkg-name>example-tool 2.1</td>" +
          "<td class=pkg-arch>x86_64</td></tr></table></div></div>",
      });
      const page = tab.doc.querySelector("#page");
      const original = page.innerHTML;
      const link = page.querySelector("#archnavbar a");
      await noSend(tab, "Arch homepage sent text before opt-in");
      tab.menu(/^Enable on/);
      await waitRequest(tab);
      const groups = inputGroups(tab.requests[0]);
      const parts = groups.flatMap(group => group.parts);
      const expected = ["Packages", "Latest news", "Read the", "release notes", "today.", "More details follow.", "Recent updates"];
      assert(parts.length === expected.length && expected.every(part => parts.includes(part)), "Wrong homepage text selected");
      assert(groups.some(group => group.parts.join("|") === "Read the|release notes|today."), "Inline news link lost its context");
      complete(tab.requests[0]);
      await until(() => link.textContent === "Translated text", "Public Arch menu did not translate");
      tab.menu(/^Show Original Text/);
      assert(page.innerHTML === original && page.querySelector("#archnavbar a") === link, "Original homepage links were lost");
    }],
    ["Arch package details translate descriptions and keep package identifiers", async () => {
      const tab = await open({
        shared: storage([defaultKey, ["site-policy:archlinux.org", site(true)]]),
        host: "archlinux.org", path: "/packages/extra/any/example-tool/",
        html: "<div id=pkgdetails><h2>example-tool 2.1</h2><table id=pkginfo>" +
          "<tr><th>Description</th><td itemprop=description>A tool for reading manuals</td></tr>" +
          "<tr><th>Architecture</th><td>x86_64</td></tr></table><div id=pkgdeps><h3>Dependencies</h3>" +
          "<ul id=pkgdepslist><li><a href='/packages/core/any/example-lib/'>example-lib</a>" +
          "<span> (optional)</span></li></ul></div></div>",
      });
      await waitRequest(tab);
      const parts = inputGroups(tab.requests[0]).flatMap(group => group.parts);
      const expected = ["Description", "A tool for reading manuals", "Architecture", "Dependencies", "(optional)"];
      assert(parts.length === expected.length && expected.every(part => parts.includes(part)), "Wrong package fields selected");
    }],
    ["ArchWiki translates the table of contents and scrolled notices while preserving technical markup", async () => {
      const tab = await open({
        shared: storage([defaultKey, ["site-policy:wiki.archlinux.org", site(true)]]),
        host: "wiki.archlinux.org", path: "/title/Installation_guide",
        setup: doc => { doc.body.className = "mediawiki ns-0 action-view"; },
        html: "<div id=page><nav id=vector-toc><ul><li><a class=vector-toc-link href='#network'>" +
          "<div class=vector-toc-text><span class=vector-toc-numb>1</span>Network setup</div></a></li></ul></nav>" +
          "<main><header><h1 id=firstHeading>Installation guide</h1></header><div id=mw-content-text>" +
          "<div class=mw-parser-output><div class=mw-heading><h2 id=network>Connect the network" +
          "<span class=mw-editsection><a href='?action=edit'>Edit section</a></span></h2></div>" +
          "<p>Install the <span class=archwiki-template-pkg><a href='/pkg'>example-pkg</a></span> package.</p>" +
          "<div class='archwiki-template-box archwiki-template-box-tip' style='margin-top:750px'>" +
          "<strong>Tip</strong> Review the <a href='/title/Networking'>network settings</a> before continuing." +
          "<code>tool --verify</code><span class=archwiki-template-man><a href='/man'>tool(1)</a></span>" +
          "<span class=archwiki-template-aur><a href='/pkg'>example-git</a></span><pre>shell command</pre>" +
          "</div></div></div></main><p>Personal toolbar</p></div>",
      });
      const page = tab.doc.querySelector("#page");
      const original = page.innerHTML;
      const notice = page.querySelector(".archwiki-template-box");
      const link = notice.querySelector("a");
      await waitRequest(tab);
      const parts = inputGroups(tab.requests[0]).flatMap(group => group.parts);
      const expected = ["Network setup", "Installation guide", "Connect the network", "Install the", "package."];
      assert(parts.length === expected.length && expected.every(part => parts.includes(part)), "Wrong initial wiki text selected");
      complete(tab.requests[0]);
      await until(() => page.querySelector("#firstHeading").textContent === "Translated text", "Wiki title did not render");
      notice.scrollIntoView();
      await until(() => tab.requests.length === 2, "Scrolled wiki notice did not translate");
      const note = inputGroups(tab.requests[1]);
      assert(note.length === 1 && note[0].parts.join("|") === "Tip|Review the|network settings|before continuing.",
        "Notice lost inline context or included a command or manual reference");
      complete(tab.requests[1]);
      await until(() => link.textContent === "Translated text", "Wiki link did not render");
      tab.menu(/^Show Original Text/);
      assert(page.innerHTML === original && notice.querySelector("a") === link, "Original wiki markup was lost");
    }],
    ["Arch host matching uses a domain boundary and keeps subdomain consent separate", async () => {
      const lookalikes = ["notarchlinux.org", "archlinux.org.example.test"];
      const shared = storage([defaultKey, ["site-policy:archlinux.org", site(true)],
        ...lookalikes.map(host => ["site-policy:" + host, site(true)])]);
      const html = "<header><div id=archnavbar><ul id=archnavbarlist>" +
        "<li><a href='/packages/'>Packages</a></li></ul></div></header>";
      for (const host of ["wiki.archlinux.org", "bbs.archlinux.org"]) {
        const tab = await open({ shared, host, html, setup: doc => { doc.body.className = "mediawiki ns-0 action-view"; } });
        await noSend(tab, "Arch homepage opt-in enabled " + host);
        tab.menu(/^Enable on/);
        await waitRequest(tab);
        assert(inputGroups(tab.requests[0])[0].parts[0] === "Packages", "Shared Arch menu missing on " + host);
      }
      for (const host of lookalikes) {
        const tab = await open({ shared, host, html: html + "<p>Ordinary prose</p>" });
        await waitRequest(tab);
        assert(inputGroups(tab.requests[0]).flatMap(group => group.parts).join("|") === "Ordinary prose",
          "Arch-specific rules applied to " + host);
      }
    }],
    ["ArchWiki edit, preview, special and challenge pages do not send text", async () => {
      const shared = storage([defaultKey, ["site-policy:wiki.archlinux.org", site(true)]]);
      for (const [path, classes] of [
        ["/title/Example?veaction=edit", "mediawiki ns-0 action-view"],
        ["/index.php?title=Example&action=submit", "mediawiki ns-0 action-view"],
        ["/title/Special:Watchlist", "mediawiki ns-0 action-view"],
        ["/index.php?title=Special%3AWatchlist", "mediawiki ns-0 action-view"],
        ["/", "mediawiki ns-special action-view"],
        ["/", ""],
      ]) {
        const tab = await open({ shared, host: "wiki.archlinux.org", path, html: "<h1 id=firstHeading>Private fixture</h1>",
          setup: doc => { doc.body.className = classes; } });
        await noSend(tab, "A protected wiki view sent text on " + path);
        assert(tab.watches.size === 0, "A protected wiki view started observation on " + path);
      }
    }],
    ["Amazon Japan homepage translates visible shopping cards after opt-in and restores links", async () => {
      const tab = await open({ host: "www.amazon.co.jp", path: "/ref=nav_logo",
        html: "<div id=store><header><p>個人のお届け先</p></header><div id=gwm-Deck>" +
          "<div data-card-metrics-id='single-creative-card_gateway_0'><div class=a-cardui-header>" +
          "<h3><span class=wdTitle>季節の特集</span></h3><span class=wdSubTitle>注目のアイテム</span></div></div>" +
          "<div data-card-metrics-id='multi-category-card_gateway_1'><a href='/b?node=123'>" +
          "<span class=a-truncate><span class=a-truncate-full>文房具</span>" +
          "<span class=aok-offscreen>読み上げ用の複製</span></span></a></div>" +
          "<div data-card-metrics-id='your-orders_gateway_2'><div class=a-cardui-header><h2>個人の注文履歴</h2></div></div>" +
          "<span class=a-price>価格は三千円</span></div></div>" });
      const store = tab.doc.querySelector("#store");
      const original = store.innerHTML;
      const link = store.querySelector("a");
      await noSend(tab, "Amazon sent text before site opt-in");
      tab.menu(/^Enable on/);
      await waitRequest(tab);
      const parts = inputGroups(tab.requests[0]).flatMap(group => group.parts);
      assert(parts.join("|") === "季節の特集|注目のアイテム|文房具", "Wrong Amazon homepage text selected");
      complete(tab.requests[0]);
      await until(() => link.querySelector(".a-truncate-full").textContent === "Translated text", "Category label did not render");
      tab.menu(/^Show Original Text/);
      assert(store.innerHTML === original && store.querySelector("a") === link, "Original Amazon homepage markup was lost");
    }],
    ["Amazon Japan sale cards stop translating if the page replaces a promotion with a personal card", async () => {
      const tab = await open({ shared: storage([defaultKey, ["site-policy:amazon.co.jp", site(true)]]),
        host: "www.amazon.co.jp", path: "/blackfriday/7/",
        html: "<div id=sale data-card-metrics-id='pcpo-offer_deals-events-atf-desktop_16'>" +
          "<a href='/b' class=a-link-normal><div aria-label='生活家電'><div aria-hidden=true>" +
          "<span class=a-truncate><span class=a-truncate-full>生活家電</span><span aria-hidden=true>複製</span></span>" +
          "</div></div></a><span class=a-price>参考価格二千円</span></div><div id=inactive aria-hidden=true></div>",
        setup: doc => {
          const copy = doc.querySelector("#sale").cloneNode(true);
          copy.removeAttribute("id");
          doc.querySelector("#inactive").append(copy);
        },
      });
      await waitRequest(tab);
      assert(inputGroups(tab.requests[0]).flatMap(group => group.parts).join("|") === "生活家電", "Wrong sale text selected");
      tab.doc.querySelector("#sale").setAttribute("data-card-metrics-id", "your-orders_gateway_0");
      await until(() => tab.requests[0].aborted, "Changing the card to a personal widget left its request active");
      tab.doc.querySelector(".a-truncate-full").textContent = "購入履歴";
      await sleep(300);
      assert(tab.requests.length === 1, "A personal card was queued after replacing a sale promotion");
    }],
    ["Amazon Japan search translates result titles as cards enter the viewport or acquire their marker", async () => {
      const tab = await open({ shared: storage([defaultKey, ["site-policy:amazon.co.jp", site(true)]]),
        host: "amazon.co.jp", path: "/-/en/s?k=private-query",
        html: "<h2>Search results for private-query</h2><div data-component-type='s-search-result' data-asin='B000000001'>" +
          "<a href='/dp/B000000001'><h2><span>最初のノート</span></h2></a><span class=a-price>千円</span></div>" +
          "<div id=next style='margin-top:800px'><h2><a href='/dp/B000000002'>次のノート</a></h2></div>" });
      await waitRequest(tab);
      assert(inputGroups(tab.requests[0]).flatMap(group => group.parts).join("|") === "最初のノート",
        "A search term, ASIN, price or offscreen result was sent");
      complete(tab.requests[0]);
      const next = tab.doc.querySelector("#next");
      next.scrollIntoView();
      await sleep(300);
      assert(tab.requests.length === 1, "Unmarked search result was sent");
      next.setAttribute("data-component-type", "s-search-result");
      await until(() => tab.requests.length === 2, "A search result added during scrolling was missed");
      assert(inputGroups(tab.requests[1]).flatMap(group => group.parts).join("|") === "次のノート", "Wrong second search result");
    }],
    ["Amazon Japan product descriptions, features and public reviews keep inline markup and omit purchase details", async () => {
      const shared = storage([defaultKey, ["site-policy:amazon.co.jp", site(true)]]);
      const tab = await open({ shared, host: "www.amazon.co.jp", path: "/鉛筆/dp/B000000001/ref=sr_1_1",
        html: "<main><h1><span id=productTitle>木の鉛筆</span></h1><div id=feature-bullets><ul><li>書きやすい</li></ul></div>" +
          "<div id=productDescription>毎日 <a href='/b'>学校で</a> 使えます。" +
          "<span class=a-price>五百円</span><span itemprop=price>千円</span></div>" +
          "<div id=productFactsDesktopExpander><h3 class=product-facts-title>商品の特徴</h3><ul><li>軽くて丈夫</li></ul></div>" +
          "<div id=aplus><p>メーカーの説明</p></div><div id=buybox><p>配送先と購入者</p></div>" +
          "<table id=productDetails_detailBullets_sections1><tr><th>ASIN</th><td>B000000001</td></tr></table></main>" });
      const main = tab.doc.querySelector("main");
      const original = main.innerHTML;
      const link = main.querySelector("a");
      await waitRequest(tab);
      const groups = inputGroups(tab.requests[0]);
      const parts = groups.flatMap(group => group.parts);
      const expected = ["木の鉛筆", "書きやすい", "毎日", "学校で", "使えます。", "商品の特徴", "軽くて丈夫", "メーカーの説明"];
      assert(parts.length === expected.length && expected.every(part => parts.includes(part)), "Wrong product fields selected");
      assert(groups.some(group => group.parts.join("|") === "毎日|学校で|使えます。"), "Inline product link lost its context");
      complete(tab.requests[0]);
      await until(() => link.textContent === "Translated text", "Inline product description did not render");
      tab.menu(/^Show Original Text/);
      assert(main.innerHTML === original && main.querySelector("a") === link, "Original product markup was lost");
      const reviews = await open({ shared, host: "www.amazon.co.jp", path: "/product-reviews/B000000001",
        html: "<div data-hook=review><span class=a-profile-name>レビュアーの名前</span>" +
          "<a data-hook=review-title><i><span class=a-icon-alt>星四つ</span></i><span>使いやすい</span></a>" +
          "<div data-hook=review-body>毎日使っています。</div></div><form><p>未公開のレビュー</p></form>" });
      await waitRequest(reviews);
      assert(inputGroups(reviews.requests[0]).flatMap(group => group.parts).join("|") === "使いやすい|毎日使っています。",
        "Wrong review text selected");
    }],
    ["Amazon Japan private routes stop translation, and other hosts keep their own rules", async () => {
      const other = "amazon.co.jp.example.test";
      const shared = storage([defaultKey, ["site-policy:amazon.co.jp", site(true)], ["site-policy:" + other, site(true)]]);
      const html = "<span id=productTitle>商品タイトル</span><p>Ordinary prose</p>";
      const options = { shared, host: "www.amazon.co.jp", html };
      const tab = await open({ ...options, path: "/gp/aw/d/B000000001" });
      await waitRequest(tab);
      tab.navigate("/gp/your-account/order-history");
      await until(() => tab.requests[0].aborted && tab.watches.size === 0, "Opening orders left the product request active");
      for (const path of ["/gp/css/homepage.html", "/gp/cart/view.html", "/gp/buy/spc/handlers/display.html",
        "/a/addresses", "/hz/wishlist/ls/fixture", "/ap/signin", "/review/create-review"]) {
        const privatePage = await open({ ...options, path });
        await noSend(privatePage, "Amazon sent text from " + path);
        assert(privatePage.watches.size === 0, "Amazon observed " + path);
      }
      const unrelated = await open({ shared, host: other, path: "/dp/B000000001", html });
      await waitRequest(unrelated);
      assert(inputGroups(unrelated.requests[0]).flatMap(group => group.parts).join("|") === "Ordinary prose",
        "Amazon-specific selectors reached an unrelated host");
    }],
    ["existing elements can become translation targets after insertion", async () => {
      const shared = storage([defaultKey, ["enabled-sites", ["example.test", "phoronix.com"]]]);
      const generic = await open({ shared, html: "<div>Late heading</div>" });
      await noSend(generic, "A plain div was collected before becoming a heading");
      generic.doc.querySelector("div").setAttribute("role", "heading");
      await waitRequest(generic);
      const news = await open({
        shared, host: "www.phoronix.com", path: "/news/example",
        html: "<div id=main><article><div class=content>Late article body</div></article></div>",
      });
      await noSend(news, "An unclassified article container was collected");
      news.doc.querySelector("article").className = "full";
      await waitRequest(news);
    }],
    ["changing an eligible region to an editor cancels its translation", async () => {
      const tab = await open({ shared: storage([defaultKey, ["enabled-sites", ["example.test"]]]) });
      await waitRequest(tab);
      const paragraph = tab.doc.querySelector("p");
      paragraph.contentEditable = "true";
      await until(() => tab.requests[0].aborted, "A request stayed active after editing began");
      paragraph.textContent = "Draft text";
      await sleep(300);
      assert(tab.requests.length === 1 && paragraph.textContent === "Draft text", "The editor was translated");
      paragraph.textContent = "Published text";
      paragraph.contentEditable = "false";
      await until(() => tab.requests.length === 2, "Translation did not resume after editing");
      assert(inputGroups(tab.requests[1])[0].parts[0] === "Published text", "A draft was queued for later");
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
    ["saving a stale settings dialog preserves a newer translation endpoint", async () => {
      const initial = { provider: "custom", customBaseUrl: "https://first.test/v1", model: "fixture" };
      const shared = storage([["settings", initial]]);
      const tab = await open({ shared });
      let settingsRoot;
      const prototype = tab.win.Element.prototype;
      const attachShadow = prototype.attachShadow;
      prototype.attachShadow = function (options) {
        settingsRoot = attachShadow.call(this, options);
        return settingsRoot;
      };
      try { tab.menu(/^Translator Settings$/); } finally { prototype.attachShadow = attachShadow; }
      const form = settingsRoot.querySelector("form");
      const latest = { ...initial, customBaseUrl: "https://second.test/v1" };
      shared.write("settings", latest);
      form.requestSubmit();
      assert(shared.values.get("settings").customBaseUrl === latest.customBaseUrl,
        "A stale dialog restored the previous endpoint for all sites");
      assert(settingsRoot.querySelector("dialog").open && form.textContent.includes("another tab"),
        "The dialog did not explain the settings conflict");
    }],
    ["cache expiry, opt-in and generation reset", async () => {
      const contextlessKey = "translation:v2:" + "2".repeat(64);
      const expiredKey = "translation:v3:" + "3".repeat(64);
      const shared = storage([
        defaultKey, ["enabled-sites", ["example.test"]],
        ["translation-cache-policy", { persistent: true, generation }],
        [oldCacheKey, { text: "Legacy cached text", savedAt: Date.now() }],
        [contextlessKey, { text: "Fresh but contextless", savedAt: Date.now(), generation }],
        [expiredKey, { output: ["Expired text"], savedAt: Date.now() - 86400001, generation }],
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
    ["persistent translations distinguish sentences and reuse matching context across tabs", async () => {
      const shared = storage([defaultKey, ["enabled-sites", ["example.test"]],
        ["translation-cache-policy", { persistent: true, generation }]]);
      const source = "<p>Admission is <em>free</em> today.</p>";
      const first = await open({ shared, html: source });
      await waitRequest(first);
      complete(first.requests[0], part => part === "free" ? "무료" : "번역");
      await until(() => first.doc.querySelector("em").textContent === "무료", "First translation did not render");
      const second = await open({ shared, html: "<p>Please <em>free</em> the memory.</p>" });
      await waitRequest(second);
      assert(inputGroups(second.requests[0])[0].parts.join("|") === "Please|free|the memory.",
        "A different sentence reused a word from the first translation");
      complete(second.requests[0], part => part === "free" ? "해제" : "번역");
      await until(() => second.doc.querySelector("em").textContent === "해제", "Second meaning did not render");
      const revisit = await open({ shared, html: source });
      await until(() => revisit.doc.querySelector("em").textContent === "무료", "Matching sentence missed the disk cache");
      assert(revisit.requests.length === 0, "Identical context sent a new request");
    }],
    ["persistent translations preserve repeated pieces by their position", async () => {
      const shared = storage([defaultKey, ["enabled-sites", ["example.test"]],
        ["translation-cache-policy", { persistent: true, generation }]]);
      const html = "<p><b>free</b> the space to stay <em>free</em>.</p>";
      const first = await open({ shared, html });
      await waitRequest(first);
      assert(inputGroups(first.requests[0])[0].parts.join("|") === "free|the space to stay|free", "Unexpected grouping");
      complete(first.requests[0], (_part, index) => ["해제", "중간", "여유"][index]);
      await until(() => first.doc.querySelector("em").textContent === "여유", "Initial positions did not render");
      const revisit = await open({ shared, html });
      await until(() => revisit.doc.querySelector("b").textContent === "해제", "Cached group did not render");
      assert(revisit.doc.querySelector("em").textContent === "여유" && revisit.requests.length === 0,
        "Identical words at different positions shared one disk value");
      const [key] = diskKeys(shared.values);
      shared.write(key, { ...shared.values.get(key), output: ["해제"] });
      const incomplete = await open({ shared, html });
      await waitRequest(incomplete);
      assert(inputGroups(incomplete.requests[0])[0].parts.length === 3, "A partial cache entry split the request context");
    }],
    ["an in-flight edit stores only the updated sentence under its own key", async () => {
      const shared = storage([defaultKey, ["enabled-sites", ["example.test"]],
        ["translation-cache-policy", { persistent: true, generation }]]);
      const html = "<p><em>free</em> admission today</p>";
      const tab = await open({ shared, html });
      await waitRequest(tab);
      tab.doc.querySelector("p").lastChild.data = " the buffer";
      await until(() => tab.requests.length === 2, "Changed sentence was not requested again");
      assert(tab.requests[0].aborted, "Obsolete sentence request stayed active");
      complete(tab.requests[1], part => part === "free" ? "해제" : "번역");
      await until(() => tab.doc.querySelector("em").textContent === "해제", "Changed sentence did not render");
      const revisit = await open({ shared, html });
      await waitRequest(revisit);
      assert(inputGroups(revisit.requests[0])[0].parts.join("|") === "free|admission today",
        "An edited sentence wrote to the previous context's disk key");
    }],
    ...["Tampermonkey", "Violentmonkey"].map(scriptHandler =>
      [scriptHandler + " honors delay-seconds and HTTP-date Retry-After", async () => {
        for (const useDate of [false, true]) {
          const tab = await open({ scriptHandler, shared: storage([defaultKey, ["enabled-sites", ["example.test"]]]) });
          await waitRequest(tab);
          const clock = freezeTime(tab.win);
          rateLimit(tab.requests[0], useDate ? new Date(clock.now + 600_000).toUTCString() : "600");
          await sleep(0);
          clock.advance(120_000);
          assert(tab.requests.length === 1, "Retried at the old two-minute cap");
          tab.navigate("/next-article");
          await until(() => clock.scheduledAt(clock.now + 480_000), "Navigation lost the provider deadline");
          clock.advance(479_999);
          assert(tab.requests.length === 1, "Retried before the provider deadline after navigation");
          clock.advance(1);
          await until(() => tab.requests.length === 2, "Did not retry when the provider deadline arrived");
          complete(tab.requests[1]);
        }
      }]),
    ["switching providers preserves each translation endpoint's deadline", async () => {
      const shared = storage([defaultKey, ["enabled-sites", ["example.test"]]]);
      const tab = await open({ shared });
      await waitRequest(tab);
      const clock = freezeTime(tab.win);
      const deadline = clock.now + 600_000;
      rateLimit(tab.requests[0], "600");
      await until(() => clock.scheduledAt(deadline), "Provider cooldown was not scheduled");
      shared.write("settings", { provider: "custom", customBaseUrl: "https://other.test/v1", model: "fixture" });
      await until(() => {
        clock.advance(200);
        return tab.requests.length === 2;
      }, "A different endpoint inherited the first provider's cooldown");
      assert(tab.requests[1].details.url === "https://other.test/v1/chat/completions", "Wrong endpoint was called");
      shared.write("settings", { provider: "openai" });
      await until(() => clock.scheduledAt(deadline), "Returning to the first provider lost its deadline");
      clock.advance(deadline - clock.now - 1);
      assert(tab.requests.length === 2, "Returning to the first provider retried early");
      clock.advance(1);
      await until(() => tab.requests.length === 3, "First provider did not resume after the deadline");
    }],
    ["429 falls back on invalid or missing headers and handles very long delays", async () => {
      const longSeconds = 3_000_000;
      for (const [header, wait] of [[null, 15_000], ["600oops", 15_000], ["2", 2000], [String(longSeconds), longSeconds * 1000]]) {
        const tab = await open({ shared: storage([defaultKey, ["enabled-sites", ["example.test"]]]) });
        await waitRequest(tab);
        const clock = freezeTime(tab.win);
        const deadline = clock.now + wait;
        rateLimit(tab.requests[0], header);
        await sleep(0);
        if (wait > 2 ** 31 - 1) clock.advance(2 ** 31 - 1);
        clock.advance(deadline - clock.now - 1);
        assert(tab.requests.length === 1, "Invalid header or timer overflow caused an early retry");
        clock.advance(1);
        await until(() => tab.requests.length === 2, "Retry did not follow its expected wait");
      }
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
