const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 3600;
const SERPER_TIMEOUT_MS = 600;
const GEMINI_TIMEOUT_MS = 2500;

const DEFAULT_TIMEZONE = "Europe/Moscow";
const MAX_OUTPUT_TOKENS = 400;

const SYSTEM_PROMPT = [
  "Ты — полезный голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай естественно, по-русски, кратко и так, чтобы ответ было удобно слушать.",
  "Начинай сразу с сути ответа: сначала прямой ответ, потом при необходимости одно уточнение.",
  "Обычно используй 1–3 коротких предложения. Не используй Markdown, таблицы, списки с символами, ссылки, адреса сайтов, эмодзи или длинные вступления.",
  "Короткие реплики вроде «а завтра?» или «а он сколько стоит?» понимай в контексте предыдущих реплик.",
  "Если переданы результаты поиска, для фактов о текущем положении дел (цены, курсы, погода, новости, счёт матчей, кто сейчас занимает должность) доверяй им больше, чем своим знаниям. Не выдумывай отсутствующие факты.",
  "Если результаты поиска не отвечают на вопрос, а сам ты точно не знаешь, честно скажи об этом одной фразой."
].join(" ");

// JS \b does not see Cyrillic word boundaries, so whole-word checks use lookarounds.
const OFFLINE_INTENT = /^(привет|здравствуй|добр(ое|ый)|спасибо|благодарю|пока|до свидания|как дела|как ты|кто ты|как тебя зовут|что ты умеешь|понятно|ясно)(?=$|[\s,.!?])|сказк|стих|шутк|пошути|анекдот|загадк|придумай|сочини|напиши|перевед|переведи|посчитай|сколько будет \d|скороговорк|поговорим|давай поиграем|игр(а|у) в/i;
const WEATHER_INTENT = /погод|температур|градус|дожд|снег|осадк|ветер|прогноз/i;

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: { history }
  };
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) return text || "Не удалось подготовить ответ.";

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );
  if (sentenceEnd >= 300) return candidate.slice(0, sentenceEnd + 1).trim();

  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные/i.test(text);
}

// Search by default: almost any factual question benefits from fresh data.
// Only small talk, creative tasks and arithmetic go straight to Gemini.
function needsSearch(text) {
  return isSearchIntent(text) || !OFFLINE_INTENT.test(text.trim());
}

// Follow-ups like "а завтра?" carry no topic on their own, so the search query
// borrows the previous user question. A home city fills in weather questions.
function buildSearchQuery(text, history, homeCity = "") {
  let query = text.trim();
  const words = query.split(/\s+/).filter(Boolean);
  const lastUser = [...history].reverse().find(item => item.role === "user")?.text;
  if (lastUser && words.length <= 4) query = `${lastUser} ${query}`;

  const city = homeCity.trim();
  if (city && WEATHER_INTENT.test(query) && !/(^|\s)(в|во)\s+[А-ЯЁA-Z]/.test(query)) {
    query = `${query} ${city}`;
  }
  return query.slice(0, 300);
}

function currentDateLine(timezone) {
  const format = zone => new Intl.DateTimeFormat("ru-RU", {
    timeZone: zone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date());

  let zone = typeof timezone === "string" && timezone ? timezone : DEFAULT_TIMEZONE;
  let formatted;
  try {
    formatted = format(zone);
  } catch {
    zone = DEFAULT_TIMEZONE;
    formatted = format(zone);
  }
  return `Сейчас ${formatted} (часовой пояс пользователя ${zone}).`;
}

function buildSystemPrompt({ timezone, homeCity } = {}) {
  const parts = [SYSTEM_PROMPT, currentDateLine(timezone)];
  const city = String(homeCity || "").trim();
  if (city) parts.push(`Пользователь живёт в городе ${city}; если в вопросе о погоде, времени или местах город не назван, имей в виду этот город.`);
  return parts.join(" ");
}

// The model occasionally slips into Markdown or reads out links; neither works by voice.
function cleanForVoice(value) {
  return String(value ?? "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_#`>]+/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS) }));
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

// Links are left out on purpose: the model would read them aloud.
function formatSearchResults(data) {
  const clip = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const lines = [];

  const box = data?.answerBox;
  if (box) {
    const boxText = [box.title, box.answer, box.snippet].filter(Boolean).map(v => clip(v, 300)).join(" — ");
    if (boxText) lines.push(`Прямой ответ поисковика: ${boxText}`);
  }

  const graph = data?.knowledgeGraph;
  if (graph?.title) {
    const attributes = Object.entries(graph.attributes || {})
      .slice(0, 6)
      .map(([key, value]) => `${clip(key, 60)}: ${clip(value, 120)}`)
      .join("; ");
    const description = [graph.type, graph.description].filter(Boolean).map(v => clip(v, 300)).join(". ");
    lines.push(`Справка: ${clip(graph.title, 120)}. ${description}${attributes ? ` (${attributes})` : ""}`.trim());
  }

  const organic = Array.isArray(data?.organic) ? data.organic.slice(0, 5) : [];
  organic.forEach((item, i) => {
    const date = item.date ? ` [${clip(item.date, 40)}]` : "";
    lines.push(`${i + 1}. ${clip(item.title, 160)}${date}: ${clip(item.snippet, 320)}`);
  });

  const stories = Array.isArray(data?.topStories) ? data.topStories.slice(0, 3) : [];
  stories.forEach(item => {
    const date = item.date ? ` [${clip(item.date, 40)}]` : "";
    lines.push(`Новость${date}: ${clip(item.title, 200)}`);
  });

  return lines.join("\n");
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;
  if (!key || timeoutMs < 150) return "";

  try {
    const { response, data } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          q: query,
          gl: String(process.env.SEARCH_COUNTRY || "ru").trim().toLowerCase(),
          hl: "ru",
          num: 5
        })
      },
      Math.min(SERPER_TIMEOUT_MS, timeoutMs)
    );

    if (!response.ok) {
      console.warn("Serper request failed with HTTP", response.status);
      return "";
    }
    return formatSearchResults(data);
  } catch (error) {
    console.warn("Serper request did not finish in time; continuing without search.");
    return "";
  }
}

