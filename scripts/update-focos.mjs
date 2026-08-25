/**
 * VigíaT — Actualizador de focos de calor (NASA FIRMS)
 *
 * Se ejecuta en GitHub Actions cada hora. Consulta la API de NASA FIRMS
 * para el bounding box del Tolima, filtra y agrupa los focos, los cruza
 * con el municipio más cercano y escribe data/focos.json.
 * Si hay focos NUEVOS respecto a la corrida anterior, envía alerta a Telegram.
 *
 * Requiere (GitHub Secrets — NUNCA en el código):
 *   FIRMS_MAP_KEY        clave gratuita de https://firms.modaps.eosdis.nasa.gov/api/map_key/
 *   TELEGRAM_BOT_TOKEN   (opcional) token del bot de alertas
 *   TELEGRAM_CHAT_ID     (opcional) id del canal/chat destino
 *
 * Node >= 20, sin dependencias externas (superficie de ataque mínima).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, '..', 'data', 'focos.json');

// Bounding box del departamento del Tolima (W, S, E, N)
const BBOX = '-76.2,2.8,-74.4,5.4';
// Fuentes satelitales consultadas (redundancia: VIIRS x2 + MODIS)
const SOURCES = ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'MODIS_NRT'];
const DAY_RANGE = 1; // últimas 24 h

const MAP_KEY = process.env.FIRMS_MAP_KEY;
if (!MAP_KEY || !/^[a-f0-9]{20,40}$/i.test(MAP_KEY)) {
  console.error('FIRMS_MAP_KEY ausente o con formato inválido.');
  process.exit(1);
}

// ---------------------------------------------------------------- utilidades

/** Parser CSV simple y estricto: solo campos sin comillas (formato FIRMS). */
function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row = {};
    headers.forEach((h, i) => (row[h] = (cells[i] ?? '').trim()));
    return row;
  });
}

/** Distancia haversine en km. */
function distKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Cabeceras municipales del Tolima (coordenadas aproximadas de referencia)
const MUNICIPIOS = JSON.parse(
  readFileSync(join(__dirname, '..', 'data', 'municipios-tolima.json'), 'utf8'),
);

function municipioCercano(lat, lon) {
  let best = null;
  let bestD = Infinity;
  for (const m of MUNICIPIOS) {
    const d = distKm(lat, lon, m.lat, m.lon);
    if (d < bestD) {
      bestD = d;
      best = m.nombre;
    }
  }
  return { municipio: best, distanciaKm: Math.round(bestD * 10) / 10 };
}

/** Normaliza la confianza: VIIRS usa l/n/h, MODIS usa 0-100. */
function nivelConfianza(raw) {
  const v = String(raw).toLowerCase();
  if (v === 'h' || v === 'high') return 'alta';
  if (v === 'n' || v === 'nominal') return 'media';
  if (v === 'l' || v === 'low') return 'baja';
  const n = Number(v);
  if (Number.isFinite(n)) return n >= 80 ? 'alta' : n >= 40 ? 'media' : 'baja';
  return 'media';
}

// --------------------------------------------------------------- descarga

async function fetchSource(source) {
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${MAP_KEY}/${source}/${BBOX}/${DAY_RANGE}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    console.warn(`FIRMS ${source}: HTTP ${res.status} — se omite esta fuente.`);
    return [];
  }
  const text = await res.text();
  if (text.startsWith('<') || /invalid/i.test(text.slice(0, 200))) {
    console.warn(`FIRMS ${source}: respuesta no válida — se omite.`);
    return [];
  }
  return parseCsv(text).map((r) => ({ ...r, __source: source }));
}

const raw = (await Promise.all(SOURCES.map(fetchSource))).flat();
console.log(`Registros crudos recibidos: ${raw.length}`);

// ------------------------------------------------------ validación y filtrado

const [W, S, E, N] = BBOX.split(',').map(Number);

let focos = raw
  .map((r) => {
    const lat = Number(r.latitude);
    const lon = Number(r.longitude);
    const fecha = String(r.acq_date ?? '');
    const hora = String(r.acq_time ?? '').padStart(4, '0');
    return {
      lat,
      lon,
      fechaUtc: /^\d{4}-\d{2}-\d{2}$/.test(fecha)
        ? `${fecha}T${hora.slice(0, 2)}:${hora.slice(2)}:00Z`
        : null,
      confianza: nivelConfianza(r.confidence),
      brillo: Number(r.bright_ti4 ?? r.brightness) || null,
      frp: Number(r.frp) || null, // Fire Radiative Power (MW)
      satelite: r.__source.startsWith('VIIRS') ? 'VIIRS' : 'MODIS',
      diaNoche: r.daynight === 'N' ? 'noche' : 'día',
    };
  })
  // Validación estricta: descarta cualquier registro fuera de rango o malformado
  .filter(
    (f) =>
      Number.isFinite(f.lat) &&
      Number.isFinite(f.lon) &&
      f.lat >= S && f.lat <= N &&
      f.lon >= W && f.lon <= E &&
      f.fechaUtc !== null,
  )
  // Descarta confianza baja para reducir falsos positivos
  .filter((f) => f.confianza !== 'baja');

