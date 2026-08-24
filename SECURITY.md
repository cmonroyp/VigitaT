# Política de Seguridad — VigíaT

## Modelo de amenazas y controles implementados

Este proyecto fue diseñado con **superficie de ataque mínima**: es un sitio 100% estático,
sin base de datos, sin backend propio, sin formularios y sin entrada de datos de usuarios.

### Controles activos

| Riesgo | Control |
|---|---|
| Inyección de código (XSS) | CSP estricta en `index.html` (`object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`); todo dato externo se inserta con `textContent` o pasa por escape HTML (`esc()`); validación de estructura y rangos de cada foco antes de pintarlo |
| Compromiso de CDN (supply chain) | Leaflet se carga con **Subresource Integrity (SRI)**: si el archivo del CDN es alterado, el navegador lo rechaza |
| Robo de credenciales | La clave de NASA FIRMS y el token de Telegram viven **solo en GitHub Secrets**, nunca en el código ni en el frontend; el script valida el formato de la clave antes de usarla |
| Datos maliciosos desde la API | El script del Action valida cada registro (coordenadas dentro del bounding box, fechas con formato ISO, números finitos) y descarta lo que no cumpla; parser CSV propio sin `eval` ni dependencias |
| Dependencias comprometidas | **Cero dependencias npm** en el pipeline (solo Node estándar); una sola librería en frontend (Leaflet, con SRI) |
| Abuso del workflow | `permissions: contents: write` únicamente (mínimo privilegio); `timeout-minutes: 10`; `concurrency` para evitar ejecuciones simultáneas |
| Clickjacking | Riesgo residual bajo (sitio de solo lectura, sin sesiones ni acciones). GitHub Pages no permite cabeceras HTTP personalizadas; al migrar a Azure Static Web Apps, agregar `frame-ancestors 'none'` / `X-Frame-Options: DENY` vía `staticwebapp.config.json` |
| Fuga de datos de visitantes | El sitio **no recolecta ningún dato personal**, no usa cookies ni analítica; `referrer: no-referrer` |
| Desinformación | Cada alerta indica su fuente (NASA FIRMS), el desfase de detección, y advierte verificar en terreno |

### Reglas para colaboradores

1. Nunca subir claves, tokens o secretos al repositorio (usar GitHub Secrets).
2. No agregar dependencias npm sin revisión; preferir código estándar de Node/navegador.
3. Todo dato de origen externo (API, JSON) se trata como no confiable: validar y escapar siempre.
4. No agregar formularios ni entrada de usuarios sin una revisión de seguridad previa.
5. Mantener actualizada la versión de Leaflet y regenerar sus hashes SRI al hacerlo.

## Reporte de vulnerabilidades

Si encuentras una vulnerabilidad, **no la publiques en un issue abierto**.
Repórtala de forma privada mediante *GitHub Security Advisories*
(pestaña **Security → Report a vulnerability** del repositorio).
Nos comprometemos a responder en un máximo de 72 horas.

Este es un proyecto de interés público para la gestión del riesgo de incendios;
agradecemos la divulgación responsable.
