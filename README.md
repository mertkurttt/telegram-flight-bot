# Uçuş Fiyat Takip Botu

Telegram üzerinden rota eklersin (`/ekle IST BEG 2026-10-10 2026-10-16`), sistem saatte bir
Google Flights'tan fiyatı kontrol eder, fiyat düşerse sana Telegram'dan haber verir.

Teknik bilgin olmasa da adım adım aşağıdakileri takip ederek kurabilirsin. Her adım birkaç
dakika sürer.

## Genel bakış — parçalar

1. **Telegram Bot** — BotFather üzerinden ücretsiz oluşturulur.
2. **Supabase** — rotaları ve fiyat geçmişini saklayan veritabanı (zaten kullandığın hesap).
3. **Netlify Function** — Telegram'dan gelen komutları (`/ekle`, `/listele`, `/sil`) işler
   (zaten kullandığın Netlify hesabına eklenir).
4. **GitHub Actions** — saatte bir otomatik çalışıp fiyatları kontrol eder ve bildirim gönderir.

---

## 1. Telegram Botu Oluştur

1. Telegram'da **@BotFather**'ı bul, `/newbot` yaz.
2. Bot için bir isim ve kullanıcı adı belirle (kullanıcı adı `_bot` ile bitmeli).
3. BotFather sana bir **token** verecek (örn: `123456:ABC-DEF...`). Bunu bir yere not et —
   `TELEGRAM_BOT_TOKEN` olarak kullanacağız.
4. Kendi **chat ID**'ni öğrenmen lazım (bot sadece sana cevap versin diye). Telegram'da
   **@userinfobot**'a `/start` yaz, sana ID'ni verecek. Bunu not et — `ALLOWED_CHAT_ID`.

## 2. Supabase Tablolarını Oluştur

1. Supabase projenin Dashboard'una gir → **SQL Editor**.
2. Bu projedeki `supabase/schema.sql` dosyasının içeriğini yapıştır → **Run**.
3. **Project Settings > API** sayfasından şunları not et:
   - `Project URL` → `SUPABASE_URL`
   - `service_role` key (⚠️ `anon` key değil, `service_role` key — bu gizli kalmalı) → `SUPABASE_SERVICE_KEY`

## 3. Netlify Function'ı Yayınla

Bu projeyi (bu klasördeki tüm dosyaları) yeni bir GitHub deposuna yükle, sonra Netlify'de
"Add new site > Import an existing project" ile bu depoyu bağla — Denge'yi nasıl bağladıysan
aynı şekilde. Build ayarlarına dokunmana gerek yok, `netlify.toml` zaten gerekeni söylüyor.

Netlify'de site oluştuktan sonra:

1. **Site settings > Environment variables** kısmına şunları ekle:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
   - `TELEGRAM_BOT_TOKEN`
   - `ALLOWED_CHAT_ID`
2. Siteyi deploy et. Function'ın adresi şuna benzer olacak:
   `https://SENIN-SITEN.netlify.app/.netlify/functions/telegram-webhook`

### Telegram'a "bana mesajları buraya gönder" de (webhook kurulumu)

Tarayıcında şu adrese git (kendi bilgilerinle değiştirerek):

```
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://SENIN-SITEN.netlify.app/.netlify/functions/telegram-webhook
```

`{"ok":true,"result":true,...}` gibi bir cevap görürsen tamamdır — artık botuna yazdığın
her mesaj Netlify function'ına ulaşıyor.

## 4. GitHub Actions'ı Ayarla (saatlik kontrol)

1. Bu projeyi yüklediğin GitHub deposunda **Settings > Secrets and variables > Actions** kısmına git.
2. **New repository secret** ile şunları ekle:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
   - `TELEGRAM_BOT_TOKEN`
3. `.github/workflows/check_prices.yml` deponun içinde olduğu için GitHub otomatik olarak
   fark edip her saat başı çalıştıracak. İlk testi beklemek istemezsen: **Actions** sekmesi →
   "Uçuş Fiyat Kontrolü" → **Run workflow** ile elle bir kere tetikleyebilirsin.

## Kullanım

Telegram'da botuna şunları yazabilirsin:

```
/ekle IST BEG 2026-10-10 2026-10-16    → gidiş-dönüş rota ekler
/ekle IST BEG 2026-10-10               → tek yön rota ekler
/listele                                → takip edilen rotaları ve en düşük fiyatları gösterir
/sil 3                                  → 3 numaralı rotayı takipten çıkarır
/yardim                                 → komut listesini gösterir
```

## Bilinmesi Gerekenler / Sınırlamalar

- Fiyat verisi, Google Flights sayfasını okuyan açık kaynak bir kütüphaneden (`fast-flights`)
  geliyor — resmi bir API değil. Google sayfa yapısını değiştirirse kütüphane güncellenene kadar
  kontroller hata verebilir; `/listele` komutunda "Son kontrolde hata" notu görürsen bu yüzdendir.
- Saatlik kontrol, GitHub Actions'ın ücretsiz kotasında rahatça kalır (aylık ~720 çalıştırma,
  her biri 1-2 dakika sürer).
- Bot sadece senin `ALLOWED_CHAT_ID`'nden gelen komutları işler; başkası botuna yazsa bile
  rota ekleyemez.
- Fiyatlar tek yolcu / ekonomi sınıfı için hesaplanır. Farklı yolcu sayısı/sınıf istersen
  `scripts/check_prices.py` içindeki `Passengers(...)` ve `seat="economy"` satırlarını
  değiştirmen yeterli.
- Her rota için **direkt** ve **aktarmalı** uçuşların en düşük fiyatı ayrı ayrı takip edilir.
  Hangisi düşerse ondan bildirim gelir; `/listele` ikisini de gösterir. Bir rotada o kategoride
  hiç uçuş çıkmadıysa (örn. hiç direkt sefer yoksa) "henüz görülmedi" yazar.
