# Viewport Translator

[한국어](#한국어)

Translate text in place as you scroll. Viewport Translator uses the LLM API you configure and starts with translation disabled on every site. It handles common page elements and has dedicated rules for Reddit, 4chan, Bilibili and Linux.do.

## Install and use

1. Install the latest [Tampermonkey](https://www.tampermonkey.net/) and [install the userscript from Greasy Fork](https://greasyfork.org/en/scripts/606658-visible-text-translator).
2. Open **Translator Settings** from Tampermonkey's menu. Choose a target language, provider and model. Use **Set API Key…** when your provider requires a key. Enter it in the browser prompt, which displays the input as you type.
3. Check **Enable auto-translate on this site** and save. Use **Alt+Shift+T** to turn site translation on or off and **Alt+T** to switch between original and translated text. Showing the original stops new requests and cancels work in progress until you switch back.

Firefox users can also use the current version of [Violentmonkey](https://addons.mozilla.org/en-US/firefox/addon/violentmonkey/). This requires Firefox's privileged content-script networking. On Chromium, use Tampermonkey.

The interface follows your browser's language preferences, with English as the fallback. Settings also offer English, Korean, Japanese, Simplified Chinese and Traditional Chinese. The target language is a separate setting.

Use Tampermonkey with [Firefox for Android](https://addons.mozilla.org/android/addon/tampermonkey/) or [Safari on iPhone and iPad](https://www.tampermonkey.net/index.php?browser=safari&locale=en). On mobile, use its menu to open settings, turn translation on or off, and switch between original and translated text.

## Privacy controls

- **Always block this site** persists until you change it in settings. It overrides site consent and shortcuts. **Allow only these paths** and **Block these paths** accept one path per line, such as `/docs` or `/docs/members`. Each rule covers that path and its subpaths. Leave the allow list empty to cover the site. Block rules also match case variants. On hash-routed pages, the allow list uses the fragment path, and either path can trigger a block.
- On standard HTTPS ports, site consent and path rules retain the existing site groups, including bare and `www` hostnames, the desktop Reddit aliases, and the 4chan board aliases. HTTP and non-default ports require a separate opt-in for their origin. The permanent block covers the site group across ports and schemes. Mobile Reddit and Bilibili keep their separate site settings.
- Before observing, collecting or sending text, the script checks the current consent, route and local privacy signals. It skips recognized account, authentication, payment, chat and message pages, private DOM regions, forms and credential-like text. It skips marked Reddit posts and waits for matching post metadata on Reddit thread pages, including for comments. On 4chan, it uses a local list of known worksafe boards and skips cross-board quote previews. These checks make no classification requests. [Reddit post metadata](https://developers.reddit.com/docs/api/redditapi/models/classes/Post) · [4chan board categories](https://4chan.org/)
- **Use persistent translation cache** is off by default, including after updating from v0.5.3. While it is off, the active tab can reuse translations in memory. With persistence on, translations are stored by the userscript manager for up to 24 hours of reuse. Cleanup deletes expired and superseded entries during startup and regular maintenance. It runs while the script is loaded. A browser without secure hashing, such as on most plain HTTP pages, uses the tab cache. **Clear all translation caches** drops current cached data across tabs while leaving the cache preference intact. Turning persistence off also clears cached data. Later translations can create new entries when caching is enabled.
- The script requires the userscript manager to report a non-private tab before it starts. Tampermonkey also excludes Firefox containers when applying its normal-tabs rule. Private-mode detection depends on the browser and manager reporting tab state accurately. [Tampermonkey tab scope](https://www.tampermonkey.net/documentation.php?q=run_in) · [Violentmonkey tab information](https://violentmonkey.github.io/api/gm/#gm_info)

## Providers and transmission

- Built-in providers are OpenAI, Anthropic, Gemini, xAI and DeepSeek. For OpenAI-compatible services, choose **Custom**, enter the API base URL (for example `https://openrouter.ai/api/v1` or `http://localhost:11434/v1`), and use **Refresh Models** or enter a model ID. Remote endpoints require HTTPS. Plain HTTP is limited to `localhost`, `127.0.0.1` and `[::1]`. A custom API key is optional and is sent only to its configured base URL. If you installed v0.4.0 and used a custom key, enter it again after updating.
- A translation request contains selected visible text segments, translation instructions and model parameters. A segment can include nearby text outside the viewport. Page URLs, browsing history, input values and site credentials are never added as request fields or headers. Tampermonkey's background requests and Violentmonkey's privileged Firefox requests both omit cookies and block redirects. Model-catalog requests contain no page text. OpenAI, Gemini and xAI requests retain `store: false`. Your chosen provider's billing and retention policies apply. [Tampermonkey request behavior](https://www.tampermonkey.net/documentation.php?q=GM_xmlhttpRequest) · [Firefox privileged request behavior](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts#xhr_and_fetch)
- API keys are stored by the userscript manager. The browser prompt keeps key entry out of the page DOM. Translation requires a browser and manager combination that can block redirects. The broad site match supports per-site opt-in, and the broad connection permission is used for custom endpoints.

Local signals cannot identify all unlabeled private or adult content on an enabled page. If a SPA keeps the old text when leaving a protected route, the script skips those existing text nodes until the page replaces them. A reload can also restore translation on the public route. Cross-tab cancellation depends on the userscript manager delivering storage changes. The script also checks the latest locally visible values before sending. Canceling a request cannot recall data the endpoint has already received.

## Regression tests

Run `node --test tests/privacy.test.cjs` with Firefox and Node.js installed. The suite uses real browser DOM, layout and navigation with mock userscript storage and outbound requests. It calls no provider API.

Report bugs through [GitHub Issues](https://github.com/nobadwordss/viewport-translator/issues) with the site, browser, userscript manager and provider. Leave API keys and private page text out of reports.

## 한국어

Viewport Translator는 스크롤하면서 화면에 들어온 텍스트를 웹페이지에서 바로 번역합니다. 일반 웹페이지에 적용할 수 있고, Reddit·4chan·Bilibili·Linux.do에는 전용 규칙을 사용합니다. 처음에는 모든 사이트에서 번역이 꺼져 있습니다.

1. 최신 [Tampermonkey](https://www.tampermonkey.net/)를 설치한 뒤 [Greasy Fork에서 유저스크립트를 설치](https://greasyfork.org/ko/scripts/606658-visible-text-translator)합니다.
2. Tampermonkey 메뉴에서 **화면 번역 설정**을 열고 번역 언어, 제공자, 모델을 선택합니다. 키가 필요한 제공자는 **API 키 설정…**을 눌러 브라우저 대화상자에 입력합니다. 입력하는 키는 대화상자에 표시됩니다.
3. **이 사이트에서 자동 번역 켜기**를 선택하고 저장합니다. **Alt+Shift+T**로 사이트 번역을 켜거나 끄고, **Alt+T**로 원문과 번역문을 전환합니다. 원문 보기 중에는 새 요청을 보내지 않고 진행 중이던 번역을 취소합니다.

Firefox에서는 권한이 있는 콘텐츠 스크립트로 요청을 보낼 수 있는 최신 [Violentmonkey](https://addons.mozilla.org/ko/firefox/addon/violentmonkey/)도 사용할 수 있습니다. Chromium 계열에서는 Tampermonkey를 사용하세요.

설정 화면의 언어는 브라우저 설정을 따르며, 지원하지 않는 언어는 영어로 표시합니다. 설정에서 영어, 한국어, 일본어, 중국어 간체·번체 중 하나를 직접 고를 수도 있습니다. 모바일에서는 [Android용 Firefox](https://addons.mozilla.org/android/addon/tampermonkey/) 또는 [iPhone·iPad용 Safari](https://www.tampermonkey.net/index.php?browser=safari&locale=en)의 Tampermonkey 메뉴에서 설정, 사이트 번역, 원문·번역문 전환을 이용합니다.

### 개인정보 보호 설정

- **이 사이트 항상 차단**은 설정에서 해제할 때까지 유지되며 사이트 허용과 단축키보다 우선합니다. **다음 경로만 허용**과 **다음 경로 차단**에는 `/docs`, `/docs/members`처럼 한 줄에 경로 하나를 입력합니다. 하위 경로에도 적용하며, 허용 목록이 비어 있으면 사이트 전체가 대상입니다. 차단 규칙은 대소문자가 달라도 적용됩니다. 해시 기반 페이지에서는 해시 경로에 허용 규칙을 적용하고, 두 경로 중 하나라도 차단 규칙과 일치하면 번역을 막습니다.
- 기본 HTTPS 포트의 사이트 허용과 경로 규칙은 기존 사이트 범위를 따릅니다. 기본 호스트와 `www`, 데스크톱 Reddit의 별칭, 4chan 게시판의 별칭이 각각 같은 설정을 공유합니다. HTTP 및 기본값과 다른 포트는 주소별로 따로 허용해야 합니다. 영구 차단은 포트와 프로토콜에 관계없이 사이트 범위 전체에 적용됩니다. 모바일 Reddit과 Bilibili 설정은 각각 독립적입니다.
- DOM 감시, 텍스트 수집, 요청 전송 전에 현재 허용 상태, 경로, 로컬 개인정보 보호 신호를 확인합니다. 감지한 계정, 로그인, 결제, 채팅, 메시지 화면과 비공개 DOM 영역, 양식, 인증 정보로 보이는 텍스트를 건너뜁니다. Reddit에서는 표시된 NSFW 게시물을 제외하며, 게시물 상세 화면에서는 주소와 일치하는 게시물의 메타데이터를 확인한 뒤 댓글도 번역합니다. 4chan에서는 로컬 목록의 worksafe 게시판만 대상으로 삼고 인용 미리보기를 제외합니다. 분류에 외부 요청을 사용하지 않습니다. [Reddit 게시물 메타데이터](https://developers.reddit.com/docs/api/redditapi/models/classes/Post) · [4chan 게시판 분류](https://4chan.org/)
- **번역 캐시를 영구 저장**은 기본적으로 꺼져 있으며 v0.5.3에서 업데이트한 경우에도 같습니다. 꺼져 있으면 현재 탭의 메모리에서만 번역을 재사용합니다. 켜면 유저스크립트 관리자에 저장하고 최대 24시간 동안 재사용합니다. 유저스크립트가 실행될 때 시작 시점과 주기적인 정리 과정에서 만료되거나 이전 세대에 속한 항목을 실제로 삭제합니다. 대부분의 일반 HTTP 페이지처럼 보안 해시를 사용할 수 없으면 탭 메모리만 사용합니다. **전체 번역 캐시 삭제**로 탭 메모리와 영구 캐시를 비울 수 있습니다. 영구 저장을 끌 때도 캐시를 비웁니다. 이후 영구 저장이 켜져 있으면 새 번역을 저장할 수 있습니다.
- 유저스크립트 관리자가 비공개 탭이 아니라고 확인한 환경에서만 실행합니다. Tampermonkey의 일반 탭 규칙이 적용되면 Firefox 컨테이너 탭도 제외됩니다. 시크릿 모드 감지는 브라우저와 유저스크립트 관리자가 탭 상태를 정확하게 전달하는지에 의존합니다. [Tampermonkey 탭 범위](https://www.tampermonkey.net/documentation.php?q=run_in) · [Violentmonkey 탭 정보](https://violentmonkey.github.io/api/gm/#gm_info)

### API 제공자와 전송 데이터

- OpenAI, Anthropic, Gemini, xAI, DeepSeek를 기본 지원합니다. OpenAI 호환 API를 사용하려면 **Custom**을 선택하고 Base URL과 모델 ID를 입력합니다. **모델 목록 새로고침**으로 모델을 조회할 수도 있습니다. 원격 API에는 HTTPS가 필요하며, HTTP는 `localhost`, `127.0.0.1`, `[::1]`에서만 사용할 수 있습니다. 커스텀 키는 선택 사항이며 입력한 Base URL에만 전송됩니다. v0.4.0에서 커스텀 API 키를 사용했다면 업데이트 후 다시 입력합니다.
- 번역 요청에는 화면에 들어온 텍스트 구간과 번역 지시문, 모델 설정이 포함됩니다. 한 구간에 화면 밖의 인접 텍스트가 포함될 수 있습니다. 페이지 URL, 방문 기록, 입력값, 사이트 인증 정보는 별도 요청 필드나 헤더로 추가하지 않습니다. Tampermonkey의 백그라운드 요청과 Firefox에서 Violentmonkey로 보내는 요청 모두 쿠키를 제외하고 리디렉션을 차단합니다. 모델 목록을 조회할 때는 페이지 텍스트를 포함하지 않습니다. OpenAI, Gemini, xAI 요청은 `store: false`를 유지하며 요금과 데이터 보관 정책은 제공자에 따라 달라집니다. [Tampermonkey 요청 동작](https://www.tampermonkey.net/documentation.php?q=GM_xmlhttpRequest) · [Firefox의 권한 있는 요청](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts#xhr_and_fetch)
- API 키는 유저스크립트 관리자에 저장되며 키 입력은 페이지 바깥의 브라우저 대화상자에서 처리합니다. 리디렉션을 차단할 수 있는 브라우저와 관리자 조합에서 번역 요청을 보냅니다. 넓은 사이트 권한은 사이트별 허용을 지원하며, 외부 호스트 연결 권한은 사용자가 설정한 커스텀 API에 사용합니다.

로컬 URL과 DOM 신호로는 번역을 허용한 페이지에서 별도 표시 없이 나타나는 비공개·성인 콘텐츠를 모두 판별할 수 없습니다. SPA가 보호된 경로를 벗어난 직후 이전 화면의 텍스트를 유지하면 해당 텍스트는 페이지가 교체할 때까지 건너뜁니다. 공개 화면을 새로고침해 번역을 다시 시작할 수도 있습니다. 다른 탭의 변경은 유저스크립트 관리자가 전달하며, 전송 직전에도 현재 탭에서 확인 가능한 최신 값을 검사합니다. 요청을 취소해도 엔드포인트가 이미 받은 데이터는 회수할 수 없습니다.

### 회귀 테스트

Firefox와 Node.js가 설치된 환경에서 `node --test tests/privacy.test.cjs`를 실행합니다. 실제 브라우저의 DOM, 레이아웃, 경로 이동을 사용하며 유저스크립트 저장소와 API 요청을 모의 처리합니다. 제공자 API에는 연결하지 않습니다.

버그는 [GitHub Issues](https://github.com/nobadwordss/viewport-translator/issues)에 사이트, 브라우저, 유저스크립트 관리자, API 제공자와 함께 알려 주세요. API 키나 비공개 페이지 내용은 포함하지 마세요.

## License

[MIT](LICENSE)
