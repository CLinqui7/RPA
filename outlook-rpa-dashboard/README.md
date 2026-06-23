# Outlook RPA Dashboard

Dashboard operativo para monitorear correos de Outlook relacionados con PO/PT, urgencias, menciones con @ y correos pendientes de respuesta.

## Qué cambió en esta versión

- Diseño limpio con navegación lateral.
- Pestañas: Hoy, Sin respuesta, Urgentes, Órdenes, Respondidos y Todos.
- Tarjetas con información mínima afuera y detalle completo a un clic.
- Detección de asignación solo cuando existe una mención explícita con @.
- Si no hay @, el sistema muestra: `No hay @ / No asignado`.
- Urgente solo si hay palabra/frase urgente o Cancel Date próxima, y como respaldo señales fuertes como `route today`, `ASAP`, `critical` o `before EOD`.
- Detalle operativo con PO, PT, Ship Window, Cancel Date, remitente, adjuntos y correo original colapsado.

## Correr en Codespaces

Terminal 1:

```bash
cd /workspaces/RPA/outlook-rpa-dashboard
PORT=4100 npm --prefix api run dev
```

Terminal 2:

```bash
cd /workspaces/RPA/outlook-rpa-dashboard
npm --prefix web run dev -- --host 0.0.0.0 --port 3000
```

Abrir el puerto 3000 en navegador.

## Login demo

- admin / admin123
- carlos / carlos123
- routing / routing123
- warehouse / warehouse123
- shipping / shipping123

## Archivos sensibles

No subir al repo:

- `api/.env`
- `api/.auth/`
- `node_modules/`
- `api/downloads/`
- `api/debug/`


## Scanner v4

Por defecto `OUTLOOK_SCAN_MODE=inbox` no depende del asunto ni de una búsqueda específica. Lee los correos visibles recientes del Inbox, abre cada correo y analiza asunto + preview + cuerpo completo. El asunto se usa para clasificar y ordenar pantallas; urgencia, asignación y acciones se detectan del cuerpo completo también.

Usa `OUTLOOK_MAX_EMAILS=25` o más si necesitas revisar más filas recientes. Solo usa `OUTLOOK_SCAN_MODE=search` si quieres forzar Outlook Search con `OUTLOOK_SEARCH_QUERY`.
