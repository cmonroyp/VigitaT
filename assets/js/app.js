/**
 * VigíaT — Frontend del mapa de focos de calor.
 * Lee data/focos.json (generado por GitHub Actions) y lo pinta con Leaflet.
 * Seguridad: todo dato externo se trata como texto (textContent / escape),
 * nunca se interpola HTML sin sanear. Sin dependencias más allá de Leaflet.
 */
'use strict';

(() => {
  const DATA_URL = 'data/focos.json';
  const REFRESH_MS = 10 * 60 * 1000; // recarga el JSON cada 10 min

  // --- utilidades seguras -------------------------------------------------

  /** Escapa texto para inserción en HTML (defensa en profundidad). */
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));

  const el = (id) => document.getElementById(id);

  const horasDesde = (iso) => (Date.now() - Date.parse(iso)) / 3.6e6;

  const horaLocal = (iso) =>
    new Date(iso).toLocaleString('es-CO', {
      timeZone: 'America/Bogota',
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });

  /** Valida la estructura de un foco antes de usarlo. */
  const focoValido = (f) =>
    f &&
    Number.isFinite(f.lat) && f.lat >= 2 && f.lat <= 6 &&
    Number.isFinite(f.lon) && f.lon >= -77 && f.lon <= -74 &&
    typeof f.fechaUtc === 'string' && !Number.isNaN(Date.parse(f.fechaUtc));

  // --- mapa ---------------------------------------------------------------

  const map = L.map('map', { zoomControl: true, maxZoom: 19 }).setView([4.1, -75.25], 8);

  const capaCalles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    maxNativeZoom: 17,
    attribution: '&copy; OpenStreetMap · Datos: NASA FIRMS',
  });

  // Imagen satelital como capa por defecto (estilo FIRMS de la NASA)
  const capaSatelite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    {
      maxZoom: 19,
      attribution: 'Imágenes &copy; Esri · Datos: NASA FIRMS',
    },
  ).addTo(map);

  L.control.layers(
    { 'Imagen satelital': capaSatelite, 'Mapa de calles': capaCalles },
    null,
    { position: 'topright' },
  ).addTo(map);

  const capaFocos = L.layerGroup().addTo(map);
  const capaGoes = L.layerGroup().addTo(map);
  const marcadores = new Map();

  function pintarFocoGoes(f, escaneoUtc) {
    const esAlta = f.confianza === 'alta';
    const icono = L.divIcon({
      className: 'goes-icon',
      html: `<div class="goes-tri ${esAlta ? 'alta' : ''}">▲</div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });
    L.marker([f.lat, f.lon], { icon: icono })
      .bindPopup(
        `<strong>⚡ Detección rápida (GOES) — ${esc(f.municipio)}</strong><br>` +
        (f.vereda ? `Vereda aprox.: <strong>${esc(f.vereda)}</strong><br>` : '') +
        `Escaneo: ${esc(horaLocal(escaneoUtc))} (hora Colombia)<br>` +
        `Confianza: <strong>${esc(f.confianza)}</strong>` +
        (f.frp ? ` · Intensidad: ${esc(Math.round(f.frp))} MW` : '') + '<br>' +
        `<small>Satélite geoestacionario, resolución ~2 km. Detección preliminar ` +
        `POR CONFIRMAR por el satélite de precisión (VIIRS).</small>` +
        botonZoom(f.lat, f.lon),
      )
      .addTo(capaGoes);
    // área de incertidumbre del píxel GOES (~2 km)
    L.circle([f.lat, f.lon], {
      radius: 2000,
      color: '#ffcc00',
      weight: 1,
      dashArray: '4 4',
      fill: false,
      opacity: 0.5,
    }).addTo(capaGoes);
  }

  async function cargarGoes() {
    try {
      const res = await fetch(`data/focos-goes.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const g = await res.json();
      const focos = Array.isArray(g.focos) ? g.focos.filter(focoValido2km) : [];
      capaGoes.clearLayers();
      // solo escaneos de la última hora: GOES es "ahora", lo viejo no aporta
      if (Date.parse(g.escaneoUtc) > Date.now() - 3600e3) {
        focos.forEach((f) => pintarFocoGoes(f, g.escaneoUtc));
      }
      const bg = el('goesBanner');
      if (focos.length > 0 && Date.parse(g.escaneoUtc) > Date.now() - 3600e3) {
        const municipios = [...new Set(focos.map((f) => f.municipio))].slice(0, 4);
        bg.textContent =
          `⚡ DETECCIÓN RÁPIDA: el satélite GOES observó ${focos.length} posible(s) incendio(s) ` +
          `hace minutos cerca de: ${municipios.join(', ')}. Preliminar, por confirmar. Si está en la zona, llame al 119.`;
        bg.hidden = false;
      } else {
        bg.hidden = true;
      }
    } catch (err) {
      console.error('VigíaT: error cargando GOES', err);
    }
  }

  const focoValido2km = (f) =>
    f &&
    Number.isFinite(f.lat) && f.lat >= 2 && f.lat <= 6 &&
    Number.isFinite(f.lon) && f.lon >= -77 && f.lon <= -74;

  function pintarFoco(f) {
    const h = horasDesde(f.fechaUtc);
    const esAlta = f.confianza === 'alta';
    const color = esAlta ? '#ff3b30' : '#ff9500';
    const radio = Math.min(16, 6 + Math.sqrt(f.frp || 1) * 1.2);

    const marker = L.circleMarker([f.lat, f.lon], {
      color,
      fillColor: color,
      fillOpacity: h < 3 ? 0.85 : h < 12 ? 0.55 : 0.3,
      radius: radio,
      weight: 1.5,
    });

    marker.bindPopup(
      `<strong>🔥 Foco de calor — ${esc(f.municipio)}</strong><br>` +
      (f.vereda
        ? `Vereda: <strong>${esc(f.vereda)}</strong>` +
          (f.codigoVereda ? ` <small>(cód. DANE ${esc(f.codigoVereda)})</small>` : '') + '<br>'
        : '') +
      `Detectado: ${esc(horaLocal(f.fechaUtc))} (hora Colombia)<br>` +
      `Confianza: <strong>${esc(f.confianza)}</strong> · Satélite: ${esc((f.satelites || []).join(', '))}<br>` +
      (f.frp ? `Intensidad: ${esc(Math.round(f.frp))} MW<br>` : '') +
      `A ~${esc(f.distanciaKm)} km de la cabecera de ${esc(f.municipio)}<br>` +
      `<small>Detecciones agrupadas: ${esc(f.detecciones)} · ${esc(f.diaNoche)}</small>` +
      botonZoom(f.lat, f.lon),
    );
    marker.addTo(capaFocos);
    marcadores.set(f.id, marker);

    // Área de incertidumbre del píxel satelital (~375 m VIIRS): el fuego real
    // está en algún punto dentro de este círculo, no exactamente en el centro.
    L.circle([f.lat, f.lon], {
      radius: 375,
      color,
      weight: 1,
      dashArray: '4 4',
      fill: false,
      opacity: 0.6,
    }).addTo(capaFocos);
  }

  // --- panel lateral ------------------------------------------------------

  function pintarPanel(data, focos) {
    el('statTotal').textContent = String(focos.length);
    const altas = focos.filter((f) => f.confianza === 'alta');
    el('statAlta').textContent = String(altas.length);
    el('statMunicipios').textContent = String(new Set(focos.map((f) => f.municipio)).size);

    const lista = el('focoList');
    lista.replaceChildren();
    if (focos.length === 0) {
      const li = document.createElement('li');
      li.className = 'foco-ok';
      const minutos = Math.max(0, Math.round((Date.now() - Date.parse(data.actualizadoUtc)) / 60000));
      const hace = minutos < 60 ? `hace ${minutos} min` : `hace ${Math.round(minutos / 60)} h`;
      const t1 = document.createElement('div');
      t1.className = 'foco-ok-title';
      t1.textContent = '✅ Sin focos de calor activos';
      const t2 = document.createElement('div');
      t2.className = 'meta';
      t2.textContent = `Última revisión satelital: ${hace}. Sin detecciones de calor en las últimas horas en el Tolima.`;
      li.append(t1, t2);
      lista.appendChild(li);
    }
    // Agrupar por municipio, ordenando los municipios por severidad
    // (confianza alta primero, luego mayor intensidad)
    const porMunicipio = new Map();
    for (const f of focos.slice(0, 60)) {
      if (!porMunicipio.has(f.municipio)) porMunicipio.set(f.municipio, []);
      porMunicipio.get(f.municipio).push(f);
    }
    const severidad = (fs) =>
      Math.max(...fs.map((f) => (f.confianza === 'alta' ? 1000 : 0) + (f.frp ?? 0)));
    const grupos = [...porMunicipio.entries()].sort((a, b) => severidad(b[1]) - severidad(a[1]));

    for (const [municipio, fs] of grupos) {
      fs.sort((a, b) => (b.frp ?? 0) - (a.frp ?? 0));
      const cab = document.createElement('li');
      cab.className = 'municipio-header';
      cab.textContent =
        `${fs.some((f) => f.confianza === 'alta') ? '🔴' : '🟠'} ${municipio} · ` +
        `${fs.length} foco${fs.length > 1 ? 's' : ''}`;
      lista.appendChild(cab);
      for (const f of fs) {
        const li = document.createElement('li');
        li.className = 'foco-item sub' + (f.confianza === 'alta' ? ' alta' : '');
        li.tabIndex = 0;
        const titulo = document.createElement('div');
        titulo.textContent = f.vereda ? `Vereda ${f.vereda}` : `A ${f.distanciaKm} km de la cabecera`;
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = `${horaLocal(f.fechaUtc)} · confianza ${f.confianza}` +
          (f.frp ? ` · ${Math.round(f.frp)} MW` : '');
        li.append(titulo, meta);
        const enfocar = () => {
          map.setView([f.lat, f.lon], 12);
          marcadores.get(f.id)?.openPopup();
        };
        li.addEventListener('click', enfocar);
        li.addEventListener('keydown', (e) => e.key === 'Enter' && enfocar());
        lista.appendChild(li);
      }
    }

    // Banner de alerta para focos muy recientes (últimas 3 h) de confianza alta
    const urgentes = altas.filter((f) => horasDesde(f.fechaUtc) <= 3);
    const banner = el('alertBanner');
    if (urgentes.length > 0) {
      const municipios = [...new Set(urgentes.map((f) => f.municipio))].slice(0, 4);
      banner.textContent =
        `⚠️ ALERTA: ${urgentes.length} foco(s) de confianza alta detectado(s) en las últimas 3 horas ` +
        `cerca de: ${municipios.join(', ')}. Si observa humo o fuego, llame al 119 (Bomberos).`;
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }

    el('updated').textContent =
      `Última actualización de datos: ${horaLocal(data.actualizadoUtc)} (hora Colombia). ` +
      `El sistema se actualiza automáticamente cada hora.`;
  }

  // --- carga --------------------------------------------------------------

  async function cargar() {
    const status = el('status');
    try {
      const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const focos = Array.isArray(data.focos) ? data.focos.filter(focoValido) : [];

      capaFocos.clearLayers();
      marcadores.clear();
      focos.forEach(pintarFoco);
      pintarPanel(data, focos);

      status.textContent = `● Datos en línea · ${focos.length} focos`;
      status.className = 'status ok';
    } catch (err) {
      status.textContent = '● No se pudieron cargar los datos. Reintentando…';
      status.className = 'status error';
      console.error('VigíaT: error cargando datos', err);
    }
  }

  const capaIncendios = L.layerGroup().addTo(map);

  function pintarIncendio(inc) {
    const activo = inc.estado === 'activo';
    const icono = L.divIcon({
      className: 'goes-icon',
      html: `<div class="llama ${activo ? 'activa' : ''}">🔥</div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    });
    const ESTADOS = {
      activo: '🔥 Activo',
      sin_senal: '⏸️ Sin señal reciente',
      extinguido: '✅ Sin actividad',
    };
    L.marker([inc.lat, inc.lon], { icon: icono, opacity: activo ? 1 : 0.55 })
      .bindPopup(
        `<strong>${esc(inc.nombre)}</strong> <small>(${esc(inc.id)})</small><br>` +
        `Estado: <strong>${esc(ESTADOS[inc.estado] ?? inc.estado)}</strong><br>` +
        `📍 ${esc(inc.municipio)}${inc.vereda ? `, vereda ${esc(inc.vereda)}` : ''}<br>` +
        `🕐 Inicio: ${esc(horaLocal(inc.inicioUtc))} · última detección: ${esc(horaLocal(inc.ultimaDeteccionUtc))}<br>` +
        (inc.areaEstimadaHa ? `📏 Área estimada: ~${esc(inc.areaEstimadaHa)} ha<br>` : '') +
        `Detecciones satelitales: ${esc(inc.deteccionesTotales)}` +
        (inc.maxFrp ? ` · intensidad máx. ${esc(Math.round(inc.maxFrp))} MW` : '') +
        (inc.clima && activo
          ? `<br>🌬️ Viento ${esc(inc.clima.vientoKmh)} km/h hacia el ${esc(inc.clima.vientoHacia)} · ` +
            `humedad ${esc(inc.clima.humedadPct)}%<br>` +
            `⚠️ Riesgo de propagación: <strong>${esc(inc.clima.riesgoPropagacion)}</strong>`
          : '') +
        (activo && inc.ultimaGoesUtc && Date.now() - Date.parse(inc.ultimaGoesUtc) < 3600e3
          ? `<br>⚡ <strong>GOES lo sigue viendo</strong> — hace ${esc(Math.round((Date.now() - Date.parse(inc.ultimaGoesUtc)) / 60000))} min`
          : '') +
        botonZoom(inc.lat, inc.lon),
      )
      .addTo(capaIncendios);
  }

  // Botón "zoom a la ubicación" (estilo FIRMS). Sin JS inline (CSP): se maneja
  // con un solo listener delegado sobre el contenedor del mapa.
  const botonZoom = (lat, lon) =>
    `<button class="btn-zoom" data-lat="${lat}" data-lon="${lon}">🔎 Zoom a la ubicación</button>`;

  map.getContainer().addEventListener('click', (e) => {
    const b = e.target.closest('.btn-zoom');
    if (!b) return;
    const lat = Number(b.dataset.lat);
    const lon = Number(b.dataset.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      map.setView([lat, lon], 17); // máximo detalle útil de la imagen satelital
    }
  });

  async function cargarIncendios() {
    try {
      const res = await fetch(`data/incendios.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const incendios = (data.incendios ?? []).filter(
        (i) => Number.isFinite(i.lat) && Number.isFinite(i.lon),
      );
      capaIncendios.clearLayers();
      incendios.filter((i) => i.estado !== 'extinguido').forEach(pintarIncendio);
      const seccion = el('seccionIncendios');
      const lista = el('incendioList');
      lista.replaceChildren();
      if (incendios.length === 0) {
        seccion.hidden = true;
        return;
      }
      seccion.hidden = false;
      const ESTADOS = {
        activo: ['🔥 Activo', 'var(--danger)'],
        sin_senal: ['⏸️ Sin señal reciente', 'var(--accent)'],
        extinguido: ['✅ Sin actividad', 'var(--ok)'],
      };
      const orden = { activo: 0, sin_senal: 1, extinguido: 2 };
      incendios.sort((a, b) => (orden[a.estado] ?? 3) - (orden[b.estado] ?? 3));
      for (const inc of incendios) {
        const [etiqueta] = ESTADOS[inc.estado] ?? ['—'];
        const li = document.createElement('li');
        li.className = 'foco-item' + (inc.estado === 'activo' ? ' alta' : '');
        li.tabIndex = 0;
        const t = document.createElement('div');
        t.textContent = `${inc.nombre} · ${inc.municipio}`;
        const m1 = document.createElement('div');
        m1.className = 'meta';
        m1.textContent =
          `${etiqueta} · desde ${horaLocal(inc.inicioUtc)} · ` +
          (inc.areaEstimadaHa ? `~${inc.areaEstimadaHa} ha estimadas · ` : '') +
          `${inc.deteccionesTotales} ${inc.deteccionesTotales === 1 ? 'detección' : 'detecciones'}`;
        li.append(t, m1);
        if (inc.ultimaGoesUtc && inc.estado === 'activo') {
          const min = Math.round((Date.now() - Date.parse(inc.ultimaGoesUtc)) / 60000);
          if (min >= 0 && min <= 60) {
            const mg = document.createElement('div');
            mg.className = 'meta goes-live';
            mg.textContent = `⚡ GOES lo sigue viendo — hace ${min} min`;
            li.append(mg);
          }
        }
        if (inc.clima && inc.estado === 'activo') {
          const m2 = document.createElement('div');
          m2.className = 'meta';
          m2.textContent =
            `🌬️ ${inc.clima.vientoKmh} km/h hacia el ${inc.clima.vientoHacia} · ` +
            `humedad ${inc.clima.humedadPct}% · propagación: ${inc.clima.riesgoPropagacion}`;
          li.append(m2);
        }
        const enfocar = () => map.setView([inc.lat, inc.lon], 12);
        li.addEventListener('click', enfocar);
        li.addEventListener('keydown', (e) => e.key === 'Enter' && enfocar());
        lista.appendChild(li);
      }
    } catch (err) {
      console.error('VigíaT: error cargando incendios', err);
    }
  }

  cargar();
  cargarGoes();
  cargarIncendios();
  setInterval(cargarIncendios, REFRESH_MS);
  setInterval(cargar, REFRESH_MS);
  setInterval(cargarGoes, 2 * 60 * 1000); // GOES se refresca cada 2 min
})();
