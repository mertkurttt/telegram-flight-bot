"""
Takip edilen tüm rotaların fiyatını kontrol eder.
Fiyat, o rota için görülen en düşük fiyatın altına düşerse Telegram'a bildirim gönderir.

Bu script GitHub Actions tarafından saatte bir otomatik çalıştırılır (bkz. .github/workflows/check_prices.yml).
Gerekli ortam değişkenleri (GitHub Secrets üzerinden gelir):
  SUPABASE_URL
  SUPABASE_SERVICE_KEY
  TELEGRAM_BOT_TOKEN
"""

import os
import sys
import traceback
from urllib.parse import quote

import requests
from fast_flights import FlightData, Passengers, get_flights

CURRENCY = "TRY"  # Fiyatlar Türk Lirası olarak istenir

# fast-flights'ın iç fetch fonksiyonuna "yama" yaparak iki şey yapıyoruz:
# 1) Google'ın AB bölgesi "kullanım şartlarını kabul et" sayfasına takılmayı önlüyoruz
# 2) Fiyatların Türk Lirası (TRY) cinsinden gelmesini sağlıyoruz
# (resmi API bunları desteklemiyor, bu yüzden kütüphanenin içine doğrudan giriyoruz)
import fast_flights.core as _ff_core
from fast_flights.primp import Client as _PrimpClient


def _fetch_with_consent(params, timeout: int = 30):
    params = {**params, "curr": CURRENCY}  # Google'ın "En iyi" listesindeki en düşük fiyatı kullanıyoruz
    client = _PrimpClient(
        impersonate="chrome_126",
        verify=False,
        timeout=timeout,
        cookies={"CONSENT": "YES+"},
    )
    res = client.get("https://www.google.com/travel/flights", params=params)
    assert res.status_code == 200, f"{res.status_code} Result: {res.text_markdown}"
    return res


_ff_core.fetch = _fetch_with_consent

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
TELEGRAM_BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]

TELEGRAM_API = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"

HEADERS = {
    "apikey": SUPABASE_SERVICE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
    "Content-Type": "application/json",
}


def send_telegram_message(chat_id, text):
    try:
        requests.post(
            f"{TELEGRAM_API}/sendMessage",
            json={"chat_id": chat_id, "text": text, "parse_mode": "HTML"},
            timeout=15,
        )
    except requests.RequestException as e:
        print(f"Telegram mesajı gönderilemedi: {e}")


def get_active_routes():
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/routes",
        headers=HEADERS,
        params={"active": "eq.true"},
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def update_route(route_id, fields):
    resp = requests.patch(
        f"{SUPABASE_URL}/rest/v1/routes",
        headers={**HEADERS, "Prefer": "return=minimal"},
        params={"id": f"eq.{route_id}"},
        json=fields,
        timeout=15,
    )
    resp.raise_for_status()


def insert_price_history(route_id, price, currency, is_direct):
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/price_history",
        headers={**HEADERS, "Prefer": "return=minimal"},
        json={"route_id": route_id, "price": price, "currency": currency, "is_direct": is_direct},
        timeout=15,
    )
    resp.raise_for_status()


def _parse_price(raw_price):
    price_str = str(raw_price).replace(",", "").strip()
    digits = "".join(ch for ch in price_str if ch.isdigit() or ch == ".")
    if not digits:
        return None
    try:
        return float(digits)
    except ValueError:
        return None


def build_google_flights_link(route):
    """Kullanıcının fiyatı kendi gözüyle doğrulayıp bilet alabileceği Google Flights linki."""
    if route.get("return_date"):
        query = (
            f"Flights from {route['origin']} to {route['destination']} "
            f"on {route['depart_date']} through {route['return_date']}"
        )
    else:
        query = f"Flights from {route['origin']} to {route['destination']} on {route['depart_date']}"
    return "https://www.google.com/travel/flights?q=" + quote(query)