// ------------------------------------------- agrupación (clúster ~1.5 km)

const CLUSTER_KM = 1.5;
const clusters = [];
for (const f of focos) {
  const c = clusters.find((cl) => distKm(cl.lat, cl.lon, f.lat, f.lon) <= CLUSTER_KM);
  if (c) {
    c.detecciones += 1;
    c.frp = Math.max(c.frp ?? 0, f.frp ?? 0) || null;
    if (f.confianza === 'alta') c.confianza = 'alta';
    if (f.fechaUtc > c.fechaUtc) c.fechaUtc = f.fechaUtc;
    c.satelites.add(f.satelite);
  } else {
    clusters.push({ ...f, detecciones: 1, satelites: new Set([f.satelite]) });
  }
}

const focosFinales = clusters
  .map((c) => {
    const cerca = municipioCercano(c.lat, c.lon);
    return {
      id: `${c.fechaUtc}_${c.lat.toFixed(3)}_${c.lon.toFixed(3)}`,
      lat: Math.round(c.lat * 1e4) / 1e4,
      lon: Math.round(c.lon * 1e4) / 1e4,
      fechaUtc: c.fechaUtc,
      confianza: c.confianza,
      frp: c.frp,
      detecciones: c.detecciones,
      satelites: [...c.satelites],
      diaNoche: c.diaNoche,
      ...cerca,
    };
  })
  .sort((a, b) => (a.fechaUtc < b.fechaUtc ? 1 : -1));

console.log(`Focos tras filtrado y agrupación: ${focosFinales.length}`);

// ---------------------------------------- vereda oficial (polígonos DANE)
// Cruce punto-en-polígono contra las 1862 veredas oficiales del Tolima
// (DANE, data/veredas-tolima.geojson). Sin servicios externos: datos reales,
// deterministas y verificables.

const VEREDAS = JSON.parse(
  readFileSync(join(__dirname, '..', 'data', 'veredas-tolima.geojson'), 'utf8'),
).features;

/** Ray casting: ¿el punto está dentro del anillo? */
function dentroDeAnillo(lat, lon, anillo) {
  let dentro = false;
  for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
    const [xi, yi] = anillo[i];
    const [xj, yj] = anillo[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}

function dentroDePoligono(lat, lon, geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys) {
    // primer anillo = exterior; los demás son huecos
    if (dentroDeAnillo(lat, lon, poly[0]) && !poly.slice(1).some((h) => dentroDeAnillo(lat, lon, h)))
      return true;
  }
  return false;
}

