import { SURFACES, MOTIONS, SECTION_TYPES, CONFIG_KEYS, validateConfig } from './configSchema.js';

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

async function verifySupabaseUser(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return { ok: false, error: 'Отсутствует заголовок Authorization: Bearer <token>.' };
  }

  const token = match[1].trim();
  if (!token || !env.SUPABASE_URL) {
    return { ok: false, error: 'Некорректный токен или не задан SUPABASE_URL.' };
  }

  const supabaseUrl = env.SUPABASE_URL.replace(/\/+$/, '');
  const headers = {
    Authorization: `Bearer ${token}`
  };
  if (env.SUPABASE_ANON_KEY) {
    headers.apikey = env.SUPABASE_ANON_KEY;
  }

  const res = await fetch(`${supabaseUrl}/auth/v1/user`, { headers });
  if (!res.ok) {
    return { ok: false, error: 'Недействительный или просроченный токен сессии Supabase.' };
  }

  const user = await res.json();
  if (!user?.id) {
    return { ok: false, error: 'Пользователь Supabase не найден по токену.' };
  }

  return { ok: true, user };
}

function buildSystemPrompt() {
  return [
    'Ты ассистент редактирования конфигурации лендинга в формате JSON.',
    'На вход ты получаешь текущий JSON-конфиг и инструкцию пользователя на естественном языке.',
    'Твоя задача — вернуть ПОЛНЫЙ обновлённый JSON-конфиг (не diff, не патч и не текст с пояснениями).',
    'Жёсткие правила схемы:',
    `1. Верхний уровень — объект с ключами: ${CONFIG_KEYS.join(', ')}.`,
    `2. "sections" — массив объектов. Поле section.type строго из списка: ${SECTION_TYPES.join(', ')}.`,
    `3. Если указан section.surface — строго одно из: ${Array.from(SURFACES).join(', ')}.`,
    `4. Если указан section.motion — строго одно из: ${Array.from(MOTIONS).join(', ')}.`,
    '5. Не удаляй нужные поля существующих секций, если пользователь не просил об этом явно.',
    '6. Ответ должен быть строго валидным JSON-объектом.'
  ].join('\n');
}

function getConfigResponseSchema() {
  return {
    type: 'OBJECT',
    required: ['theme', 'layout', 'page', 'header', 'footer', 'sections'],
    properties: {
      theme: { type: 'OBJECT' },
      layout: { type: 'OBJECT' },
      page: { type: 'OBJECT' },
      header: { type: 'OBJECT' },
      footer: { type: 'OBJECT' },
      sections: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          required: ['type'],
          properties: {
            id: { type: 'STRING' },
            type: { type: 'STRING', enum: SECTION_TYPES },
            variant: { type: 'STRING' },
            surface: { type: 'STRING', enum: Array.from(SURFACES) },
            motion: { type: 'STRING', enum: Array.from(MOTIONS) }
          }
        }
      }
    }
  };
}

async function callGemini({ apiKey, model, contents, systemInstruction, responseSchema }) {
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
        responseMimeType: 'application/json',
        responseSchema
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
  const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
  const systemInstruction = buildSystemPrompt();
  const responseSchema = getConfigResponseSchema();

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
        systemInstruction,
        responseSchema
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

    const errors = validateConfig(candidate);
    if (errors.length === 0) {
      return { ok: true, config: candidate };
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
          text: `Конфиг не прошёл валидацию:\n- ${errors.join('\n- ')}\nИсправь эти ошибки и верни полный валидный JSON-конфиг.`
        }
      ]
    });
  }

  return {
    ok: false,
    errors: lastValidationErrors
  };
}

export default {
  async fetch(request, env) {
    const corsHeaders = getCorsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/api/assistant') {
      return jsonResponse({ error: 'Not found' }, 404, corsHeaders);
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
    }

    if (!env.GEMINI_API_KEY) {
      return jsonResponse({ error: 'На сервере не настроен GEMINI_API_KEY.' }, 500, corsHeaders);
    }

    const auth = await verifySupabaseUser(request, env);
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

      return jsonResponse({ config: result.config }, 200, corsHeaders);
    } catch (err) {
      return jsonResponse(
        { error: err?.message || 'Внутренняя ошибка при обращении к модели.' },
        500,
        corsHeaders
      );
    }
  }
};
