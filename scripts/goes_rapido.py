#!/usr/bin/env python3
"""
VigíaT v2 — Detección RÁPIDA de incendios con GOES-19 (geoestacionario).

GOES-East escanea todo el continente cada 10 minutos. Este script descarga el
último producto de detección de incendios (ABI L2 FDCF, NOAA Open Data en AWS,
gratuito y sin autenticación), extrae los píxeles de fuego, los proyecta a
lat/lon, filtra el Tolima con los polígonos oficiales del DANE y publica
data/focos-goes.json. Si hay detecciones nuevas envía alerta "rápida, por
confirmar" a Telegram.

Latencia total típica: 10–25 minutos desde que el fuego es visible.
Resolución del píxel GOES sobre Colombia: ~2 km (por eso las alertas GOES son
preliminares; VIIRS las confirma después con vereda exacta).

Sin credenciales de AWS: bucket público noaa-goes19 vía HTTPS.
Requiere: numpy, netCDF4. Secrets opcionales: TELEGRAM_BOT_TOKEN/CHAT_ID.
"""

import json
import math
import os
import re
import sys
import tempfile
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import netCDF4

RAIZ = Path(__file__).resolve().parent.parent
ARCHIVO_SALIDA = RAIZ / "data" / "focos-goes.json"
ARCHIVO_VEREDAS = RAIZ / "data" / "veredas-tolima.geojson"
ARCHIVO_MUNICIPIOS = RAIZ / "data" / "municipios-poligonos-tolima.geojson"

BUCKET = "https://noaa-goes19.s3.amazonaws.com"
PRODUCTO = "ABI-L2-FDCF"  # Fire Detection & Characterization, Full Disk, cada 10 min

# Bounding box del Tolima (W, S, E, N) — prefiltro antes del polígono oficial
BBOX = (-76.2, 2.8, -74.4, 5.4)

# Códigos del Fire Mask GOES (GOES-R PUG L2):
#   10/30 = fuego procesado, 11/31 = píxel saturado (fuego intenso),
#   13/33 = probabilidad alta, 14/34 = probabilidad media.
# Se EXCLUYEN 15/35 (probabilidad baja) y 12/32 (contaminado por nube)
# para minimizar falsas alarmas.
CODIGOS_FUEGO = {10, 11, 13, 14, 30, 31, 33, 34}
CODIGOS_ALTA = {10, 11, 30, 31}

# No repetir alerta del mismo punto (~2 km) durante esta ventana
COOLDOWN_HORAS = 6


# ----------------------------------------------------------- descarga del scan

def listar(prefijo: str) -> list[str]:
    url = f"{BUCKET}/?list-type=2&prefix={urllib.parse.quote(prefijo)}"
    with urllib.request.urlopen(url, timeout=30) as r:
        xml = r.read().decode()
    return re.findall(r"<Key>([^<]+)</Key>", xml)


def ultimo_archivo() -> str | None:
    """Busca el archivo FDCF más reciente (hora actual UTC o la anterior)."""
    ahora = datetime.now(timezone.utc)
    for delta in (0, 1):
        t = ahora - timedelta(hours=delta)
        prefijo = f"{PRODUCTO}/{t.year}/{t.timetuple().tm_yday:03d}/{t.hour:02d}/"
        claves = sorted(listar(prefijo))
        if claves:
            return claves[-1]
    return None


# ------------------------------------- proyección ABI fixed grid -> lat/lon
# Fórmulas oficiales del GOES-R Product User Guide (Vol. 3, sec. 5.1.2)

def grilla_a_latlon(x, y, nc):
    proj = nc.variables["goes_imager_projection"]
    r_eq = proj.semi_major_axis
    r_pol = proj.semi_minor_axis
    H = proj.perspective_point_height + r_eq
    lon0 = math.radians(proj.longitude_of_projection_origin)

    sinx, cosx = np.sin(x), np.cos(x)
    siny, cosy = np.sin(y), np.cos(y)
    a = sinx**2 + cosx**2 * (cosy**2 + (r_eq**2 / r_pol**2) * siny**2)
    b = -2.0 * H * cosx * cosy
    c = H**2 - r_eq**2
    disc = b**2 - 4 * a * c
    valid = disc >= 0
    rs = np.where(valid, (-b - np.sqrt(np.abs(disc))) / (2 * a), np.nan)

    sx = rs * cosx * cosy
    sy = -rs * sinx
    sz = rs * cosx * siny
    lat = np.degrees(np.arctan((r_eq**2 / r_pol**2) * sz / np.sqrt((H - sx) ** 2 + sy**2)))
    lon = np.degrees(lon0 - np.arctan(sy / (H - sx)))
    return lat, lon


# --------------------------------------------- vereda oficial (polígonos DANE)

def cargar_veredas():
    with open(ARCHIVO_VEREDAS, encoding="utf-8") as f:
        return json.load(f)["features"]


def dentro_anillo(lat, lon, anillo):
    dentro = False
    j = len(anillo) - 1
    for i in range(len(anillo)):
        xi, yi = anillo[i][0], anillo[i][1]
        xj, yj = anillo[j][0], anillo[j][1]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            dentro = not dentro
        j = i
    return dentro


