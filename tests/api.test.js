import test from "node:test";
import assert from "node:assert/strict";
import {
  aliceResponse,
  buildSearchQuery,
  buildSystemPrompt,
  cleanForVoice,
  fitAliceText,
  formatSearchResults,
  isSearchIntent,
  needsSearch,
  safeHistory
} from "../api/index.js";

test("Alice response uses required response envelope", () => {
  const result = aliceResponse("Привет", false, [{ role: "user", text: "тест" }]);
  assert.equal(result.version, "1.0");
  assert.equal(result.response.text, "Привет");
  assert.equal(result.response.end_session, false);
  assert.deepEqual(result.session_state.history, [{ role: "user", text: "тест" }]);
});

test("search intent detects Russian and English freshness requests", () => {
  assert.equal(isSearchIntent("Какая погода сегодня?"), true);
  assert.equal(isSearchIntent("What is the latest news?"), true);
  assert.equal(isSearchIntent("Расскажи сказку"), false);
});

test("long responses are cut at a natural boundary and stay within Alice limit", () => {
  const value = fitAliceText(("Это короткое предложение. ").repeat(100));
  assert.ok(value.length <= 1024);
  assert.ok(value.endsWith("."));
});

test("history filters malformed messages and keeps last 8", () => {
  const input = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "model" : "user", text: String(i) }));
  input.push({ role: "hacker", text: "ignore" }, { role: "user", text: 17 });
  const result = safeHistory(input);
  assert.equal(result.length, 8);
  assert.equal(result[0].text, "4");
  assert.equal(result[7].text, "11");
});

test("GET health check returns an ok response", async () => {
  const handler = (await import("../api/index.js")).default;
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return value; },
    setHeader() {}
  };
  await handler({ method: "GET" }, res);
  assert.equal(statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.service, "alice-gemini-serper");
});

test("launch request returns a valid Alice greeting without external API keys", async () => {
  const handler = (await import("../api/index.js")).default;
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return value; },
    setHeader() {}
  };
  await handler({ method: "POST", body: { request: { command: "" }, state: { session: { history: [] } } } }, res);
  assert.equal(statusCode, 200);
  assert.equal(payload.version, "1.0");
  assert.match(payload.response.text, /Привет/);
  assert.equal(payload.response.end_session, false);
});

test("factual questions search by default, small talk and creative tasks do not", () => {
  assert.equal(needsSearch("Кто выиграл последний чемпионат мира по футболу?"), true);
  assert.equal(needsSearch("Сколько лет Пугачёвой"), true);
  assert.equal(needsSearch("Привет, как дела?"), false);
  assert.equal(needsSearch("Расскажи сказку про кота"), false);
  assert.equal(needsSearch("Сколько будет 7 умножить на 8"), false);
  assert.equal(needsSearch("Пока"), false);
  assert.equal(needsSearch("Покажи рецепт борща"), true);
});

test("short follow-ups borrow the previous question for search", () => {
  const history = [{ role: "user", text: "Какая погода в Казани" }, { role: "model", text: "Плюс пять." }];
  assert.equal(buildSearchQuery("а завтра?", history), "Какая погода в Казани а завтра?");
  assert.equal(buildSearchQuery("Кто написал роман Война и мир", history), "Кто написал роман Война и мир");
});

test("home city is added only to weather questions without a city", () => {
  assert.equal(buildSearchQuery("Какая погода сегодня", [], "Тель-Авив"), "Какая погода сегодня Тель-Авив");
  assert.equal(buildSearchQuery("Какая погода в Москве", [], "Тель-Авив"), "Какая погода в Москве");
  assert.equal(buildSearchQuery("Курс доллара", [], "Тель-Авив"), "Курс доллара");
});

test("system prompt carries the user's current date and survives a bad timezone", () => {
  const prompt = buildSystemPrompt({ timezone: "Asia/Jerusalem", homeCity: "Хайфа" });
  assert.match(prompt, /Сейчас .*\d{4}/);
  assert.match(prompt, /Asia\/Jerusalem/);
  assert.match(prompt, /Хайфа/);
  assert.match(buildSystemPrompt({ timezone: "Not/AZone" }), /Europe\/Moscow/);
});

test("search results keep answer box, knowledge graph and dates but drop links", () => {
  const text = formatSearchResults({
    answerBox: { answer: "92,4 ₽" },
    knowledgeGraph: { title: "Доллар США", type: "Валюта", attributes: { Код: "USD" } },
    organic: [{ title: "Курс ЦБ", snippet: "Официальный курс", date: "2 часа назад", link: "https://cbr.ru" }],
    topStories: [{ title: "Рубль укрепился", date: "1 час назад" }]
  });
  assert.match(text, /Прямой ответ поисковика: 92,4 ₽/);
  assert.match(text, /Справка: Доллар США\. Валюта \(Код: USD\)/);
  assert.match(text, /Курс ЦБ \[2 часа назад\]/);
  assert.match(text, /Новость \[1 час назад\]: Рубль укрепился/);
  assert.doesNotMatch(text, /https?:/);
});

test("voice cleanup strips Markdown and links", () => {
  assert.equal(cleanForVoice("**Ответ:** см. [сайт](https://a.ru) или https://b.ru сейчас"), "Ответ: см. сайт или сейчас");
});

test("question flows through search and Gemini with date in the prompt", async () => {
  const handler = (await import("../api/index.js")).default;
  const calls = [];
  const originalFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = "test-gemini";
  process.env.SERPER_API_KEY = "test-serper";
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    const data = String(url).includes("serper")
      ? { answerBox: { answer: "Плюс 24" } }
      : { candidates: [{ content: { parts: [{ text: "Сейчас **плюс 24**." }] } }] };
    return { ok: true, status: 200, json: async () => data };
  };

  let payload;
  const res = { status() { return this; }, json(value) { payload = value; return value; }, setHeader() {} };
  try {
    await handler({
      method: "POST",
      body: {
        meta: { timezone: "Asia/Jerusalem" },
        request: { command: "какая погода сейчас в Хайфе" },
        state: { session: { history: [] } }
      }
    }, res);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
    delete process.env.SERPER_API_KEY;
  }

  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.q, "какая погода сейчас в Хайфе");
  const gemini = calls[1].body;
  assert.match(gemini.systemInstruction.parts[0].text, /Asia\/Jerusalem/);
  assert.match(gemini.contents.at(-1).parts[0].text, /Прямой ответ поисковика: Плюс 24/);
  assert.equal(payload.response.text, "Сейчас плюс 24.");
  assert.equal(payload.session_state.history.length, 2);
});

test("a Gemini timeout gives the retry message, not a generic failure", async () => {
  const handler = (await import("../api/index.js")).default;
  const originalFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = "test-gemini";
  globalThis.fetch = async () => {
    throw new DOMException("This operation was aborted", "AbortError");
  };

  let payload;
  const res = { status() { return this; }, json(value) { payload = value; return value; }, setHeader() {} };
  try {
    await handler({ method: "POST", body: { request: { command: "Расскажи сказку" }, state: { session: {} } } }, res);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
  }
  assert.match(payload.response.text, /Не успела подготовить ответ/);
});
