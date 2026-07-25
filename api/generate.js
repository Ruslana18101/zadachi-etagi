// Serverless-функция Vercel: генерация повестки из транскрипции через OpenRouter (DeepSeek).
// Ключ берётся из переменной окружения OPENROUTER_API_KEY (в код не попадает).

const MODEL = "deepseek/deepseek-chat";

const RU_MONTHS = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];

function formatTeamForPrompt(team) {
  if (!team || team.length === 0) return "";
  const lines = team.map(function(m) {
    const aliases = (m.aliases || []).filter(Boolean).join(", ");
    return "\u2022 " + m.fullName + (m.telegram ? " (Telegram: " + m.telegram + ")" : "") +
      (aliases ? " \u2014 также упоминается как: " + aliases : "");
  });
  return "СОТРУДНИКИ КОМАНДЫ (используй точные ФИО из этого списка для назначения задач):\n" +
    lines.join("\n") + "\n\n";
}

function formatExistingTasksForPrompt(tasks) {
  if (!tasks || tasks.length === 0) return "";
  const lines = tasks.slice(0, 40).map(function(t) {
    const assignees = (t.assignees || []).map(function(a) { return a.name; }).join(", ");
    const desc = t.description ? " \u2014 " + t.description.slice(0, 80) : "";
    return "\u2022 [" + t.id + "] «" + t.title + "»" + desc + (assignees ? " (" + assignees + ")" : "");
  });
  return "УЖЕ ОТКРЫТЫЕ ЗАДАЧИ В ТРЕКЕРЕ (сопоставь с обсуждением; если задача из разговора совпадает по смыслу с существующей — верни её в task_updates, а не создавай дубль):\n" +
    lines.join("\n") + "\n\n";
}

function buildPersonalPrompt(employee, teamSection, tasksSection) {
  const who = employee ? (": " + employee) : "";
  return [
    "Ты — ассистент Русланы, руководителя в агентстве недвижимости «Этажи Владивосток». Это транскрипция её ЛИЧНОЙ встречи (1-на-1) с сотрудником" + who + ".",
    "",
    "Твоя задача: составить личные заметки Русланы по этой встрече. Это НЕ повестка для общего чата — это конфиденциальный протокол 1-на-1.",
    "",
    teamSection + tasksSection,
    "СТРУКТУРА ЗАМЕТОК (используй уместные разделы, необязательно все):",
    "📌 Контекст встречи — 1-2 предложения: почему встретились, настрой сотрудника.",
    "💬 Что обсудили — ключевые темы списком, кратко.",
    "📊 Показатели / результаты — если обсуждались KPI, выработка, рейтинги — цифры и динамика.",
    "🎯 Договорённости — кто что делает, к каким срокам.",
    "🌱 Зоны роста — что прокачать, где пробуксовывает.",
    "⚠️ Проблемы / красные флаги — выгорание, конфликты, демотивация, нарушения.",
    "🫶 Личное — если делился личным (семья, здоровье) — короткой строкой для контекста.",
    "📅 К следующей встрече — что проверить, на чём фокус.",
    "",
    "СТИЛЬ: деловой, но эмпатичный. О сотруднике от третьего лица («Иван говорит, что…»). Эмодзи в заголовках разделов. Обычные переносы строк для абзацев. БЕЗ markdown-заголовков (#), без блоков кода.",
    "",
    "ИЗВЛЕЧЕНИЕ ЗАДАЧ: извлекай задачи с явным исполнителем и действием. Если Руслана (ведущая встречу) говорит «я сделаю / скину / посмотрю / переговорю / вернусь с ОС» — это задача для «Наговицина Руслана». НЕ задача: обсуждение проблем без чёткого «кто что делает», общие наблюдения.",
    "",
    "ВЫХОД: верни ТОЛЬКО валидный JSON без markdown-обрамления и без преамбулы:",
    '{',
    '  "title": "1-на-1: ' + (employee || "[Имя]") + ' · краткая тема",',
    '  "agenda": "Структурированные заметки: эмодзи-заголовки разделов, переносы строк. БЕЗ markdown-заголовков.",',
    '  "tasks": [ {"title": "Действие", "description": "Контекст и срок", "assignees": ["Имя"]} ],',
    '  "task_updates": [ {"existingId": "id-из-списка", "description": "Что изменить/добавить", "newDueDate": "DD.MM.YYYY или null", "reason": "Кратко"} ]',
    '}'
  ].join("\n");
}

