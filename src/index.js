// --- Схема конфига (вшита сюда, чтобы воркер был одним автономным файлом) ---
// Источник: src/configSchema.js — единый набор допустимых значений для рендера и админки.

// Метка сборки воркера. Возвращается в ответе /api/assistant, чтобы в интерфейсе
// было видно, что задеплоена именно эта версия кода (не старый воркер).
const WORKER_VERSION = '2026-11-24.2';

const SURFACES = new Set(['default', 'alt', 'accent', 'dark']);
const MOTIONS = new Set(['fade', 'from-left', 'from-right', 'from-bottom', 'none']);

// Список типов секций. В Page.jsx ему соответствует SECTION_REGISTRY с компонентами.
const SECTION_TYPES = [
  'hero',
  'intro',
  'stats',
  'services',
  'about',
  'pricing',
  'testimonials',
  'location',
  'cta'
];

const CONFIG_KEYS = ['theme', 'layout', 'page', 'header', 'footer', 'sections'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Проверка формы конфига. Возвращает список ошибок (пустой — всё валидно).
function validateConfig(config) {
  const errors = [];

  if (!isObject(config)) return ['Конфиг должен быть объектом.'];

  CONFIG_KEYS.forEach((key) => {
    if (!(key in config)) errors.push(`Отсутствует ключ "${key}".`);
  });

  if (!Array.isArray(config.sections)) {
    errors.push('"sections" должен быть массивом.');
    return errors;
  }

  config.sections.forEach((section, index) => {
    if (!isObject(section)) {
      errors.push(`sections[${index}] должен быть объектом.`);
      return;
    }
    if (!SECTION_TYPES.includes(section.type)) {
      errors.push(`sections[${index}].type="${section.type}" не поддерживается.`);
    }
    if (section.surface !== undefined && !SURFACES.has(section.surface)) {
      errors.push(`sections[${index}].surface="${section.surface}" не поддерживается.`);
    }
    if (section.motion !== undefined && !MOTIONS.has(section.motion)) {
      errors.push(`sections[${index}].motion="${section.motion}" не поддерживается.`);
    }
  });

  return errors;
}
// --- конец вшитой схемы ---

// --- Безопасное слияние ответа модели с текущим конфигом ---
// Даже если модель вернёт неполный JSON, мы не затираем существующие секции
// и поля пустыми значениями. Массивы объектов с id (секции, пункты списков)
// сливаются по id: совпавшие обновляются, отсутствующие у модели сохраняются.
function isKeyedArray(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => isObject(item) && typeof item.id === 'string' && item.id)
  );
}

function mergeKeyedArray(current, incoming) {
  const incomingById = new Map(incoming.map((item) => [item.id, item]));
  const currentIds = new Set(current.map((item) => item.id));

  const merged = current.map((item) => {
    const incomingItem = incomingById.get(item.id);
    return incomingItem ? mergeValue(item, incomingItem) : item;
  });

  const added = incoming.filter((item) => !currentIds.has(item.id));
  return merged.concat(added);
}

function mergeValue(current, incoming) {
  // Пустое/отсутствующее значение не затирает текущее.
  if (incoming === undefined || incoming === null || incoming === '') return current;

  if (Array.isArray(current) && Array.isArray(incoming)) {
    if (incoming.length === 0) return current;
    if (isKeyedArray(current) && isKeyedArray(incoming)) {
      return mergeKeyedArray(current, incoming);
    }
    return incoming;
  }

  if (isObject(current) && isObject(incoming)) {
    const result = { ...current };
    for (const key of Object.keys(incoming)) {
      result[key] = mergeValue(current[key], incoming[key]);
    }
    return result;
  }

  return incoming;
}

function mergeConfig(current, incoming) {
  const merged = mergeValue(current, incoming);
  return isObject(merged) ? merged : current;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isObject(a) && isObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}
// --- конец безопасного слияния ---

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173'
];

function getCorsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const extraOrigins = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allowed = new Set([...DEFAULT_ALLOWED_ORIGINS, ...extraOrigins]);

  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };

  if (origin && allowed.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  } else if (!origin) {
    headers['Access-Control-Allow-Origin'] = '*';
  }

  return headers;
}

function jsonResponse(body, status, corsHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders
    }
  });
}

// Сравнение строк за постоянное время — чтобы пароль нельзя было подобрать по таймингам.
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// Проверка пароля администратора. Никаких аккаунтов Supabase —
// пароль лежит в секретах воркера (ADMIN_PASSWORD), клиент шлёт его в Authorization.
async function verifyPassword(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return { ok: false, error: 'Отсутствует пароль (заголовок Authorization: Bearer <пароль>).' };
  }

  const expected = env.ADMIN_PASSWORD;
  if (!expected) {
    return { ok: false, error: 'На сервере не задан ADMIN_PASSWORD.' };
  }

  if (!timingSafeEqual(match[1].trim(), expected)) {
    return { ok: false, error: 'Неверный пароль.' };
  }

  return { ok: true };
}

