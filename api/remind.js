// Serverless-функция Vercel: автонапоминание в Telegram по просроченным/сегодняшним/завтрашним задачам.
// Каждая задача отправляется ОТДЕЛЬНЫМ сообщением. Вызывается по расписанию через GitHub Actions (Пн-Пт).
// Использует Supabase service_role key (полный доступ в обход RLS) — задаётся в Vercel как SUPABASE_SERVICE_ROLE_KEY.

const SUPABASE_URL = "https://ducngqsmqvdowlqhehlk.supabase.co";
const OWNER_NAME = "Наговицина Руслана"; // задачи этого человека никогда не попадают в напоминание

function daysUntil(ts) {
  if (!ts) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const due = new Date(ts);
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime();
  return Math.round((dueDay - today) / 86400000);
}

function getDueCategory(dueDate) {
  if (!dueDate) return "no-date";
  const d = daysUntil(dueDate);
  if (d < 0) return "overdue";
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d <= 7) return "week";
  return "future";
}

function formatDateShort(ts) {
  const d = new Date(ts);
  return String(d.getDate()).padStart(2, "0") + "." + String(d.getMonth() + 1).padStart(2, "0") + "." + d.getFullYear();
}

function getTaskLinks(task) {
  if (Array.isArray(task.links)) return task.links.filter(Boolean);
  if (task.link) return [task.link];
  return [];
}

async function fetchAllRows(serviceKey) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/kv_store?select=key,value", {
    headers: { "apikey": serviceKey, "Authorization": "Bearer " + serviceKey }
  });
  if (!res.ok) throw new Error("Supabase GET " + res.status);
  return await res.json();
}

function splitForTelegram(text) {
  const LIMIT = 4000;
  if (!text || text.length <= LIMIT) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > LIMIT) {
    let cut = remaining.lastIndexOf("\n\n", LIMIT);
    if (cut < LIMIT * 0.5) cut = remaining.lastIndexOf("\n", LIMIT);
    if (cut < LIMIT * 0.5) cut = remaining.lastIndexOf(" ", LIMIT);
    if (cut < 1) cut = LIMIT;
    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

const CAT_LABEL = { overdue: "⚠️ Просрочено", today: "📌 Сегодня", tomorrow: "🌅 Завтра" };
const CAT_RANK = { overdue: 0, today: 1, tomorrow: 2 };

async function sendTelegramMessage(tgConfig, chat, text) {
  if (tgConfig.botToken) {
    const parts = splitForTelegram(text);
    for (const part of parts) {
      const r = await fetch("https://api.telegram.org/bot" + tgConfig.botToken + "/sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chat.chatId, text: part, disable_web_page_preview: true })
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.description || "Bot API error");
    }
    return true;
  }
  if (tgConfig.webhookUrl) {
    const r = await fetch(tgConfig.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat.chatId, chatId: chat.chatId, text, chat_name: chat.name })
    });
    if (!r.ok) throw new Error("Webhook вернул " + r.status);
    return true;
  }
  return false;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const REMINDER_SECRET = process.env.REMINDER_SECRET;
  if (REMINDER_SECRET) {
    const provided = req.headers["x-reminder-secret"];
    if (provided !== REMINDER_SECRET) { res.status(401).json({ error: "Unauthorized" }); return; }
  }

  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SERVICE_KEY) { res.status(500).json({ error: "Не задан SUPABASE_SERVICE_ROLE_KEY" }); return; }

  try {
    const rows = await fetchAllRows(SERVICE_KEY);

    const tasks = [];
    const team = [];
    let tgConfig = null;

    for (const row of rows) {
      try {
        const value = JSON.parse(row.value);
        if (row.key.startsWith("task:")) tasks.push(value);
        else if (row.key.startsWith("team:")) team.push(value);
        else if (row.key === "tg-config") tgConfig = value;
      } catch (e) { /* пропускаем битые записи */ }
    }

    if (!tgConfig || !tgConfig.chats || tgConfig.chats.length === 0) {
      res.status(200).json({ skipped: true, reason: "Telegram не настроен" });
      return;
    }
    if (!tgConfig.botToken && !tgConfig.webhookUrl) {
      res.status(200).json({ skipped: true, reason: "Нет ни botToken, ни webhookUrl" });
      return;
    }

    const teamByName = {};
    for (const m of team) teamByName[m.fullName] = m;

    const relevant = ["overdue", "today", "tomorrow"];

    // Для каждой задачи собираем список «чужих» актуальных исполнителей с их категорией
    const cards = [];
    for (const t of tasks) {
      const assignees = t.assignees || [];
      const qualifying = [];
      for (const a of assignees) {
        if (a.name === OWNER_NAME) continue;
        if (a.status === "done") continue;
        const effectiveDue = a.dueDate || t.dueDate;
        const cat = getDueCategory(effectiveDue);
        if (!relevant.includes(cat)) continue;
        qualifying.push({ name: a.name, category: cat, dueDate: effectiveDue });
      }
      if (qualifying.length === 0) continue;
      const worstRank = Math.min(...qualifying.map(q => CAT_RANK[q.category]));
      cards.push({ task: t, qualifying, sortRank: worstRank });
    }

    if (cards.length === 0) {
      res.status(200).json({ sent: false, reason: "Нет актуальных задач для напоминания" });
      return;
    }

    // Сортируем: сначала просроченные, потом сегодня, потом завтра
    cards.sort((a, b) => a.sortRank - b.sortRank);

    const chat = tgConfig.chats[0];
    let sentCount = 0;
    const errors = [];

    for (const card of cards) {
      const t = card.task;
      const lines = [];
      // Заголовок сообщения — самая срочная категория среди исполнителей этой задачи
      const headerCat = Object.keys(CAT_RANK).sort((a, b) => CAT_RANK[a] - CAT_RANK[b])
        .find(c => card.qualifying.some(q => q.category === c));
      lines.push(CAT_LABEL[headerCat] + " · " + t.title);
      if (t.description) lines.push(t.description);

      // Упоминания с пометкой срока у каждого (если категории разные внутри одной задачи)
      const mentions = card.qualifying.map(q => {
        const member = teamByName[q.name];
        const tg = member && member.telegram ? (member.telegram.startsWith("@") ? member.telegram : "@" + member.telegram) : q.name;
        const dateStr = q.dueDate ? formatDateShort(q.dueDate) : "";
        const sameForAll = card.qualifying.every(x => x.category === card.qualifying[0].category);
        return sameForAll ? tg : (tg + " (" + CAT_LABEL[q.category].replace(/^\S+\s/, "") + (dateStr ? " " + dateStr : "") + ")");
      });
      lines.push("👤 " + mentions.join(" "));

      const links = getTaskLinks(t);
      for (const l of links) lines.push("🔗 " + l);

      const text = lines.join("\n");

      try {
        const ok = await sendTelegramMessage(tgConfig, chat, text);
        if (ok) sentCount++;
        // Небольшая пауза между сообщениями — не упираемся в лимиты Telegram
        await new Promise(r => setTimeout(r, 350));
      } catch (e) {
        errors.push({ task: t.title, error: e.message });
      }
    }

    res.status(200).json({ sent: sentCount > 0, tasksSent: sentCount, totalCards: cards.length, errors });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