const titulo = (s) =>
  String(s).toLowerCase().replace(/(^|[\s(])\p{L}/gu, (c) => c.toUpperCase());

const sinTildes = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

function veredaOficial(lat, lon) {
  for (const v of VEREDAS) {
    if (!v.geometry) continue;
    if (dentroDePoligono(lat, lon, v.geometry)) {
      return {
        vereda: titulo(v.properties.NOMBRE_VER),
        municipioDane: titulo(v.properties.NOMB_MPIO),
        codigoVereda: v.properties.CODIGO_VER,
      };
    }
  }
  return null;
}

for (const f of focosFinales) {
  const v = veredaOficial(f.lat, f.lon);
  if (v) {
    f.vereda = v.vereda === 'Sin Informacion' ? null : v.vereda;
    f.codigoVereda = v.codigoVereda;
    // El municipio del polígono DANE es el oficial; se corrige si difiere
    const m = MUNICIPIOS.find((x) => sinTildes(x.nombre) === sinTildes(v.municipioDane));
    if (m && m.nombre !== f.municipio) {
      f.municipio = m.nombre;
      f.distanciaKm = Math.round(distKm(f.lat, f.lon, m.lat, m.lon) * 10) / 10;
    } else if (!m) {
      f.municipio = v.municipioDane;
    }
  } else {
    // Punto fuera de los polígonos del Tolima (franja limítrofe): se descarta luego
    f.vereda = null;
    f.fueraDelTolima = true;
  }
}

// Con polígonos oficiales podemos descartar con certeza lo que no es Tolima
const antesDescarte = focosFinales.length;
for (let i = focosFinales.length - 1; i >= 0; i--) {
  if (focosFinales[i].fueraDelTolima) focosFinales.splice(i, 1);
}
if (antesDescarte !== focosFinales.length) {
  console.log(`Descartados ${antesDescarte - focosFinales.length} focos fuera del Tolima (polígono oficial DANE).`);
}

// ----------------------------------------------------- detección de novedades
// IMPORTANTE: se calcula DESPUÉS del cruce DANE, para que los focos descartados
// (fuera del Tolima) nunca cuenten como "nuevos" ni generen alertas repetidas.

let anteriores = new Set();
if (existsSync(DATA_FILE)) {
  try {
    const prev = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
    anteriores = new Set((prev.focos ?? []).map((f) => f.id));
  } catch {
    /* archivo anterior corrupto: se regenera */
  }
}
const nuevos = focosFinales.filter((f) => !anteriores.has(f.id));

// -------------------------------------------------------------- escritura

const salida = {
  actualizadoUtc: new Date().toISOString(),
  region: 'Tolima, Colombia',
  ventanaHoras: DAY_RANGE * 24,
  totalFocos: focosFinales.length,
  focosNuevos: nuevos.length,
  fuentes: SOURCES,
  focos: focosFinales,
};
writeFileSync(DATA_FILE, JSON.stringify(salida, null, 2) + '\n');
console.log(`data/focos.json actualizado. Nuevos: ${nuevos.length}`);

// ---------------------------------------------------------- alerta Telegram

const BOT = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;

const horaColombia = (iso) =>
  new Date(iso).toLocaleString('es-CO', {
    timeZone: 'America/Bogota',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

if (nuevos.length > 0 && BOT && CHAT) {
  // Agrupar por municipio y ordenar: primero los municipios con mayor severidad
  const porMunicipio = new Map();
  for (const f of nuevos) {
    if (!porMunicipio.has(f.municipio)) porMunicipio.set(f.municipio, []);
    porMunicipio.get(f.municipio).push(f);
  }
  const severidad = (fs) =>
    Math.max(...fs.map((f) => (f.confianza === 'alta' ? 1000 : 0) + (f.frp ?? 0)));
  const grupos = [...porMunicipio.entries()].sort((a, b) => severidad(b[1]) - severidad(a[1]));

  const bloques = grupos.slice(0, 6).map(([municipio, fs]) => {
    fs.sort((a, b) => (b.frp ?? 0) - (a.frp ?? 0));
    const icono = fs.some((f) => f.confianza === 'alta') ? '🔴' : '🟠';
    const titulo = `${icono} ${municipio.toUpperCase()} — ${fs.length} foco${fs.length > 1 ? 's' : ''}`;
    const detalle = fs
      .slice(0, 4)
      .map((f) => {
        const lugar = f.vereda ? `vereda ${f.vereda}` : `a ${f.distanciaKm} km de la cabecera`;
        const intensidad = f.frp ? ` · ${Math.round(f.frp)} MW` : '';
        return `   • ${lugar} — ${horaColombia(f.fechaUtc)}${intensidad}`;
      })
      .join('\n');
    const mas = fs.length > 4 ? `\n   • …y ${fs.length - 4} más en este municipio` : '';
    return `${titulo}\n${detalle}${mas}`;
  });
  const otros = grupos.length > 6 ? `\n\n…y ${grupos.length - 6} municipios más (ver mapa).` : '';

  const SITE = process.env.SITE_URL || 'https://cmonroyp.github.io/VigitaT/';
  const msg =
    `🛰️ VigíaT — Focos de calor confirmados por satélite\n` +
    `${nuevos.length} foco(s) nuevo(s) en ${grupos.length} municipio(s) del Tolima ` +
    `(hora local):\n\n` +
    bloques.join('\n\n') + otros +
    `\n\n🗺️ Mapa en vivo: ${SITE}\n` +
    `Fuente: NASA FIRMS (VIIRS/MODIS, píxel 375 m). Un foco puede ser quema controlada: ` +
    `verifique en terreno. Emergencias: 119.`;

  const res = await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT, text: msg, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15_000),
  });
  console.log(res.ok ? 'Alerta Telegram enviada.' : `Telegram falló: HTTP ${res.status}`);
} else if (nuevos.length > 0) {
  console.log('Hay focos nuevos pero Telegram no está configurado (opcional).');
}
