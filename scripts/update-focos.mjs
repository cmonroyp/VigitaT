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

// Polígonos municipales oficiales (MGN DANE, los 47 municipios).
// Red de seguridad: la capa de veredas 2016 NO incluye a San Luis, así que un
// foco sin vereda se valida contra el límite municipal antes de descartarlo.
const MUNICIPIOS_POLI = JSON.parse(
  readFileSync(join(__dirname, '..', 'data', 'municipios-poligonos-tolima.geojson'), 'utf8'),
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

function municipioOficial(lat, lon) {
  for (const m of MUNICIPIOS_POLI) {
    if (m.geometry && dentroDePoligono(lat, lon, m.geometry)) {
      return titulo(m.properties.NOMBRE);
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
    // Sin vereda: puede ser un vacío de la capa de veredas (caso San Luis).
    // Se valida contra el polígono municipal oficial antes de descartar.
    const mpio = municipioOficial(f.lat, f.lon);
    if (mpio) {
      f.vereda = null;
      const m = MUNICIPIOS.find((x) => sinTildes(x.nombre) === sinTildes(mpio));
      f.municipio = m ? m.nombre : mpio;
      if (m) f.distanciaKm = Math.round(distKm(f.lat, f.lon, m.lat, m.lon) * 10) / 10;
    } else {
      // Ahora sí: fuera del límite departamental oficial -> se descarta
      f.vereda = null;
      f.fueraDelTolima = true;
    }
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

// ==================================================== MOTOR DE INCIDENTES
// Agrupa detecciones a lo largo del tiempo en "incendios" con identidad,
// estado, duración y área estimada — como los sistemas profesionales
// (Watch Duty / INPE), pero 100% automático.

const INCENDIOS_FILE = join(__dirname, '..', 'data', 'incendios.json');
const RADIO_INCIDENTE_KM = 2.5; // una detección a menos de esto pertenece al incidente
const HORAS_SIN_SENAL = 6;      // sin detección nueva -> "sin señal reciente"
const HORAS_EXTINCION = 24;     // sin detección nueva -> se declara extinguido
const HORAS_RETIRO = 72;        // extinguido hace tanto -> sale del archivo
const HA_POR_PIXEL = 14;        // píxel VIIRS 375 m ≈ 14 ha

let registro = { incendios: [], secuencia: 0 };
if (existsSync(INCENDIOS_FILE)) {
  try {
    registro = JSON.parse(readFileSync(INCENDIOS_FILE, 'utf8'));
  } catch { /* se regenera */ }
}

const ahoraMs = Date.now();
const horasDesde = (iso) => (ahoraMs - Date.parse(iso)) / 3.6e6;

// celda de ~400 m para estimar área afectada (píxeles únicos del historial)
const celdaPx = (lat, lon) => `${Math.round(lat / 0.004)},${Math.round(lon / 0.004)}`;

// 1. Asignar cada foco de las últimas 24 h a un incidente existente o crear uno
for (const f of focosFinales) {
  let inc = registro.incendios.find(
    (i) => i.estado !== 'extinguido' && distKm(i.lat, i.lon, f.lat, f.lon) <= RADIO_INCIDENTE_KM,
  );
  if (!inc) {
    registro.secuencia += 1;
    inc = {
      id: `INC-${registro.secuencia}`,
      nombre: f.vereda ? `Incendio vereda ${f.vereda}` : `Incendio zona rural de ${f.municipio}`,
      municipio: f.municipio,
      vereda: f.vereda ?? null,
      lat: f.lat,
      lon: f.lon,
      estado: 'activo',
      inicioUtc: f.fechaUtc,
      ultimaDeteccionUtc: f.fechaUtc,
      deteccionesTotales: 0,
      maxFrp: null,
      confianzaMax: f.confianza,
      pixeles: [],
      alertas: { detectado: false, ultCrecimiento: 0, extinguido: false },
    };
    registro.incendios.push(inc);
  }
  // actualizar incidente con esta detección
  if (f.fechaUtc > inc.ultimaDeteccionUtc) inc.ultimaDeteccionUtc = f.fechaUtc;
  if (f.fechaUtc < inc.inicioUtc) inc.inicioUtc = f.fechaUtc;
  if ((f.frp ?? 0) > (inc.maxFrp ?? 0)) inc.maxFrp = f.frp;
  if (f.confianza === 'alta') inc.confianzaMax = 'alta';
  if (f.vereda && !inc.vereda) {
    inc.vereda = f.vereda;
    inc.nombre = `Incendio vereda ${f.vereda}`;
  }
  const px = celdaPx(f.lat, f.lon);
  if (!inc.pixeles.includes(px)) inc.pixeles.push(px);
  inc.focoIds = inc.focoIds ?? [];
  if (!inc.focoIds.includes(f.id)) {
    inc.focoIds.push(f.id);
    inc.deteccionesTotales += 1;
  }
}

// 2. Actualizar estados por tiempo sin señal
for (const inc of registro.incendios) {
  // La "última actividad" considera también la retroalimentación GOES
  // (el geoestacionario puede seguir viendo el fuego entre pasadas VIIRS)
  const ultimaActividad =
    inc.ultimaGoesUtc && inc.ultimaGoesUtc > inc.ultimaDeteccionUtc
      ? inc.ultimaGoesUtc
      : inc.ultimaDeteccionUtc;
  const h = horasDesde(ultimaActividad);
  if (inc.estado !== 'extinguido') {
    inc.estado = h <= HORAS_SIN_SENAL ? 'activo' : h <= HORAS_EXTINCION ? 'sin_senal' : 'extinguido';
  }
  // Área solo cuando hay >=2 píxeles distintos: con una única detección el
  // fuego puede ocupar cualquier fracción del píxel de 375 m — no se inventa.
  inc.areaEstimadaHa = inc.pixeles.length >= 2 ? inc.pixeles.length * HA_POR_PIXEL : null;
  inc.duracionHoras = Math.round((Date.parse(inc.ultimaDeteccionUtc) - Date.parse(inc.inicioUtc)) / 3.6e6);
}
// retirar extinguidos viejos
registro.incendios = registro.incendios.filter(
  (i) => i.estado !== 'extinguido' || horasDesde(i.ultimaDeteccionUtc) < HORAS_RETIRO,
);

// 3. Meteorología en el sitio de cada incendio activo (Open-Meteo, gratuito)
const RUMBOS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
const rumbo = (g) => RUMBOS[Math.round(((g % 360) / 45)) % 8];

async function clima(lat, lon) {
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m&timezone=America%2FBogota`;
    const c = (await (await fetch(u, { signal: AbortSignal.timeout(15_000) })).json()).current;
    if (!c) return null;
    const vientoHaciaGrados = (c.wind_direction_10m + 180) % 360;
    const riesgo =
      c.wind_speed_10m > 20 && c.relative_humidity_2m < 40 ? 'ALTO'
      : c.wind_speed_10m > 10 || c.relative_humidity_2m < 50 ? 'MODERADO'
      : 'BAJO';
    return {
      tempC: Math.round(c.temperature_2m),
      humedadPct: Math.round(c.relative_humidity_2m),
      vientoKmh: Math.round(c.wind_speed_10m),
      vientoHacia: rumbo(vientoHaciaGrados),
      riesgoPropagacion: riesgo,
    };
  } catch {
    return null;
  }
}

for (const inc of registro.incendios) {
  if (inc.estado === 'activo') inc.clima = await clima(inc.lat, inc.lon);
}

writeFileSync(
  INCENDIOS_FILE,
  JSON.stringify(
    {
      actualizadoUtc: new Date().toISOString(),
      activos: registro.incendios.filter((i) => i.estado === 'activo').length,
      incendios: registro.incendios,
      secuencia: registro.secuencia,
    },
    null,
    1,
  ) + '\n',
);
console.log(
  `Incidentes: ${registro.incendios.length} en seguimiento, ` +
  `${registro.incendios.filter((i) => i.estado === 'activo').length} activos.`,
);

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

// Alertas por INCIDENTE (no por detección suelta): nuevo incendio, crecimiento
// significativo y extinción. Máxima señal, mínimo ruido.

const SITE = process.env.SITE_URL || 'https://cmonroyp.github.io/VigitaT/';
const UMBRAL_CRECIMIENTO = 3; // detecciones nuevas para re-alertar un incendio

function fichaIncendio(inc) {
  const icono = inc.confianzaMax === 'alta' ? '🔴' : '🟠';
  const lugar = inc.vereda
    ? `${inc.municipio}, vereda ${inc.vereda}`
    : `zona rural de ${inc.municipio}`;
  let l =
    `${icono} ${inc.nombre.toUpperCase()} (${inc.id})\n` +
    `   📍 ${lugar}\n` +
    `   🕐 Primera detección: ${horaColombia(inc.inicioUtc)} · última: ${horaColombia(inc.ultimaDeteccionUtc)}\n` +
    (inc.areaEstimadaHa
      ? `   📏 Área afectada estimada: ~${inc.areaEstimadaHa} ha · ${inc.deteccionesTotales} detecciones satelitales`
      : `   📏 Extensión aún no estimable (${inc.deteccionesTotales} detección única de píxel de 375 m)`) +
    (inc.maxFrp ? ` · intensidad máx. ${Math.round(inc.maxFrp)} MW` : '');
  if (inc.clima) {
    l +=
      `\n   🌬️ Viento ${inc.clima.vientoKmh} km/h hacia el ${inc.clima.vientoHacia} · ` +
      `humedad ${inc.clima.humedadPct}% · ${inc.clima.tempC}°C\n` +
      `   ⚠️ Riesgo de propagación: ${inc.clima.riesgoPropagacion}`;
  }
  return l;
}

const mensajes = [];

for (const inc of registro.incendios) {
  inc.alertas = inc.alertas ?? { detectado: false, ultCrecimiento: 0, extinguido: false };

  if (!inc.alertas.detectado && inc.estado === 'activo') {
    // Etiqueta honesta: "nuevo" solo si el inicio es reciente; si el incidente
    // lleva horas (o se reactivó), se anuncia como incendio activo en curso.
    const horasDesdeInicio = horasDesde(inc.inicioUtc);
    const titulo =
      horasDesdeInicio <= 2 ? '🔥 NUEVO INCENDIO DETECTADO' : '🔥 INCENDIO ACTIVO EN SEGUIMIENTO';
    mensajes.push(`${titulo}\n\n${fichaIncendio(inc)}`);
    inc.alertas.detectado = true;
    inc.alertas.ultCrecimiento = inc.deteccionesTotales;
  } else if (
    inc.alertas.detectado &&
    inc.estado === 'activo' &&
    inc.deteccionesTotales - inc.alertas.ultCrecimiento >= UMBRAL_CRECIMIENTO
  ) {
    mensajes.push(
      `📈 INCENDIO EN CRECIMIENTO\n\n${fichaIncendio(inc)}\n` +
      `   (+${inc.deteccionesTotales - inc.alertas.ultCrecimiento} detecciones desde el último aviso)`,
    );
    inc.alertas.ultCrecimiento = inc.deteccionesTotales;
  } else if (inc.estado === 'extinguido' && inc.alertas.detectado && !inc.alertas.extinguido) {
    mensajes.push(
      `✅ INCENDIO SIN ACTIVIDAD\n\n${inc.nombre} (${inc.id}) en ${inc.municipio}: ` +
      `sin detecciones satelitales en más de 24 h. ` +
      (inc.areaEstimadaHa ? `Área afectada estimada: ~${inc.areaEstimadaHa} ha. ` : '') +
      `Duración observada: ${inc.duracionHoras} h.`,
    );
    inc.alertas.extinguido = true;
  }
}

// persistir el estado de alertas actualizado
writeFileSync(
  INCENDIOS_FILE,
  JSON.stringify(
    {
      actualizadoUtc: new Date().toISOString(),
      activos: registro.incendios.filter((i) => i.estado === 'activo').length,
      incendios: registro.incendios,
      secuencia: registro.secuencia,
    },
    null,
    1,
  ) + '\n',
);

if (mensajes.length > 0 && BOT && CHAT) {
  const cuerpo =
    `🛰️ VigíaT — Seguimiento de incendios · Tolima\n` +
    `(hora local de Colombia)\n\n` +
    mensajes.join('\n\n———\n\n') +
    `\n\n🗺️ Mapa en vivo: ${SITE}\n` +
    `Fuente: NASA FIRMS (VIIRS/MODIS, 375 m) + meteorología Open-Meteo. ` +
    `Verifique en terreno. Emergencias: 119.`;
  const res = await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT, text: cuerpo.slice(0, 4090), disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15_000),
  });
  console.log(res.ok ? `Alerta enviada (${mensajes.length} incidente(s)).` : `Telegram falló: HTTP ${res.status}`);
} else if (mensajes.length > 0) {
  console.log(`${mensajes.length} novedades de incidentes sin Telegram configurado.`);
} else {
  console.log('Sin novedades de incidentes que alertar.');
}