def fetch_prices(route):
    """fast-flights ile Google Flights'tan fiyatları çeker.
    Direkt ve aktarmalı uçuşların en ucuzunu ayrı ayrı döner.
    Herhangi biri yoksa None olarak döner.
    Dönüş: (direct_price, connecting_price, currency)
    """
    flight_legs = [
        FlightData(
            date=route["depart_date"],
            from_airport=route["origin"],
            to_airport=route["destination"],
        )
    ]
    trip = "one-way"
    if route.get("return_date"):
        flight_legs.append(
            FlightData(
                date=route["return_date"],
                from_airport=route["destination"],
                to_airport=route["origin"],
            )
        )
        trip = "round-trip"

    result = get_flights(
        flight_data=flight_legs,
        trip=trip,
        seat="economy",
        passengers=Passengers(adults=1, children=0, infants_in_seat=0, infants_on_lap=0),
    )

    direct_prices = []
    connecting_prices = []

    for f in result.flights:
        price = _parse_price(f.price)
        if price is None:
            continue
        stops = getattr(f, "stops", None)
        if stops == 0:
            direct_prices.append(price)
        elif stops is not None and stops > 0:
            connecting_prices.append(price)
        # stops bilgisi hiç yoksa (nadir), o sonucu ne direkte ne aktarmalıya sayıyoruz

    if not direct_prices and not connecting_prices:
        raise ValueError("Sonuçlarda geçerli bir fiyat bulunamadı")

    currency = CURRENCY
    return (
        min(direct_prices) if direct_prices else None,
        min(connecting_prices) if connecting_prices else None,
        currency,
    )


def _handle_category(route, chat_id, trip_desc, currency, label, price, lowest, field_name, fields, link):
    """Bir kategori (direkt/aktarmalı) için: geçmişe kaydet, düşüş varsa bildir, fields'ı güncelle."""
    route_id = route["id"]
    if price is None:
        return  # bu kategoride hiç sonuç yoktu (örn. o rotada aktarmalı uçuş çıkmadı)

    insert_price_history(route_id, price, currency, is_direct=(field_name == "lowest_price_direct"))

    price_label = "toplam (gidiş-dönüş, Google'ın 'En iyi' listesine göre)" if route.get("return_date") else "fiyat (Google'ın 'En iyi' listesine göre)"

    if lowest is None:
        fields[field_name] = price
        print(f"[#{route_id}] İlk {label} fiyatı kaydedildi: {price} {currency}")
        send_telegram_message(
            chat_id,
            f"📌 Takip başladı ({label})\n{trip_desc}\nİlk görülen {price_label}: {price} {currency}\n\n🔗 Doğrula ve satın al: {link}",
        )
    elif price < float(lowest):
        fields[field_name] = price
        print(f"[#{route_id}] {label} fiyat düştü: {lowest} -> {price} {currency}")
        send_telegram_message(
            chat_id,
            f"🔔 Fiyat düştü! ({label})\n{trip_desc}\nÖnceki en düşük: {lowest} {currency}\nYeni {price_label}: {price} {currency}\n\n🔗 Doğrula ve satın al: {link}",
        )
    else:
        print(f"[#{route_id}] {label}: değişiklik yok: {price} {currency} (en düşük: {lowest})")


def process_route(route):
    route_id = route["id"]
    chat_id = route["chat_id"]
    trip_desc = f"{route['origin']} → {route['destination']} ({route['depart_date']}" + (
        f" / {route['return_date']})" if route.get("return_date") else ", tek yön)"
    )

    try:
        direct_price, connecting_price, currency = fetch_prices(route)
    except Exception as e:
        print(f"[#{route_id}] Fiyat çekilemedi: {e}")
        update_route(route_id, {"last_error": str(e)[:500], "last_checked_at": "now()"})
        return

    fields = {"last_checked_at": "now()", "last_error": None, "currency": currency}
    link = build_google_flights_link(route)

    _handle_category(
        route, chat_id, trip_desc, currency, "direkt",
        direct_price, route.get("lowest_price_direct"), "lowest_price_direct", fields, link,
    )
    _handle_category(
        route, chat_id, trip_desc, currency, "aktarmalı",
        connecting_price, route.get("lowest_price_connecting"), "lowest_price_connecting", fields, link,
    )

    update_route(route_id, fields)


def main():
    routes = get_active_routes()
    print(f"{len(routes)} aktif rota bulundu.")

    had_error = False
    for route in routes:
        try:
            process_route(route)
        except Exception:
            had_error = True
            print(f"[#{route.get('id')}] Beklenmeyen hata:")
            traceback.print_exc()

    if had_error:
        sys.exit(1)  # GitHub Actions çalıştırmasını "başarısız" işaretle, böylece fark edilir


if __name__ == "__main__":
    main()