async function askGemini(text, history, searchContext, timeoutMs, systemPrompt = SYSTEM_PROMPT) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_GEMINI_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error("INVALID_MODEL_NAME");

  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  const prompt = searchContext
    ? `${text}\n\nРезультаты поиска в интернете:\n${searchContext}\nИспользуй их только там, где они относятся к вопросу.`
    : text;
  contents.push({ role: "user", parts: [{ text: prompt }] });

  const { response, data } = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: {
          // Lower temperature keeps factual answers close to the search results.
          temperature: 0.3,
          // Thinking tokens count toward this limit, so it leaves room beyond the spoken answer.
          maxOutputTokens: MAX_OUTPUT_TOKENS
        }
      })
    },
    Math.min(GEMINI_TIMEOUT_MS, timeoutMs)
  );

  if (!response.ok) {
    const status = Number(response.status);
    console.error("Gemini request failed with HTTP", status);
    if (status === 401 || status === 403) throw new Error("GEMINI_KEY_REJECTED");
    if (status === 429) throw new Error("GEMINI_QUOTA");
    throw new Error("GEMINI_REQUEST_FAILED");
  }

  const candidate = data?.candidates?.[0];
  const answer = cleanForVoice((candidate?.content?.parts || [])
    .filter(part => !part.thought)
    .map(part => typeof part.text === "string" ? part.text : "")
    .join(""));

  if (!answer) {
    if (data?.promptFeedback?.blockReason) throw new Error("GEMINI_BLOCKED");
    throw new Error("GEMINI_EMPTY_RESPONSE");
  }
  if (candidate?.finishReason === "MAX_TOKENS") {
    console.warn("Gemini reached the output token limit.");
  }
  return answer;
}

function errorForUser(error) {
  switch (error?.message) {
    case "MISSING_GEMINI_KEY":
      return "Сервер пока не настроен. Проверьте переменную GEMINI_API_KEY в настройках Vercel.";
    case "GEMINI_KEY_REJECTED":
      return "Не удалось подключиться к Gemini. Проверьте API-ключ в настройках Vercel.";
    case "GEMINI_QUOTA":
      return "Сейчас превышен лимит запросов к Gemini. Попробуйте немного позже.";
    case "GEMINI_BLOCKED":
      return "Я не смогла обработать этот запрос. Попробуйте спросить иначе.";
    case "TIME_BUDGET_EXHAUSTED":
    case "AbortError":
      return "Не успела подготовить ответ. Попробуйте задать вопрос ещё раз, чуть короче.";
    default:
      return "Не получилось получить ответ от нейросети. Попробуйте ещё раз чуть позже.";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-gemini-serper",
      message: "Webhook is ready. Yandex Dialogs should send POST requests to /api."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startedAt = Date.now();
  const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = String(body?.request?.command || body?.request?.original_utterance || "").trim();
  const oldHistory = safeHistory(body?.state?.session?.history);

  if (!text) {
    return res.status(200).json(aliceResponse(
      "Привет! Я могу ответить на вопрос или найти актуальную информацию. Что хочешь узнать?",
      false,
      oldHistory
    ));
  }

  const homeCity = String(process.env.HOME_CITY || "");
  const systemPrompt = buildSystemPrompt({ timezone: body?.meta?.timezone, homeCity });

  try {
    let searchContext = "";
    if (needsSearch(text) && process.env.SERPER_API_KEY) {
      // Search has a very short budget because Alice expects a response within 4.5 seconds.
      searchContext = await searchWeb(
        buildSearchQuery(text, oldHistory, homeCity),
        Math.min(SERPER_TIMEOUT_MS, Math.max(0, remainingMs() - 2600))
      );
    }

    const answer = await askGemini(
      text,
      oldHistory,
      searchContext,
      Math.max(0, Math.min(GEMINI_TIMEOUT_MS, remainingMs() - 600)),
      systemPrompt
    );

    const history = [
      ...oldHistory,
      { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "model", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
    ].slice(-MAX_HISTORY_MESSAGES);

    return res.status(200).json(aliceResponse(answer, false, history));
  } catch (error) {
    const safeError = error?.message === "AbortError" ? "TIME_BUDGET_EXHAUSTED" : error;
    console.warn("Alice webhook returned a fallback response:", safeError?.message || "unknown error");
    return res.status(200).json(aliceResponse(errorForUser(safeError), false, oldHistory));
  }
}

export {
  aliceResponse,
  buildSearchQuery,
  buildSystemPrompt,
  cleanForVoice,
  fitAliceText,
  formatSearchResults,
  isSearchIntent,
  needsSearch,
  safeHistory
};