function buildGroupPrompt(teamSection, tasksSection) {
  return [
    "Ты — ассистент Русланы, руководителя в агентстве недвижимости «Этажи Владивосток». Руслана ведёт еженедельные планёрки с руководителями групп. После собрания она отправляет в общий чат структурированную «повестку» — итоги со списком решений, задач и анонсов.",
    "",
    "Твоя задача: на основе сырой транскрипции составить повестку в её фирменном стиле и извлечь конкретные задачи для трекера.",
    "",
    teamSection + tasksSection,
    "ОБЯЗАТЕЛЬНЫЙ ЗАГОЛОВОК: повестка ВСЕГДА начинается с отдельной строки, ДО первого пункта:",
    "**СОБРАНИЕ DD.MM.YYYY г.**",
    "Это слово СОБРАНИЕ капслоком + точная дата + « г.». Дату бери из транскрипции (реплики «сегодня двадцатое мая», «пятница пятое число»). Год 2026, если не указан. Если дату не определить — пиши **СОБРАНИЕ __.__.____ г.** для ручного дозаполнения. После заголовка — пустая строка, потом нумерованные пункты.",
    "",
    "СТИЛЬ ПОВЕСТКИ:",
    "• Нумерованный список. Каждый пункт — отдельная тема.",
    "• Заголовок пункта обрамляй эмодзи с двух сторон, например: 1. 📸Фотограф📸",
    "• Под заголовком — суть: что решили, что делать, сроки. Дедлайны формата «до 06.03.2026 г.».",
    "• Подпункты — тире «-» в начале строки.",
    "• Тон деловой, конкретный, без воды. Так, как руководитель пишет своей команде.",
    "• Эмодзи уместны в заголовках пунктов. В теле — умеренно.",
    "• БЕЗ markdown-заголовков (#), без блоков кода.",
    "",
    "ПРАВИЛО ПЕРВОГО ЛИЦА: если Руслана говорит «я скину / переговорю / пришлю / предоставлю / посмотрю» — это задача для «Наговицина Руслана».",
    "",
    "ИЗВЛЕЧЕНИЕ ЗАДАЧ: извлекай задачи с явным исполнителем и действием. Каждая задача — с исполнителем (точное ФИО из списка команды) и, если есть, сроком. НЕ задача: общие обсуждения без «кто что делает».",
    "",
    "ДЕДУПЛИКАЦИЯ: если задача из разговора совпадает по смыслу с уже открытой (из списка выше) — верни её в task_updates с existingId, а не создавай дубль.",
    "",
    "ВЫХОД: верни ТОЛЬКО валидный JSON без markdown-обрамления и без преамбулы:",
    '{',
    '  "title": "Краткое название собрания (2-5 слов)",',
    '  "agenda": "Полный текст повестки: начинается с **СОБРАНИЕ DD.MM.YYYY г.**, пустая строка, нумерованный список с эмодзи-заголовками. Обычный текст с переносами строк, эмодзи в тексте, БЕЗ markdown-заголовков (#), БЕЗ блоков кода.",',
    '  "tasks": [ {"title": "Действие", "description": "Контекст и дедлайн", "assignees": ["Имя1","Имя2"]} ],',
    '  "task_updates": [ {"existingId": "id-из-списка", "description": "Что изменилось/добавилось", "newDueDate": "DD.MM.YYYY или null", "reason": "Кратко"} ]',
    '}'
  ].join("\n");
}

// ─── Основной обработчик ───
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Только POST" }); return; }

  const API_KEY = process.env.OPENROUTER_API_KEY;
  if (!API_KEY) { res.status(500).json({ error: "На сервере не задан OPENROUTER_API_KEY" }); return; }

  try {
    const body = req.body || {};
    const transcription = body.transcription;
    const type = body.type || "group";
    const employee = body.employee || null;
    const team = body.team || [];
    const existingTasks = body.existingTasks || [];

    if (!transcription || !transcription.trim()) {
      res.status(400).json({ error: "Пустая транскрипция" });
      return;
    }

    const teamSection = formatTeamForPrompt(team);
    const tasksSection = formatExistingTasksForPrompt(existingTasks);
    const systemPrompt = type === "personal"
      ? buildPersonalPrompt(employee, teamSection, tasksSection)
      : buildGroupPrompt(teamSection, tasksSection);

    const meetingLabel = type === "personal"
      ? ("личной встречи с " + (employee || "сотрудником"))
      : "собрания";
    const userMessage = "Транскрипция " + meetingLabel + ":\n\n" + transcription;

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + API_KEY,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://zadachi-etagi.vercel.app",
        "X-Title": "Povestka Etazhi"
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage }
        ],
        temperature: 0.4,
        max_tokens: 6000
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      res.status(502).json({ error: "Ошибка модели " + response.status + ": " + errText.slice(0, 300) });
      return;
    }

    const data = await response.json();
    const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";

    const fence = String.fromCharCode(96, 96, 96);
    let clean = text.trim();
    if (clean.indexOf(fence) === 0) {
      clean = clean.replace(new RegExp("^" + fence + "(json)?\\s*", "i"), "");
      clean = clean.replace(new RegExp(fence + "\\s*$"), "");
      clean = clean.trim();
    }

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (e) {
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) { parsed = JSON.parse(match[0]); }
      else { res.status(502).json({ error: "Модель вернула не-JSON", raw: text.slice(0, 500) }); return; }
    }

    res.status(200).json(parsed);
  } catch (e) {
    res.status(500).json({ error: "Внутренняя ошибка: " + (e.message || String(e)) });
  }
}