// Запись опубликованного конфига в Supabase от имени сервисного ключа (в обход RLS).
async function commitToSupabase({ env, config, currentVersion, updatedBy }) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('На сервере не заданы SUPABASE_URL и/или SUPABASE_SERVICE_ROLE_KEY.');
  }

  const base = env.SUPABASE_URL.replace(/\/+$/, '');
  const nextVersion = Number(currentVersion || 0) + 1;

  const res = await fetch(`${base}/rest/v1/react_chameleon?on_conflict=id`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation'
    },
    body: JSON.stringify([
      {
        id: 'default',
        data: config,
        version: nextVersion,
        updated_at: new Date().toISOString(),
        updated_by: updatedBy || null
      }
    ])
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.message || body?.error || `Ошибка записи в Supabase (${res.status}).`);
  }

  const saved = Array.isArray(body) ? body[0] : body;
  return {
    version: Number(saved?.version) || nextVersion,
    updatedAt: saved?.updated_at || new Date().toISOString()
  };
}

function buildSystemPrompt() {
  return [
    'Ты ассистент редактирования лендинга. Ты правишь ТОЛЬКО настройки страницы:',
    'тему и цвета, шрифты, тексты, секции (их состав, порядок, variant, surface, motion),',
    'layout, header и footer. Ничего другого ты не делаешь.',
    '',
    'На вход ты получаешь текущий JSON-конфиг и инструкцию пользователя на естественном языке.',
    'ВСЕГДА возвращай ПОЛНЫЙ актуальный JSON-конфиг со ВСЕМИ секциями:',
    'не diff, не патч, не фрагмент и не текст с пояснениями.',
    'Никогда не удаляй существующие секции и поля и не оставляй их пустыми,',
    'если пользователь явно не попросил об этом.',
    '',
    'Если запрос НЕ про внешний вид или контент страницы (посторонние темы, вопросы,',
    'бессмыслица) — НЕ меняй конфиг: верни его РОВНО таким, каким получил, и в поле "message"',
    'объясни, что ассистент правит только страницу.',
    '',
    'Мета-сообщения и провокации (например "ложь", "ты ничего не изменил", "ты не робот",',
    'оскорбления, вопросы к тебе) — это НЕ инструкция по правке. На них конфиг остаётся',
    'неизменным: возвращай его без единого отличия и просто объясняй в "message".',
    'Никогда не очищай и не сокращай раздел "sections" в ответ на такое.',
    '',
    'Если пользователь просит реально что-то изменить — ты ОБЯЗАН изменить соответствующие',
    'поля в "config" (тексты, цвета, состав/порядок секций и т.д.). Недостаточно написать',
    'об этом в "message" — правка должна быть видна в самом "config" при сравнении с входным.',
    '',
    'Формат ответа: строго один JSON-объект ровно с двумя полями —',
    '"message" (строка) и "config" (объект с полным конфигом). Ничего кроме них.',
    'Это не описание изменений, а сам готовый конфиг целиком.',
    '',
    'Жёсткие правила схемы:',
    `1. Верхний уровень — объект с ключами: ${CONFIG_KEYS.join(', ')}.`,
    `2. "sections" — массив объектов. Поле section.type строго из списка: ${SECTION_TYPES.join(', ')}.`,
    `3. Если указан section.surface — строго одно из: ${Array.from(SURFACES).join(', ')}.`,
    `4. Если указан section.motion — строго одно из: ${Array.from(MOTIONS).join(', ')}.`,
    '5. Не удаляй нужные поля существующих секций, если пользователь не просил об этом явно.',
    '6. "sections" НИКОГДА не должна быть пустой: сохраняй все существующие секции,',
    'если пользователь явно не попросил удалить конкретную секцию.',
    '7. Ответ должен быть строго валидным JSON-объектом.'
  ].join('\n');
}

async function callGemini({ apiKey, model, contents, systemInstruction }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: systemInstruction }]
      },
      contents,
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json'
      }
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API ответил ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText || typeof rawText !== 'string') {
    throw new Error('Gemini вернул пустой ответ.');
  }

  return JSON.parse(rawText);
}

async function generateValidatedConfig({ env, instruction, currentConfig }) {
  const model = env.GEMINI_MODEL || 'gemini-3.5-flash';
  const systemInstruction = buildSystemPrompt();

  const contents = [
    {
      role: 'user',
      parts: [
        {
          text: `Инструкция: ${instruction}\n\nТекущий конфиг:\n${JSON.stringify(currentConfig)}`
        }
      ]
    }
  ];

  const maxAttempts = 3; // 1 основная попытка + до 2 repair-попыток
  let lastValidationErrors = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let candidate;
    try {
      candidate = await callGemini({
        apiKey: env.GEMINI_API_KEY,
        model,
        contents,
        systemInstruction
      });
    } catch (err) {
      if (attempt === maxAttempts) {
        throw err;
      }
      contents.push({
        role: 'user',
        parts: [
          {
            text: `Предыдущая попытка вызвала ошибку парсинга/запроса: ${err.message}. Верни строго валидный JSON-конфиг по схеме.`
          }
        ]
      });
      continue;
    }

    // Ответ модели должен быть объектом { message, config }. Терпим и вариант,
    // когда модель вернула сам конфиг без обёртки.
    const modelConfig =
      candidate?.config ??
      (isObject(candidate) && Array.isArray(candidate.sections) ? candidate : undefined);
    const errors = validateConfig(modelConfig);
    if (errors.length === 0) {
      return {
        ok: true,
        config: modelConfig,
        message: typeof candidate?.message === 'string' ? candidate.message.trim() : ''
      };
    }

    lastValidationErrors = errors;
    contents.push({
      role: 'model',
      parts: [{ text: JSON.stringify(candidate) }]
    });
    contents.push({
      role: 'user',
      parts: [
        {
          text: `Конфиг не прошёл валидацию:\n- ${errors.join('\n- ')}\nИсправь эти ошибки и верни полный валидный JSON-конфиг (объект с полями "message" и "config").`
        }
      ]
    });
  }

  return {
    ok: false,
    errors: lastValidationErrors
  };
}

