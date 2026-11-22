# Viewport Translator

[한국어](#한국어)

Translate text in place as you scroll. Viewport Translator uses the LLM API you configure and starts with translation disabled on every site. It handles common page elements and has dedicated rules for Reddit, 4chan and Bilibili.

## Install and use

1. Install the latest [Tampermonkey](https://www.tampermonkey.net/) and [install the userscript from Greasy Fork](https://greasyfork.org/en/scripts/606658-visible-text-translator).
2. Open **Translator Settings** from Tampermonkey's menu. Choose a target language, provider and model. Enter the provider's API key if required.
3. Check **Enable auto-translate on this site** and save. Use **Alt+Shift+T** to turn site translation on or off and **Alt+T** to switch between the original and translated text. Showing the original pauses new translation requests while that view is active.

The interface follows your browser's language preferences, with English as the fallback. You can also select English, Korean, Japanese, Simplified Chinese or Traditional Chinese in settings. The target language is a separate setting.

## Providers and privacy

- Built-in providers are OpenAI, Anthropic, Gemini, xAI and DeepSeek. For OpenAI-compatible services, choose **Custom**, enter the API base URL (for example `https://openrouter.ai/api/v1` or `http://localhost:11434/v1`), and use **Refresh Models** or enter a model ID. HTTP is limited to loopback addresses. A custom API key is optional and tied to its base URL. If you installed v0.4.0 and used a custom API key, enter it again after updating.
- Page text segments that intersect the viewport are sent to the configured API. A segment may include nearby text outside the viewport. Provider, model and language settings apply to every enabled site. Your provider's data retention and billing policies apply.
- API keys and the translation cache are stored by the userscript manager. Cached translations expire after 24 hours. Plain HTTP pages may only have a temporary cache for the current tab. The script matches ordinary web pages so you can enable it on any supported site. Arbitrary outbound host permission supports the custom endpoint you configure.

Report bugs through [GitHub Issues](https://github.com/nobadwordss/viewport-translator/issues) with the site, browser, userscript manager and provider. Leave API keys and private page text out of reports.

## 한국어

Viewport Translator는 스크롤하면서 화면에 들어온 텍스트를 웹페이지에서 바로 번역합니다. 일반 웹페이지에 적용할 수 있고, Reddit·4chan·Bilibili에는 전용 규칙을 사용합니다. 처음에는 모든 사이트에서 번역이 꺼져 있습니다.

1. 최신 [Tampermonkey](https://www.tampermonkey.net/)를 설치한 뒤 [Greasy Fork에서 유저스크립트를 설치](https://greasyfork.org/ko/scripts/606658-visible-text-translator)합니다.
2. Tampermonkey 메뉴에서 **화면 번역 설정**을 열고 번역 대상 언어, API 제공자, 모델을 선택합니다. 제공자가 요구하는 경우 API 키를 입력합니다.
3. **이 사이트에서 자동 번역 켜기**를 선택하고 저장합니다. **Alt+Shift+T**로 사이트 번역을 켜거나 끄고, **Alt+T**로 원문과 번역문을 전환합니다. 원문을 보는 동안에는 새 번역 요청이 일시 정지됩니다.

설정 화면의 언어는 브라우저 설정을 따르며, 지원하지 않는 언어는 영어로 표시합니다. 설정에서 영어, 한국어, 일본어, 중국어 간체·번체 중 하나를 직접 고를 수도 있습니다.

- OpenAI, Anthropic, Gemini, xAI, DeepSeek를 기본 지원합니다. OpenAI 호환 API를 사용하려면 **Custom**을 선택하고 Base URL과 모델 ID를 입력합니다. **모델 목록 새로고침**으로 모델을 조회할 수도 있습니다. 원격 API에는 HTTPS가 필요합니다. 커스텀 API 키는 선택 사항이며 입력한 주소에 연결됩니다. v0.4.0에서 커스텀 API 키를 사용했다면 업데이트 후 다시 입력합니다.
- 화면에 들어온 텍스트 구간은 선택한 API에 전송됩니다. 한 구간에 화면 밖의 인접 텍스트가 포함될 수 있습니다. 제공자, 모델, 번역 대상 언어는 번역을 켠 모든 사이트에 공통으로 적용됩니다. API 이용 요금과 데이터 보관 정책은 제공자에 따라 달라집니다.
- API 키와 번역 캐시는 유저스크립트 관리자에 저장되며, 캐시는 24시간 후 만료됩니다. 넓은 사이트 권한은 사이트별로 번역을 켤 수 있게 하고, 외부 호스트 연결 권한은 사용자가 지정한 커스텀 API에 연결할 때 사용합니다.

버그는 [GitHub Issues](https://github.com/nobadwordss/viewport-translator/issues)에 사이트, 브라우저, 유저스크립트 관리자, API 제공자와 함께 알려 주세요. API 키나 비공개 페이지 내용은 포함하지 마세요.

## License

[MIT](LICENSE)
