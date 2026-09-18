// Telegram'dan gelen mesajları (komutları) işleyen fonksiyon.
// Telegram, kullanıcı bota her mesaj yazdığında bu URL'ye bir "webhook" isteği gönderir.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_CHAT_ID = process.env.ALLOWED_CHAT_ID; // sadece senin sohbetinden komut kabul edilir

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

async function sendMessage(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

async function supabaseRequest(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: options.prefer || "return=representation",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Supabase hata (${res.status}): ${errText}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function isValidDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}

function isValidAirportCode(s) {
  return /^[A-Za-z]{3}$/.test(s);
}

const HELP_TEXT = `<b>Uçuş Fiyat Takip Botu — Komutlar</b>

<b>/ekle KALKIŞ VARIŞ GİDİŞ_TARİHİ [DÖNÜŞ_TARİHİ]</b>
Yeni bir rota takibe alır.
Örnek (gidiş-dönüş): /ekle IST BEG 2026-10-10 2026-10-16
Örnek (tek yön): /ekle IST BEG 2026-10-10

<b>/listele</b>
Takip edilen tüm rotaları ve o ana kadar görülen en düşük fiyatları gösterir.

<b>/sil ID</b>
Bir rotayı takipten çıkarır. ID'yi /listele ile görebilirsin.
Örnek: /sil 3

<b>/komutlar</b> veya <b>/yardim</b>
Bu komut listesini tekrar gösterir.

Fiyatlar saatte bir kontrol edilir; düşüş olursa buradan haber verilir.`;

async function handleEkle(chatId, args) {
  if (args.length < 3) {
    await sendMessage(
      chatId,
      "Kullanım: /ekle KALKIŞ VARIŞ GİDİŞ_TARİHİ [DÖNÜŞ_TARİHİ]\nÖrnek: /ekle IST BEG 2026-10-10 2026-10-16"
    );
    return;
  }
  const [origin, destination, departDate, returnDate] = args;

  if (!isValidAirportCode(origin) || !isValidAirportCode(destination)) {
    await sendMessage(chatId, "Havalimanı kodları 3 harfli olmalı (örn: IST, BEG, JFK).");
    return;
  }
  if (!isValidDate(departDate) || (returnDate && !isValidDate(returnDate))) {
    await sendMessage(chatId, "Tarih formatı YYYY-AA-GG olmalı, örn: 2026-10-10");
    return;
  }

  const row = {
    chat_id: chatId,
    origin: origin.toUpperCase(),
    destination: destination.toUpperCase(),
    depart_date: departDate,
    return_date: returnDate || null,
    active: true,
  };

  const inserted = await supabaseRequest("routes", {
    method: "POST",
    body: JSON.stringify(row),
  });

  const id = inserted[0].id;
  const tripDesc = returnDate
    ? `${origin.toUpperCase()} → ${destination.toUpperCase()} (${departDate} / dönüş ${returnDate})`
    : `${origin.toUpperCase()} → ${destination.toUpperCase()} (${departDate}, tek yön)`;

  await sendMessage(
    chatId,
    `✅ Eklendi (ID: ${id})\n${tripDesc}\n\nİlk fiyat kontrolü bir sonraki saatlik taramada yapılacak.`
  );
}

async function handleListele(chatId) {
  const routes = await supabaseRequest(
    `routes?chat_id=eq.${chatId}&active=eq.true&order=created_at.desc`
  );

  if (!routes || routes.length === 0) {
    await sendMessage(chatId, "Şu an takip edilen bir rota yok. /ekle ile ekleyebilirsin.");
    return;
  }

  const lines = routes.map((r) => {
    const trip = r.return_date
      ? `${r.origin} → ${r.destination} (${r.depart_date} / ${r.return_date})`
      : `${r.origin} → ${r.destination} (${r.depart_date}, tek yön)`;
    const directPrice = r.lowest_price_direct
      ? `${r.lowest_price_direct} ${r.currency}`
      : "henüz görülmedi";
    const connectingPrice = r.lowest_price_connecting
      ? `${r.lowest_price_connecting} ${r.currency}`
      : "henüz görülmedi";
    const errorNote = r.last_error ? `\n   ⚠️ Son kontrolde hata: ${r.last_error}` : "";
    return (
      `#${r.id} — ${trip}\n` +
      `   ✈️ Direkt en düşük: ${directPrice}\n` +
      `   🔀 Aktarmalı en düşük: ${connectingPrice}${errorNote}`
    );
  });

  await sendMessage(chatId, `<b>Takip Edilen Rotalar</b>\n\n${lines.join("\n\n")}`);
}

async function handleSil(chatId, args) {
  if (args.length < 1 || isNaN(Number(args[0]))) {
    await sendMessage(chatId, "Kullanım: /sil ID  (ID'yi /listele ile görebilirsin)");
    return;
  }
  const id = Number(args[0]);

  const updated = await supabaseRequest(`routes?id=eq.${id}&chat_id=eq.${chatId}`, {
    method: "PATCH",
    body: JSON.stringify({ active: false }),
  });

  if (!updated || updated.length === 0) {
    await sendMessage(chatId, `#${id} numaralı, sana ait aktif bir rota bulunamadı.`);
    return;
  }
  await sendMessage(chatId, `🗑️ #${id} takipten çıkarıldı.`);
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 200, body: "ok" };
    }

    const update = JSON.parse(event.body || "{}");
    const message = update.message;
    if (!message || !message.text) {
      return { statusCode: 200, body: "ok" };
    }

    const chatId = message.chat.id;

    // Güvenlik: sadece senin sohbetinden gelen komutlar işlenir
    if (ALLOWED_CHAT_ID && String(chatId) !== String(ALLOWED_CHAT_ID)) {
      await sendMessage(chatId, "Bu bot sadece belirli bir kullanıcı için çalışıyor.");
      return { statusCode: 200, body: "ok" };
    }

    const parts = message.text.trim().split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

    if (command === "/start" || command === "/yardim" || command === "/help" || command === "/komutlar") {
      await sendMessage(chatId, HELP_TEXT);
    } else if (command === "/ekle") {
      await handleEkle(chatId, args);
    } else if (command === "/listele") {
      await handleListele(chatId);
    } else if (command === "/sil") {
      await handleSil(chatId, args);
    } else {
      await sendMessage(chatId, "Anlaşılmayan komut. /yardim yazarak komutları görebilirsin.");
    }

    return { statusCode: 200, body: "ok" };
  } catch (err) {
    console.error(err);
    return { statusCode: 200, body: "ok" }; // Telegram'a her zaman 200 dön, yoksa webhook'u tekrar dener
  }
};