def buscar_vereda(lat, lon, veredas):
    for v in veredas:
        g = v.get("geometry")
        if not g:
            continue
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        for poly in polys:
            if dentro_anillo(lat, lon, poly[0]) and not any(
                dentro_anillo(lat, lon, h) for h in poly[1:]
            ):
                p = v["properties"]
                return {
                    "municipio": p["NOMB_MPIO"].title(),
                    "vereda": None
                    if p["NOMBRE_VER"].upper() == "SIN INFORMACION"
                    else p["NOMBRE_VER"].title(),
                }
    return None  # sin vereda: validar contra polígono municipal


def cargar_municipios_poli():
    with open(ARCHIVO_MUNICIPIOS, encoding="utf-8") as f:
        return json.load(f)["features"]


def buscar_municipio(lat, lon, municipios_poli):
    """Respaldo con límites municipales MGN (la capa de veredas omite a San Luis)."""
    for m in municipios_poli:
        g = m.get("geometry")
        if not g:
            continue
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        for poly in polys:
            if dentro_anillo(lat, lon, poly[0]) and not any(
                dentro_anillo(lat, lon, h) for h in poly[1:]
            ):
                return {"municipio": m["properties"]["NOMBRE"].title(), "vereda": None}
    return None  # fuera del Tolima


# ---------------------------------------------------------------- procesar

