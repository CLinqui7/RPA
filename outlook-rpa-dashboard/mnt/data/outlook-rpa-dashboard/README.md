# Outlook RPA Dashboard

MVP para revisar un Outlook corporativo usando Playwright, guardar eventos en Supabase y mostrar alertas en un dashboard React.

## Flujo

Operadores reenvían o copian correos de órdenes al Outlook corporativo monitor. Este RPA revisa solo ese Outlook, filtra correos por palabras clave, guarda eventos en Supabase y muestra alertas en el dashboard.

## 1. Crear tablas en Supabase

Abre Supabase > SQL Editor y pega el archivo:

```bash
database/schema.sql
```

## 2. Variables de entorno

Copia:

```bash
cp api/.env.example api/.env
cp web/.env.example web/.env
```

Completa los valores de Supabase.

## 3. Instalar y correr en Codespace

```bash
npm run install:all
npx --prefix api playwright install --with-deps chromium
npm run dev
```

Abre el puerto 5173 para ver el dashboard.

## 4. Primer login de Outlook

Desde terminal:

```bash
cd api
npm run login
```

Inicia sesión en Outlook cuando Playwright abra el navegador. La sesión queda guardada en `api/.auth/outlook-profile`.

## 5. Ejecutar prueba desde dashboard

Presiona **Ejecutar revisión Outlook**. El backend abrirá Outlook Web, leerá correos visibles/filtrados y guardará eventos.

## Importante

Este MVP usa interfaz web, no Microsoft Graph ni API. Los selectores de Outlook pueden requerir ajuste con screenshots reales y HTML visible del tenant.
