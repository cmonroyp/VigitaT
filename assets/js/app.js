/**
 * VigíaT — Frontend del mapa de incendios del Tolima.
 *
 * Lee los JSON generados por GitHub Actions (focos VIIRS, detecciones GOES e
 * incidentes en seguimiento) y los pinta sobre los límites municipales
 * oficiales del DANE. El panel se organiza en pestañas para evitar ruido.
 *
 * Seguridad: todo dato externo se inserta con textContent o pasa por esc();
 * nunca se interpola HTML sin sanear. Única dependencia: Leaflet (con SRI).
 */
'use strict';

(() => {
  const REFRESH_MS = 10 * 60 * 1000; // focos e incidentes
  const GOES_MS = 2 * 60 * 1000; // detección rápida
  const VISTA = { centro: [4.15, -75.2], zoom: 8 };

  // ------------------------------------------------------------ utilidades

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));

  const el = (id) => document.getElementById(id);
  const horasDesde = (iso) => (Date.now() - Date.parse(iso)) / 3.6e6;
  const minutosDesde = (iso) => Math.round((Date.now() - Date.parse(iso)) / 60000);

  const horaLocal = (iso) =>
    new Date(iso).toLocaleString('es-CO', {
      timeZone: 'America/Bogota',
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });

  const sinTildes = (s) => String(s).normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().trim();

  // Los tres nombres que difieren entre las capas oficiales del DANE
  const ALIAS = new Map([
    ['ARMERO-GUAYABAL', 'ARMERO'],
    ['EL ESPINAL', 'ESPINAL'],
    ['SAN SEBASTIAN DE MARIQUITA', 'MARIQUITA'],
  ]);
  const clave = (s) => {
    const n = sinTildes(s);
    return ALIAS.get(n) ?? n;
  };

  const titulo = (s) =>
    String(s).toLowerCase().replace(/(^|[\s(])\p{L}/gu, (c) => c.toUpperCase());

  const coordOk = (f) =>
    f && Number.isFinite(f.lat) && f.lat >= 2 && f.lat <= 6 &&
    Number.isFinite(f.lon) && f.lon >= -77 && f.lon <= -74;

  const focoValido = (f) =>
    coordOk(f) && typeof f.fechaUtc === 'string' && !Number.isNaN(Date.parse(f.fechaUtc));

  // ----------------------------------------------------------------- estado

  const estado = {
    focos: [],
    incendios: [],
    goes: [],
    goesEscaneo: null,
    actualizadoUtc: null,
    seleccion: null, // clave del municipio seleccionado
  };

  // ------------------------------------------------------------------- mapa

  // `padding` amplía el lienzo SVG más allá de la pantalla: sin esto se ve el
  // borde del recorte como una línea recta mientras se arrastra el mapa.
  const map = L.map('map', {
    zoomControl: true,
    maxZoom: 19,
    renderer: L.svg({ padding: 0.5 }),
  }).setView(VISTA.centro, VISTA.zoom);

  // Panel propio para los polígonos: siempre por debajo de focos y marcadores,
  // así nunca interceptan un clic dirigido a un punto de calor.
  map.createPane('paneMunicipios');
  map.getPane('paneMunicipios').style.zIndex = 350;
  const rendererMpios = L.svg({ pane: 'paneMunicipios', padding: 0.8 });

  // A partir de este zoom el mapa tiene espacio para mostrar los nombres
  const ZOOM_ETIQUETAS = 10;

  const capaCalles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    maxNativeZoom: 17,
    attribution: '&copy; OpenStreetMap · NASA FIRMS · NOAA · DANE',
  });

  const capaSatelite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, attribution: 'Imágenes &copy; Esri · NASA FIRMS · NOAA · DANE' },
  ).addTo(map);

  const capaFocos = L.layerGroup().addTo(map);
  const capaGoes = L.layerGroup().addTo(map);
  const capaIncendios = L.layerGroup().addTo(map);
  const marcadores = new Map();

  let capaMunicipios = null;
  const poligonos = new Map(); // clave -> layer

  // La capa de municipios se añade al control cuando termina de cargar el GeoJSON
  const controlCapas = L.control
    .layers(
      { 'Imagen satelital': capaSatelite, 'Mapa de calles': capaCalles },
      null,
      { position: 'topright' },
    )
    .addTo(map);

  // Botón "zoom a la ubicación" en los popups (sin JS inline, por la CSP)
  const botonZoom = (lat, lon) =>
    `<button class="btn-zoom" data-lat="${lat}" data-lon="${lon}">🔎 Zoom a la ubicación</button>`;

  map.getContainer().addEventListener('click', (e) => {
    const b = e.target.closest('.btn-zoom');
    if (!b) return;
    const lat = Number(b.dataset.lat);
    const lon = Number(b.dataset.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) map.setView([lat, lon], 17);
  });

  // ------------------------------------------------ resumen por municipio

  /** Agrega focos, incidentes y detecciones GOES por municipio. */
  function resumenMunicipios() {
    const r = new Map();
    const dame = (nombre) => {
      const k = clave(nombre);
      if (!r.has(k)) {
        r.set(k, { clave: k, nombre: titulo(nombre), activos: 0, sinSenal: 0, focos: 0, goes: 0, maxFrp: 0 });
      }
      return r.get(k);
    };
    for (const f of estado.focos) {
      const m = dame(f.municipio);
      m.focos += 1;
      m.maxFrp = Math.max(m.maxFrp, f.frp ?? 0);
    }
    for (const i of estado.incendios) {
      const m = dame(i.municipio);
      if (i.estado === 'activo') m.activos += 1;
      else if (i.estado === 'sin_senal') m.sinSenal += 1;
    }
    for (const g of estado.goes) {
      dame(g.municipio).goes += 1;
    }
    return r;
  }

  const severidadMpio = (m) => m.activos * 1e6 + m.goes * 1e4 + m.focos * 100 + m.maxFrp;

  // --------------------------------------------------- capa de municipios

  function estiloMunicipio(k, resumen) {
    if (estado.seleccion === k) {
      return { color: '#ffffff', weight: 2.5, opacity: 0.95, fillColor: '#ffcc00', fillOpacity: 0.12 };
    }
    const m = resumen.get(k);
    if (m && m.activos > 0) {
      return { color: '#ff3b30', weight: 1.6, opacity: 0.9, fillColor: '#ff3b30', fillOpacity: 0.22 };
    }
    if (m && (m.focos > 0 || m.goes > 0)) {
      return { color: '#ff9500', weight: 1.3, opacity: 0.8, fillColor: '#ff9500', fillOpacity: 0.13 };
    }
    // Sin actividad: apenas un contorno; el relleno casi invisible lo mantiene clicable
    return { color: '#ffffff', weight: 0.6, opacity: 0.2, fillColor: '#ffffff', fillOpacity: 0.01 };
  }

  async function cargarMunicipios() {
    try {
      const res = await fetch('data/municipios-poligonos-tolima.geojson', { cache: 'force-cache' });
      if (!res.ok) return;
      const geo = await res.json();
      capaMunicipios = L.geoJSON(geo, {
        pane: 'paneMunicipios',
        renderer: rendererMpios,
        style: (f) => estiloMunicipio(clave(f.properties.NOMBRE), resumenMunicipios()),
        onEachFeature: (f, layer) => {
          const k = clave(f.properties.NOMBRE);
          poligonos.set(k, layer);
          // Clic sobre el mapa: selecciona y filtra, pero NO mueve la vista.
          // El usuario ya está mirando esa zona; el zoom lo maneja él.
          layer.on('click', () => seleccionarMunicipio(k, false));
          layer.on('mouseover', () => {
            if (estado.seleccion !== k) layer.setStyle({ weight: 2.2, opacity: 1 });
          });
          layer.on('mouseout', () => layer.setStyle(estiloMunicipio(k, resumenMunicipios())));
        },
      }).addTo(map);
      controlCapas.addOverlay(capaMunicipios, 'Límites municipales');
      // Encuadre inicial al departamento completo. invalidateSize evita que un
      // contenedor todavía sin medidas produzca un zoom disparatado, y maxZoom
      // garantiza que la vista de arranque siempre sea la del departamento.
      map.invalidateSize();
      map.fitBounds(capaMunicipios.getBounds(), { padding: [8, 8], maxZoom: 9 });
      pintarMunicipiosEnMapa();
    } catch (err) {
      console.error('VigíaT: error cargando municipios', err);
    }
  }

  /**
   * Reaplica el sombreado de los municipios y decide si se muestran los nombres.
   * En la vista del departamento las etiquetas se superponen, así que solo
   * aparecen al ampliar (ZOOM_ETIQUETAS) y únicamente para lo que está a la vista.
   */
  function pintarMunicipiosEnMapa() {
    if (!capaMunicipios) return;
    const resumen = resumenMunicipios();
    const mostrarNombres = map.getZoom() >= ZOOM_ETIQUETAS;
    const vista = map.getBounds();

    for (const [k, layer] of poligonos) {
      layer.setStyle(estiloMunicipio(k, resumen));

      const visible = mostrarNombres && vista.intersects(layer.getBounds());
      if (!visible) {
        if (layer.getTooltip()) layer.unbindTooltip();
        continue;
      }
      const m = resumen.get(k);
      const nombre = m ? m.nombre : titulo(layer.feature.properties.NOMBRE);
      const partes = [];
      if (m?.activos) partes.push(`${m.activos}🔥`);
      if (m?.focos) partes.push(`${m.focos} foco${m.focos > 1 ? 's' : ''}`);
      const texto = partes.length ? `${nombre} · ${partes.join(' · ')}` : nombre;

      const actual = layer.getTooltip();
      if (actual && actual.getContent() === texto) continue; // sin cambios
      if (actual) layer.unbindTooltip();
      layer.bindTooltip(texto, {
        permanent: true,
        direction: 'center',
        className: `mpio-label${m?.activos ? ' activo' : ''}`,
      });
    }
  }

  // Al ampliar o desplazar cambia qué nombres tienen sentido mostrar
  map.on('zoomend moveend', pintarMunicipiosEnMapa);

  /**
   * Selecciona (o deselecciona) un municipio y filtra el panel.
   * La vista del mapa solo se mueve cuando la selección viene de la lista
   * lateral; nunca al deseleccionar. El zoom es del usuario.
   */
  function seleccionarMunicipio(k, hacerZoom) {
    estado.seleccion = estado.seleccion === k ? null : k;
    if (estado.seleccion && hacerZoom) {
      const layer = poligonos.get(estado.seleccion);
      if (layer) map.fitBounds(layer.getBounds(), { padding: [30, 30], maxZoom: 12 });
    }
    render();
  }

  // ------------------------------------------------------ dibujo en el mapa

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

    // Incertidumbre del píxel VIIRS (~375 m): el fuego está dentro del círculo
    L.circle([f.lat, f.lon], {
      radius: 375, color, weight: 1, dashArray: '4 4', fill: false, opacity: 0.6,
    }).addTo(capaFocos);
  }

  function pintarFocoGoes(f, escaneoUtc) {
    const esAlta = f.confianza === 'alta';
    L.marker([f.lat, f.lon], {
      icon: L.divIcon({
        className: 'icono-plano',
        html: `<div class="goes-tri ${esAlta ? 'alta' : ''}">▲</div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      }),
    })
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
    L.circle([f.lat, f.lon], {
      radius: 2000, color: '#ffcc00', weight: 1, dashArray: '4 4', fill: false, opacity: 0.5,
    }).addTo(capaGoes);
  }

  const ESTADOS = {
    activo: '🔥 Activo',
    sin_senal: '⏸️ Sin señal reciente',
    extinguido: '✅ Sin actividad',
  };

  function pintarIncendio(inc) {
    const activo = inc.estado === 'activo';
    L.marker([inc.lat, inc.lon], {
      icon: L.divIcon({
        className: 'icono-plano',
        html: `<div class="llama ${activo ? 'activa' : ''}">🔥</div>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      }),
      opacity: activo ? 1 : 0.55,
    })
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
        (activo && inc.ultimaGoesUtc && minutosDesde(inc.ultimaGoesUtc) <= 60
          ? `<br>⚡ <strong>GOES lo sigue viendo</strong> — hace ${esc(minutosDesde(inc.ultimaGoesUtc))} min`
          : '') +
        botonZoom(inc.lat, inc.lon),
      )
      .addTo(capaIncendios);
  }

  // ---------------------------------------------------------- panel lateral

  const enMunicipio = (x) => !estado.seleccion || clave(x.municipio) === estado.seleccion;

  function itemIncendio(inc) {
    const li = document.createElement('li');
    li.className = 'foco-item' + (inc.estado === 'activo' ? ' alta' : '');
    li.tabIndex = 0;

    const t = document.createElement('div');
    t.className = 'item-titulo';
    t.textContent = inc.vereda ? `Vereda ${inc.vereda}` : 'Zona rural';
    const sub = document.createElement('div');
    sub.className = 'meta';
    sub.textContent =
      `${ESTADOS[inc.estado] ?? ''} · ${inc.municipio} · desde ${horaLocal(inc.inicioUtc)}`;
    li.append(t, sub);

    const datos = document.createElement('div');
    datos.className = 'meta';
    datos.textContent =
      (inc.areaEstimadaHa ? `~${inc.areaEstimadaHa} ha estimadas · ` : '') +
      `${inc.deteccionesTotales} ${inc.deteccionesTotales === 1 ? 'detección' : 'detecciones'}` +
      (inc.maxFrp ? ` · máx. ${Math.round(inc.maxFrp)} MW` : '');
    li.append(datos);

    if (inc.ultimaGoesUtc && inc.estado === 'activo') {
      const min = minutosDesde(inc.ultimaGoesUtc);
      if (min >= 0 && min <= 60) {
        const g = document.createElement('div');
        g.className = 'meta goes-live';
        g.textContent = `⚡ GOES lo sigue viendo — hace ${min} min`;
        li.append(g);
      }
    }
    if (inc.clima && inc.estado === 'activo') {
      const c = document.createElement('div');
      c.className = 'meta';
      c.textContent =
        `🌬️ ${inc.clima.vientoKmh} km/h hacia el ${inc.clima.vientoHacia} · ` +
        `humedad ${inc.clima.humedadPct}% · propagación: ${inc.clima.riesgoPropagacion}`;
      li.append(c);
    }

    const ir = () => map.setView([inc.lat, inc.lon], 13);
    li.addEventListener('click', ir);
    li.addEventListener('keydown', (e) => e.key === 'Enter' && ir());
    return li;
  }

  function vacio(texto, ok) {
    const li = document.createElement('li');
    li.className = ok ? 'foco-ok' : 'foco-item';
    if (ok) {
      const t = document.createElement('div');
      t.className = 'foco-ok-title';
      t.textContent = '✅ Sin incendios activos';
      const m = document.createElement('div');
      m.className = 'meta';
      m.textContent = texto;
      li.append(t, m);
    } else {
      li.textContent = texto;
    }
    return li;
  }

  function renderActivos() {
    const lista = el('incendioList');
    lista.replaceChildren();
    const visibles = estado.incendios.filter(enMunicipio);
    const activos = visibles.filter((i) => i.estado === 'activo');
    const sinSenal = visibles.filter((i) => i.estado === 'sin_senal');

    activos.sort((a, b) => (b.maxFrp ?? 0) - (a.maxFrp ?? 0));
    if (activos.length === 0) {
      const min = estado.actualizadoUtc ? minutosDesde(estado.actualizadoUtc) : null;
      const hace = min === null ? '' : min < 60 ? `hace ${min} min` : `hace ${Math.round(min / 60)} h`;
      lista.appendChild(
        vacio(
          `Última revisión satelital ${hace}. Sin fuego confirmado en seguimiento` +
          `${estado.seleccion ? ' en este municipio' : ' en el Tolima'}.`,
          true,
        ),
      );
    } else {
      activos.forEach((i) => lista.appendChild(itemIncendio(i)));
    }

    const det = el('detSinSenal');
    const listaSS = el('sinSenalList');
    listaSS.replaceChildren();
    el('cntSinSenal').textContent = String(sinSenal.length);
    det.hidden = sinSenal.length === 0;
    sinSenal
      .sort((a, b) => Date.parse(b.ultimaDeteccionUtc) - Date.parse(a.ultimaDeteccionUtc))
      .forEach((i) => listaSS.appendChild(itemIncendio(i)));
  }

  function renderMunicipios() {
    const lista = el('municipioList');
    lista.replaceChildren();
    const resumen = resumenMunicipios();
    const filtro = sinTildes(el('buscarMpio').value || '');

    const todos = [...poligonos.keys()].map((k) => {
      const m = resumen.get(k);
      return (
        m ?? {
          clave: k,
          nombre: titulo(poligonos.get(k).feature.properties.NOMBRE),
          activos: 0, sinSenal: 0, focos: 0, goes: 0, maxFrp: 0,
        }
      );
    });
    const conActividad = todos
      .filter((m) => m.activos + m.focos + m.goes > 0)
      .sort((a, b) => severidadMpio(b) - severidadMpio(a));
    const sinActividad = todos
      .filter((m) => m.activos + m.focos + m.goes === 0)
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));

    const coincide = (m) => !filtro || sinTildes(m.nombre).includes(filtro);
    const item = (m) => {
      const li = document.createElement('li');
      const activo = m.activos > 0;
      li.className =
        'foco-item mpio-item' +
        (activo ? ' alta' : '') +
        (m.activos + m.focos + m.goes === 0 ? ' apagado' : '') +
        (estado.seleccion === m.clave ? ' sel' : '');
      li.tabIndex = 0;
      const t = document.createElement('div');
      t.className = 'item-titulo';
      t.textContent = `${activo ? '🔴' : m.focos + m.goes > 0 ? '🟠' : '⚪'} ${m.nombre}`;
      const meta = document.createElement('div');
      meta.className = 'meta';
      const partes = [];
      if (m.activos) partes.push(`${m.activos} incendio${m.activos > 1 ? 's' : ''} activo${m.activos > 1 ? 's' : ''}`);
      if (m.goes) partes.push(`${m.goes} detección rápida`);
      if (m.focos) partes.push(`${m.focos} foco${m.focos > 1 ? 's' : ''} 24 h`);
      if (m.sinSenal) partes.push(`${m.sinSenal} sin señal`);
      meta.textContent = partes.length ? partes.join(' · ') : 'Sin actividad registrada';
      li.append(t, meta);
      const ir = () => seleccionarMunicipio(m.clave, true);
      li.addEventListener('click', ir);
      li.addEventListener('keydown', (e) => e.key === 'Enter' && ir());
      return li;
    };

    conActividad.filter(coincide).forEach((m) => lista.appendChild(item(m)));
    const resto = sinActividad.filter(coincide);
    if (resto.length) {
      const det = document.createElement('details');
      det.className = 'plegable';
      if (filtro) det.open = true;
      const sum = document.createElement('summary');
      sum.textContent = `Municipios sin actividad (${resto.length})`;
      det.appendChild(sum);
      const ul = document.createElement('ul');
      ul.className = 'foco-list';
      resto.forEach((m) => ul.appendChild(item(m)));
      det.appendChild(ul);
      lista.appendChild(det);
    }
  }

  function renderFocos() {
    const lista = el('focoList');
    lista.replaceChildren();
    const focos = estado.focos.filter(enMunicipio);
    if (focos.length === 0) {
      lista.appendChild(vacio('Sin focos de calor en las últimas 24 horas.', false));
      return;
    }
    const porMpio = new Map();
    for (const f of focos) {
      const k = clave(f.municipio);
      if (!porMpio.has(k)) porMpio.set(k, []);
      porMpio.get(k).push(f);
    }
    const sev = (fs) => Math.max(...fs.map((f) => (f.confianza === 'alta' ? 1e4 : 0) + (f.frp ?? 0)));
    const grupos = [...porMpio.values()].sort((a, b) => sev(b) - sev(a));

    for (const fs of grupos) {
      fs.sort((a, b) => (b.frp ?? 0) - (a.frp ?? 0));
      const cab = document.createElement('li');
      cab.className = 'municipio-header';
      cab.textContent =
        `${fs.some((f) => f.confianza === 'alta') ? '🔴' : '🟠'} ${fs[0].municipio} · ` +
        `${fs.length} foco${fs.length > 1 ? 's' : ''}`;
      lista.appendChild(cab);
      for (const f of fs) {
        const li = document.createElement('li');
        li.className = 'foco-item sub' + (f.confianza === 'alta' ? ' alta' : '');
        li.tabIndex = 0;
        const t = document.createElement('div');
        t.textContent = f.vereda ? `Vereda ${f.vereda}` : `A ${f.distanciaKm} km de la cabecera`;
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent =
          `${horaLocal(f.fechaUtc)} · confianza ${f.confianza}` +
          (f.frp ? ` · ${Math.round(f.frp)} MW` : '');
        li.append(t, meta);
        const ir = () => {
          map.setView([f.lat, f.lon], 13);
          marcadores.get(f.id)?.openPopup();
        };
        li.addEventListener('click', ir);
        li.addEventListener('keydown', (e) => e.key === 'Enter' && ir());
        lista.appendChild(li);
      }
    }
  }

  function renderBanners() {
    // Banner de detección rápida GOES
    const bg = el('goesBanner');
    const goesFresco =
      estado.goesEscaneo && Date.parse(estado.goesEscaneo) > Date.now() - 3600e3 && estado.goes.length;
    if (goesFresco) {
      const mun = [...new Set(estado.goes.map((f) => f.municipio))].slice(0, 4);
      bg.textContent =
        `⚡ DETECCIÓN RÁPIDA: el satélite GOES observó ${estado.goes.length} posible(s) incendio(s) ` +
        `hace minutos cerca de: ${mun.join(', ')}. Preliminar, por confirmar. Si está en la zona, llame al 119.`;
      bg.hidden = false;
    } else {
      bg.hidden = true;
    }

    // Banner de incendios activos con riesgo de propagación alto
    const banner = el('alertBanner');
    const criticos = estado.incendios.filter(
      (i) => i.estado === 'activo' && i.clima?.riesgoPropagacion === 'ALTO',
    );
    if (criticos.length) {
      const mun = [...new Set(criticos.map((i) => i.municipio))].slice(0, 4);
      banner.textContent =
        `⚠️ ${criticos.length} incendio(s) activo(s) con RIESGO ALTO de propagación (viento y baja humedad) ` +
        `en: ${mun.join(', ')}. Si observa humo o fuego, llame al 119 (Bomberos).`;
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  }

  /** Redibuja panel, contadores y capas dependientes de la selección. */
  function render() {
    const activos = estado.incendios.filter((i) => i.estado === 'activo');
    const resumen = resumenMunicipios();
    const afectados = [...resumen.values()].filter((m) => m.activos + m.focos + m.goes > 0);

    el('statActivos').textContent = String(activos.length);
    el('statTotal').textContent = String(estado.focos.length);
    el('statMunicipios').textContent = String(afectados.length);
    el('cntActivos').textContent = String(
      estado.incendios.filter((i) => i.estado === 'activo' && enMunicipio(i)).length,
    );
    el('cntMpios').textContent = String(afectados.length);
    el('cntFocos').textContent = String(estado.focos.filter(enMunicipio).length);

    const chip = el('chipMunicipio');
    if (estado.seleccion) {
      const m = resumen.get(estado.seleccion);
      const layer = poligonos.get(estado.seleccion);
      el('chipNombre').textContent =
        m?.nombre ?? (layer ? titulo(layer.feature.properties.NOMBRE) : estado.seleccion);
      chip.hidden = false;
    } else {
      chip.hidden = true;
    }

    renderActivos();
    renderMunicipios();
    renderFocos();
    renderBanners();
    pintarMunicipiosEnMapa();

    if (estado.actualizadoUtc) {
      el('updated').textContent =
        `Actualizado: ${horaLocal(estado.actualizadoUtc)} (hora Colombia). ` +
        `Confirmación satelital cada hora · detección rápida cada 10 minutos.`;
    }
  }

  // -------------------------------------------------------------- carga

  async function cargarFocos() {
    const status = el('status');
    try {
      const res = await fetch(`data/focos.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      estado.focos = Array.isArray(data.focos) ? data.focos.filter(focoValido) : [];
      estado.actualizadoUtc = data.actualizadoUtc ?? null;

      capaFocos.clearLayers();
      marcadores.clear();
      estado.focos.forEach(pintarFoco);

      status.textContent = `● Datos en línea · ${estado.focos.length} focos 24 h`;
      status.className = 'status ok';
    } catch (err) {
      status.textContent = '● No se pudieron cargar los datos. Reintentando…';
      status.className = 'status error';
      console.error('VigíaT: error cargando focos', err);
    }
    render();
  }

  async function cargarIncendios() {
    try {
      const res = await fetch(`data/incendios.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      estado.incendios = (data.incendios ?? []).filter(
        (i) => coordOk(i) && i.estado !== 'extinguido',
      );
      capaIncendios.clearLayers();
      estado.incendios.forEach(pintarIncendio);
    } catch (err) {
      console.error('VigíaT: error cargando incendios', err);
    }
    render();
  }

  async function cargarGoes() {
    try {
      const res = await fetch(`data/focos-goes.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const g = await res.json();
      const fresco = g.escaneoUtc && Date.parse(g.escaneoUtc) > Date.now() - 3600e3;
      estado.goes = fresco && Array.isArray(g.focos) ? g.focos.filter(coordOk) : [];
      estado.goesEscaneo = g.escaneoUtc ?? null;
      capaGoes.clearLayers();
      estado.goes.forEach((f) => pintarFocoGoes(f, g.escaneoUtc));
    } catch (err) {
      console.error('VigíaT: error cargando GOES', err);
    }
    render();
  }

  // ------------------------------------------------------------ pestañas

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('activa', b === btn));
      const destino = `panel-${btn.dataset.tab}`;
      document.querySelectorAll('.tab-panel').forEach((p) => {
        const activo = p.id === destino;
        p.classList.toggle('activa', activo);
        p.hidden = !activo;
      });
    });
  });

  el('buscarMpio').addEventListener('input', renderMunicipios);
  el('chipCerrar').addEventListener('click', () => seleccionarMunicipio(estado.seleccion, false));

  // --------------------------------------------------------------- inicio

  cargarMunicipios().then(() => {
    cargarFocos();
    cargarIncendios();
    cargarGoes();
  });
  setInterval(cargarFocos, REFRESH_MS);
  setInterval(cargarIncendios, REFRESH_MS);
  setInterval(cargarGoes, GOES_MS);
})();
