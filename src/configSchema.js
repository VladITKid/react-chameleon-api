// Единый источник допустимых значений конфига.
// Используется и рендером страницы, и админ-слоем (валидация черновика).

export const SURFACES = new Set(['default', 'alt', 'accent', 'dark']);
export const MOTIONS = new Set(['fade', 'from-left', 'from-right', 'from-bottom', 'none']);

// Список типов секций. В Page.jsx ему соответствует SECTION_REGISTRY с компонентами.
export const SECTION_TYPES = [
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

export const CONFIG_KEYS = ['theme', 'layout', 'page', 'header', 'footer', 'sections'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Проверка формы конфига. Возвращает список ошибок (пустой — всё валидно).
export function validateConfig(config) {
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
