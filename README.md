# 🛰️ VigíaT — Alerta satelital de incendios · Tolima, Colombia

**VigíaT** es una plataforma de **costo cero** que detecta focos de calor e incendios en el
departamento del Tolima usando datos satelitales abiertos de la **NASA (FIRMS — VIIRS/MODIS)**,
los muestra en un mapa en vivo y envía **alertas automáticas por Telegram** a comunidades,
bomberos y alcaldías.

> ⚠️ Un foco de calor detectado por satélite no siempre es un incendio (puede ser una quema
> agrícola u otra fuente térmica). VigíaT es una herramienta de **alerta temprana**, no
> reemplaza la verificación en terreno ni los canales oficiales de emergencia
> (Bomberos **119** · Defensa Civil **144** · Emergencias **123**).

## Cómo funciona

VigíaT usa **dos niveles de detección complementarios**:

| Nivel | Satélite | Frecuencia | Latencia | Resolución | Rol |
|---|---|---|---|---|---|
| ⚡ Rápido | NOAA GOES-19 (geoestacionario) | cada 10 min | **10–25 min** | ~2 km | Alerta temprana preliminar |
| 🎯 Preciso | NASA VIIRS/MODIS (órbita polar) | 4–6 pasadas/día | 1–3 h | 375 m | Confirmación con vereda exacta |

```
NOAA GOES-19 (AWS Open Data)          NASA FIRMS (VIIRS + MODIS)
        │  cada 10 min                        │  cada hora
        ▼                                     ▼
scripts/goes_rapido.py                (pipeline de precisión)
  · píxeles de fuego del último escaneo
  · proyección a lat/lon + cruce veredas DANE
  · alerta "⚡ DETECCIÓN RÁPIDA, por confirmar"
        ▼
scripts/update-focos.mjs
  · valida y filtra registros (descarta confianza baja)
  · agrupa detecciones cercanas (~1.5 km = mismo incendio)
  · cruce punto-en-polígono con las 1.862 veredas oficiales del DANE
    → municipio y vereda EXACTOS; descarta focos fuera del Tolima
        ▼
data/focos.json  ──►  Mapa web (GitHub Pages + Leaflet)
        │
        └─►  ¿Focos nuevos? ──►  Alerta al canal de Telegram
```

**Seguimiento de incidentes (v3):** las detecciones se agrupan automáticamente en
*incendios* con identidad (`INC-N`), estado (activo → sin señal → sin actividad),
duración, **área afectada estimada** (píxeles satelitales únicos × 14 ha) y
**meteorología en el sitio** (viento, humedad y riesgo de propagación vía
Open-Meteo, gratuito). Las alertas de Telegram son por incidente: 🔥 nuevo,
📈 en crecimiento, ✅ sin actividad — máxima señal, mínimo ruido.

- **Sin servidores, sin base de datos, sin costos**: sitio estático + GitHub Actions.
- **Sin dependencias npm** en el pipeline; solo Leaflet (con SRI) en el frontend.
- Datos con desfase de **1 a 3 horas** respecto al paso del satélite.

## Puesta en marcha (15 minutos)

### 1. Clave gratuita de NASA FIRMS
Regístrate en <https://firms.modaps.eosdis.nasa.gov/api/map_key/> y copia tu `MAP_KEY`.

### 2. Crear el repositorio en GitHub
```bash
git init
git add .
git commit -m "VigíaT v1.0 — alerta satelital de incendios para el Tolima"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/vigia-tolima.git
git push -u origin main
```

### 3. Configurar secretos (Settings → Secrets and variables → Actions)
| Secreto | Obligatorio | Descripción |
|---|---|---|
| `FIRMS_MAP_KEY` | ✅ | Tu clave de NASA FIRMS |
| `TELEGRAM_BOT_TOKEN` | opcional | Token del bot (créalo con [@BotFather](https://t.me/BotFather)) |
| `TELEGRAM_CHAT_ID` | opcional | ID del canal público de alertas (ej. `@VigiaTolima`) |

Y una *variable* opcional `SITE_URL` con la URL pública del sitio.

### 4. Activar GitHub Pages
**Settings → Pages → Source: Deploy from a branch → `main` / `/ (root)`**.
El sitio quedará en `https://TU_USUARIO.github.io/vigia-tolima/`.

### 5. Primera ejecución
Pestaña **Actions → Actualizar focos de calor → Run workflow**. A partir de ahí corre solo, cada hora.

### Canal de Telegram (recomendado)
1. Crea un canal público (ej. `@VigiaTolima`) y un bot con @BotFather.
2. Agrega el bot como administrador del canal.
3. Configura los secretos del paso 3. Las alcaldías y comunidades solo tienen que unirse al canal:
   las alertas les llegan como notificación push, gratis.

## Estructura del proyecto

```
vigia-tolima/
├── index.html                      # Mapa y panel de alertas (CSP estricta, SRI)
├── assets/css/styles.css
├── assets/js/app.js                # Frontend: render seguro del JSON de focos
├── data/
│   ├── focos.json                  # Generado automáticamente cada hora
│   ├── municipios-tolima.json      # 47 cabeceras municipales (distancias)
│   └── veredas-tolima.geojson      # 1.862 veredas oficiales DANE (cruce exacto)
├── scripts/update-focos.mjs        # Pipeline de precisión VIIRS (Node, cero dependencias)
├── scripts/goes_rapido.py          # Detección rápida GOES-19 (Python, numpy+netCDF4)
├── .github/workflows/actualizar-focos.yml   # cada hora
├── .github/workflows/goes-rapido.yml        # cada 10 minutos
├── SECURITY.md                     # Modelo de amenazas y política de reportes
└── README.md
```

## Seguridad

Ver [SECURITY.md](SECURITY.md). Resumen: CSP estricta, SRI en el CDN, escape de todo dato
externo, secretos solo en GitHub Secrets, permisos mínimos en el workflow, cero dependencias
npm, sin recolección de datos personales.

## Hoja de ruta

- [ ] Migración opcional a **Azure Static Web Apps** (cuenta empresarial) manteniendo el mismo repo
- [ ] Histórico de focos por municipio y temporada
- [ ] Capa de viento/pronóstico (Open-Meteo, gratuito)
- [ ] Réplica para otros departamentos (el bounding box es configurable)

## Créditos y licencia

Datos: [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/) (uso libre con atribución) ·
Veredas: DANE — Marco Geoestadístico Nacional (datos abiertos) ·
Mapa base: [OpenStreetMap](https://www.openstreetmap.org/copyright) e imágenes Esri · Software: ver [LICENSE](LICENSE).