def main() -> int:
    clave = ultimo_archivo()
    if not clave:
        print("No se encontró archivo GOES reciente.")
        return 0
    print("Procesando:", clave)

    with tempfile.NamedTemporaryFile(suffix=".nc", delete=False) as tmp:
        urllib.request.urlretrieve(f"{BUCKET}/{clave}", tmp.name)
        ruta_nc = tmp.name

    try:
        nc = netCDF4.Dataset(ruta_nc)
        mask = nc.variables["Mask"][:]  # fire mask full disk (5424x5424)
        power = nc.variables["Power"][:]  # FRP en MW (enmascarado donde no hay fuego)
        x = nc.variables["x"][:]
        y = nc.variables["y"][:]

        filas, cols = np.where(np.isin(mask, list(CODIGOS_FUEGO)))
        print(f"Píxeles de fuego en el disco completo: {len(filas)}")

        detecciones = []
        if len(filas):
            xv = np.asarray(x)[cols].astype(np.float64)
            yv = np.asarray(y)[filas].astype(np.float64)
            lat, lon = grilla_a_latlon(xv, yv, nc)
            W, S, E, N = BBOX
            for i in range(len(filas)):
                la, lo = float(lat[i]), float(lon[i])
                if not (S <= la <= N and W <= lo <= E) or math.isnan(la):
                    continue
                codigo = int(mask[filas[i], cols[i]])
                frp = power[filas[i], cols[i]]
                detecciones.append(
                    {
                        "lat": round(la, 4),
                        "lon": round(lo, 4),
                        "codigo": codigo,
                        "confianza": "alta" if codigo in CODIGOS_ALTA else "media",
                        "frp": None if np.ma.is_masked(frp) else round(float(frp), 1),
                    }
                )
        # hora del scan (del nombre del archivo: sYYYYDDDHHMMSSS)
        m = re.search(r"_s(\d{4})(\d{3})(\d{2})(\d{2})", clave)
        t = datetime(int(m[1]), 1, 1, int(m[3]), int(m[4]), tzinfo=timezone.utc) + timedelta(
            days=int(m[2]) - 1
        )
        escaneo_utc = t.strftime("%Y-%m-%dT%H:%M:00Z")
    finally:
        nc.close()
        os.unlink(ruta_nc)

    print(f"Detecciones en la caja del Tolima: {len(detecciones)}")

    # Cruce con polígonos oficiales: veredas primero, respaldo municipal después
    veredas = cargar_veredas()
    municipios_poli = cargar_municipios_poli()
    focos = []
    for d in detecciones:
        ubic = buscar_vereda(d["lat"], d["lon"], veredas) or buscar_municipio(
            d["lat"], d["lon"], municipios_poli
        )
        if ubic is None:
            continue
        focos.append({**d, **ubic, "escaneoUtc": escaneo_utc})
    print(f"Focos GOES dentro del Tolima: {len(focos)}")

    # -------- retroalimentar incidentes confirmados (seguimiento en tiempo real)
    # Si GOES ve fuego dentro del radio de un incidente que VIIRS ya confirmó,
    # se actualiza su "última actividad GOES": el incidente se mantiene ACTIVO
    # con seguimiento de ~10 min sin esperar la próxima pasada VIIRS.
    ARCHIVO_INCENDIOS = RAIZ / "data" / "incendios.json"
    RADIO_INCIDENTE_KM = 2.5

    def dist_km(lat1, lon1, lat2, lon2):
        rl1, rl2 = math.radians(lat1), math.radians(lat2)
        dlat = rl2 - rl1
        dlon = math.radians(lon2 - lon1)
        a = math.sin(dlat / 2) ** 2 + math.cos(rl1) * math.cos(rl2) * math.sin(dlon / 2) ** 2
        return 2 * 6371 * math.asin(math.sqrt(a))

    if focos and ARCHIVO_INCENDIOS.exists():
        try:
            reg = json.loads(ARCHIVO_INCENDIOS.read_text(encoding="utf-8"))
            tocados = 0
            for inc in reg.get("incendios", []):
                if inc.get("estado") == "extinguido":
                    continue
                for f in focos:
                    if dist_km(inc["lat"], inc["lon"], f["lat"], f["lon"]) <= RADIO_INCIDENTE_KM:
                        inc["ultimaGoesUtc"] = escaneo_utc
                        inc["estado"] = "activo"
                        tocados += 1
                        break
            if tocados:
                reg["actualizadoUtc"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                reg["activos"] = sum(1 for i in reg.get("incendios", []) if i.get("estado") == "activo")
                ARCHIVO_INCENDIOS.write_text(
                    json.dumps(reg, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
                )
                print(f"Incidentes retroalimentados por GOES: {tocados}")
        except Exception as e:
            print("No se pudo retroalimentar incidentes:", e)

    # --------- estado anterior: para detectar novedades y aplicar cooldown
    previo = {"alertadas": {}}
    if ARCHIVO_SALIDA.exists():
        try:
            previo = json.loads(ARCHIVO_SALIDA.read_text(encoding="utf-8"))
        except Exception:
            pass
    alertadas = previo.get("alertadas", {})

    # celda ~2 km para dedup (redondeo a 0.02°)
    def celda(f):
        return f"{round(f['lat'] / 0.02) * 0.02:.2f},{round(f['lon'] / 0.02) * 0.02:.2f}"

    ahora = datetime.now(timezone.utc)
    limite = ahora - timedelta(hours=COOLDOWN_HORAS)
    # limpia celdas viejas
    alertadas = {
        c: t for c, t in alertadas.items() if datetime.fromisoformat(t) > limite
    }
    nuevos = [f for f in focos if celda(f) not in alertadas]
    for f in nuevos:
        alertadas[celda(f)] = ahora.isoformat()

    salida = {
        "actualizadoUtc": ahora.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "escaneoUtc": escaneo_utc,
        "satelite": "GOES-19 (geoestacionario, escaneo cada 10 min)",
        "resolucionKm": 2,
        "totalFocos": len(focos),
        "focosNuevos": len(nuevos),
        "focos": focos,
        "alertadas": alertadas,
    }
    ARCHIVO_SALIDA.write_text(json.dumps(salida, ensure_ascii=False, indent=1), encoding="utf-8")
    print("data/focos-goes.json actualizado. Nuevos:", len(nuevos))

    # ----------------------------------------------------------- Telegram
    bot = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat = os.environ.get("TELEGRAM_CHAT_ID")
    if nuevos and bot and chat:
        # Se listan TODAS las detecciones (ordenadas por intensidad) — en un canal
        # de alertas ningún foco debe quedar oculto tras un "…y N más".
        ordenados = sorted(nuevos, key=lambda f: f.get("frp") or 0, reverse=True)
        lineas = []
        for f in ordenados[:25]:
            lugar = f["municipio"] + (f", vereda {f['vereda']}" if f["vereda"] else "")
            icono = "🔴" if f["confianza"] == "alta" else "🟠"
            frp = f" · {round(f['frp'])} MW" if f.get("frp") else ""
            lineas.append(f"{icono} {lugar}{frp}")
        extra = f"\n…y {len(nuevos) - 25} más (ver mapa)." if len(nuevos) > 25 else ""
        # hora local de Colombia (UTC-5, sin horario de verano)
        t_scan = datetime.strptime(escaneo_utc, "%Y-%m-%dT%H:%M:00Z") - timedelta(hours=5)
        hora_scan = t_scan.strftime("%I:%M %p").lstrip("0").lower().replace("am", "a. m.").replace("pm", "p. m.")
        sitio = os.environ.get("SITE_URL") or "https://cmonroyp.github.io/VigitaT/"
        msg = (
            "⚡ VigíaT — DETECCIÓN RÁPIDA (GOES)\n"
            f"{len(nuevos)} posible(s) incendio(s) detectado(s) hace minutos "
            f"(escaneo {hora_scan}, hora Colombia):\n\n" + "\n".join(lineas) + extra + "\n"
            "(🔴 certeza alta · 🟠 probable · MW = intensidad del fuego)\n\n"
            "⚠️ Detección preliminar de ~2 km de resolución, POR CONFIRMAR. "
            "Si está en la zona, verifique y reporte al 119.\n"
            f"🗺️ Mapa: {sitio}"
        )
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{bot}/sendMessage",
            data=json.dumps(
                {"chat_id": chat, "text": msg, "disable_web_page_preview": True}
            ).encode(),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                print("Alerta rápida enviada." if r.status == 200 else f"Telegram: {r.status}")
        except Exception as e:
            print("Telegram falló:", e)
    elif nuevos:
        print("Focos nuevos sin Telegram configurado.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