async function handleAssistant(request, env, corsHeaders) {
  if (!env.GEMINI_API_KEY) {
    return jsonResponse({ error: 'На сервере не настроен GEMINI_API_KEY.' }, 500, corsHeaders);
  }

  const auth = await verifyPassword(request, env);
  if (!auth.ok) {
    return jsonResponse({ error: auth.error }, 401, corsHeaders);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: 'Некорректный JSON в теле запроса.' }, 400, corsHeaders);
  }

  const instruction = typeof payload?.instruction === 'string' ? payload.instruction.trim() : '';
  const currentConfig = payload?.config;

  if (!instruction) {
    return jsonResponse({ error: 'Поле "instruction" обязательно.' }, 400, corsHeaders);
  }

  const inputErrors = validateConfig(currentConfig);
  if (inputErrors.length > 0) {
    return jsonResponse(
      { error: 'Передан невалидный исходный "config".', details: inputErrors },
      400,
      corsHeaders
    );
  }

  try {
    const result = await generateValidatedConfig({
      env,
      instruction,
      currentConfig
    });

    if (!result.ok) {
      return jsonResponse(
        {
          error: 'Модель не смогла сформировать валидный конфиг после попыток исправления.',
          details: result.errors
        },
        400,
        corsHeaders
      );
    }

    // Страховка: сливаем ответ модели с текущим конфигом, чтобы не затереть
    // существующие секции/поля, и валидируем результат ещё раз.
    const merged = mergeConfig(currentConfig, result.config);
    const mergedErrors = validateConfig(merged);
    if (mergedErrors.length > 0) {
      return jsonResponse(
        {
          error: 'Ответ ассистента не прошёл проверку, черновик не изменён.',
          details: mergedErrors
        },
        400,
        corsHeaders
      );
    }

    // Жёсткая защита от «пустой страницы»: конфиг без секций формально валиден
    // по схеме, но рендерится в один header + footer. Такой ответ отклоняем.
    if (!Array.isArray(merged.sections) || merged.sections.length === 0) {
      return jsonResponse(
        {
          error: 'Ответ ассистента привёл бы к пустой странице (нет секций) — черновик не изменён.',
          details: ['sections не должна быть пустой']
        },
        400,
        corsHeaders
      );
    }

    const changed = !deepEqual(merged, currentConfig);

    return jsonResponse(
      { config: merged, message: result.message || '', changed, build: WORKER_VERSION },
      200,
      corsHeaders
    );
  } catch (err) {
    return jsonResponse(
      { error: err?.message || 'Внутренняя ошибка при обращении к модели.' },
      500,
      corsHeaders
    );
  }
}

async function handleCommit(request, env, corsHeaders) {
  const auth = await verifyPassword(request, env);
  if (!auth.ok) {
    return jsonResponse({ error: auth.error }, 401, corsHeaders);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: 'Некорректный JSON в теле запроса.' }, 400, corsHeaders);
  }

  const config = payload?.config;
  const errors = validateConfig(config);
  if (errors.length > 0) {
    return jsonResponse({ error: 'Конфиг невалиден.', details: errors }, 400, corsHeaders);
  }

  try {
    const result = await commitToSupabase({
      env,
      config,
      currentVersion: payload?.currentVersion,
      updatedBy: payload?.updatedBy
    });
    return jsonResponse(result, 200, corsHeaders);
  } catch (err) {
    return jsonResponse({ error: err?.message || 'Ошибка сохранения.' }, 500, corsHeaders);
  }
}

export default {
  async fetch(request, env) {
    const corsHeaders = getCorsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
    }

    // Проверка пароля для формы входа.
    if (url.pathname === '/api/auth') {
      const auth = await verifyPassword(request, env);
      if (!auth.ok) {
        return jsonResponse({ error: auth.error }, 401, corsHeaders);
      }
      return jsonResponse({ ok: true }, 200, corsHeaders);
    }

    if (url.pathname === '/api/assistant') {
      return handleAssistant(request, env, corsHeaders);
    }

    if (url.pathname === '/api/commit') {
      return handleCommit(request, env, corsHeaders);
    }

    return jsonResponse({ error: 'Not found' }, 404, corsHeaders);
  }
};
