# Webbot

Extensión de Chrome (Manifest V3) que extrae texto de sitios web, automatiza clics y escritura en
páginas, y publica en Facebook y X usando la sesión que ya tienes abierta en el navegador. Se le
puede pedir en lenguaje natural desde su panel lateral, o conducirla desde un agente externo por MCP.

## Cómo encaja todo

El service worker de MV3 no puede escuchar en un puerto, así que la conexión va al revés de lo
habitual: el servidor levanta un WebSocket y **la extensión se conecta a él** como cliente. Sobre ese
mismo puente caben los dos modos de uso.

```
Agente IA externo (Claude Code, Claude Desktop, cualquier cliente MCP)
      │  MCP: stdio  |  HTTP streamable en /mcp
      ▼
  packages/server ──── puente WebSocket ws://127.0.0.1:8790 (token compartido)
      ▲   │                                  ▲
      │   │ comandos                         │ "abre example.com y dime de qué va"
      │   ▼                                  │
      │ packages/extension · service worker (router de comandos)
      │         │  chrome.tabs / chrome.scripting       │
      │         ▼                                       ▼
      │   runtime inyectado · extraer · clic · escribir · publicar
      │                                          panel lateral (chat)
      └── bucle agéntico: el servidor llama al modelo y sus herramientas
          bajan por el mismo puente
```

Las herramientas son las mismas por los dos caminos, así que la allowlist, los plazos y el foco de
pestaña se aplican igual venga la orden de donde venga.

`packages/shared` define el protocolo con zod y lo importan los dos lados: cambiar un comando rompe
la compilación en ambos extremos, que es justo lo que quieres que pase.

## Puesta en marcha

Requisitos: Node ≥ 20 y Chrome ≥ 116.

```bash
npm install
```

**1. Configura el token.** Copia `.env.example` a `.env` y pon un token largo y aleatorio:

```bash
cp .env.example .env
```

**2. Compila la extensión.**

```bash
npm run build
```

**3. Cárgala en Chrome.** Ve a `chrome://extensions`, activa el **modo de desarrollador**, pulsa
**Cargar descomprimida** y elige `packages/extension/dist`.

**4. Configura la extensión.** Abre sus **Opciones** y pega el mismo token del `.env`. Ahí también
está la allowlist de dominios: el agente solo puede actuar sobre los que aparezcan en esa lista.

**5. Arranca el servidor MCP.**

```bash
npm run mcp
```

El panel de la extensión debe pasar a **Conectado** y el icono mostrar el distintivo `ON`.

**6. Elige quién le da las órdenes.** Para pedírselo tú desde el panel, configura un modelo en el
`.env` (ver abajo). Para conducirla desde un agente externo, copia `.mcp.json.example` a `.mcp.json`
(o pega su contenido en la configuración de Claude Desktop) y ajusta `cwd` a la ruta del repo. El
token no se repite ahí: el servidor lo lee del `.env` de la raíz, y así no acaba en un archivo que se
pueda commitear. Los dos modos conviven sin estorbarse.

Durante el desarrollo, `npm run dev` levanta Vite con recarga en caliente; la extensión se recarga
sola al guardar.

## Pedírselo a la extensión

Pulsa el icono y se abre el panel lateral: escribes lo que quieres y el agente lo hace. El bucle no
corre en la extensión sino en `packages/server`, que es quien llama al modelo; las herramientas que
el modelo decide usar bajan por el puente como cualquier otro comando. Por eso el servidor tiene que
estar arrancado (`npm run mcp`) también para este modo.

El panel sabe qué pestaña tienes delante y se la cuenta al agente con cada instrucción, así que
**«resume esto» o «¿qué enlaces hay aquí?» funcionan sin dictarle la URL**. La cabecera enseña de qué
página se está hablando, y en ámbar cuando ese dominio no está en la allowlist. Debajo del chat hay
tres atajos —**Resumir**, **Enlaces**, **Qué hay aquí**— que mandan justo eso en un clic; se
deshabilitan cuando el dominio no está permitido, porque ahí solo podrían fallar.

Configura el modelo en el `.env` de la raíz:

```bash
WEBBOT_LLM_PROVIDER=anthropic          # anthropic | openai
WEBBOT_LLM_MODEL=claude-opus-5
WEBBOT_LLM_API_KEY=sk-ant-...          # también vale ANTHROPIC_API_KEY
```

`openai` no significa OpenAI: es el formato `/chat/completions`, que hablan casi todos los demás. Se
cambia de proveedor cambiando la URL base y el modelo, sin tocar código.

```bash
# OpenAI
WEBBOT_LLM_PROVIDER=openai
WEBBOT_LLM_MODEL=gpt-4.1

# OpenRouter, Groq, DeepSeek, Mistral, la capa compatible de Gemini...
WEBBOT_LLM_BASE_URL=https://openrouter.ai/api/v1

# NVIDIA NIM (clave nvapi-...). El catalogo retira modelos: si uno devuelve 410,
# mira cuales quedan en https://integrate.api.nvidia.com/v1/models
WEBBOT_LLM_BASE_URL=https://integrate.api.nvidia.com/v1
WEBBOT_LLM_MODEL=nvidia/nemotron-3-super-120b-a12b

# Un modelo local, que además no cuesta nada: no hace falta clave
WEBBOT_LLM_BASE_URL=http://127.0.0.1:11434/v1
WEBBOT_LLM_MODEL=qwen3
```

Si no hay modelo configurado, el servidor arranca igual y el camino MCP sigue entero: lo único que
pasa es que el panel te lo dice nada más conectar.

La cabecera del panel es el diagnóstico: dice si el puente está conectado, en qué puerto, cuántos
dominios permite y **con qué modelo**, que el servidor anuncia al conectar. Si no hay ninguno
configurado lo pone en ámbar con la línea del `.env` que falta, en vez de dejar que lo descubras
mandando un mensaje y viéndolo fallar.

### Qué te va a preguntar

Solo una cosa: **publicar de verdad**. El agente hace `dryRun` libremente, pero antes de pulsar
Publicar el panel se para y te enseña la red, la cuenta y el texto con dos botones. Lo demás —abrir
pestañas, hacer clic, escribir en formularios— lo hace sin preguntar, y el límite real de dónde puede
tocar sigue siendo la allowlist de Opciones.

El botón **Detener** corta el bucle en seco, y **Nueva** empieza una conversación desde cero. Cerrar
el panel no cancela nada: el historial vive en el service worker y al reabrirlo está todo.

## Herramientas MCP

| Herramienta | Qué hace |
| --- | --- |
| `webbot_status` | Estado de la conexión, allowlist y flujos. Empieza por aquí si algo falla. |
| `webbot_list_tabs` | Pestañas abiertas con su `tabId` y si están permitidas. |
| `webbot_open_tab` / `webbot_close_tab` / `webbot_navigate` | Gestión de pestañas. |
| `webbot_outline` | Radiografía de los elementos interactivos, con selector sugerido. |
| `webbot_extract` | Texto de la página: `readable`, `full` o `selectors`. |
| `webbot_links` | Enlaces con filtro por texto o por dominio propio. |
| `webbot_screenshot` | Captura PNG de la parte visible. |
| `webbot_click` / `webbot_type` / `webbot_scroll` / `webbot_wait_for` | Interacción. |
| `webbot_post_social` | Publica en Facebook o X. |
| `webbot_flow_list` / `webbot_flow_run` | Flujos guardados. |

El orden que funciona es siempre el mismo: `webbot_outline` para **ver** qué hay en la página y
después `webbot_click` o `webbot_type` sobre lo que has visto. Adivinar selectores no sale bien.

### Localizar elementos

Todos los comandos de interacción aceptan un `target` que combina criterios como AND:

```json
{ "css": "button", "text": "Aceptar", "index": 0 }
{ "role": "button", "name": "Cerrar" }
{ "xpath": "//table//tr[2]/td[1]" }
```

El texto se compara sin distinguir mayúsculas ni acentos, así que `"publicacion"` encuentra
`"Publicación"`. Cuando varios elementos encajan se queda con el más interno, y al hacer clic sube
automáticamente del `<span>` al `<button>` que lo contiene.

### Extracción

- `readable` (por defecto): título, metadatos y el texto limpio del artículo, sin menús ni pies.
- `full`: todo el texto visible.
- `selectors`: solo los campos que pidas, con CSS o XPath, atributos y listas.

```json
{ "precio": { "css": ".price" }, "enlaces": { "css": "a.item", "attr": "href", "all": true } }
```

Si el dominio tiene un perfil registrado en `packages/shared/src/profiles/`, se aplica solo y el
resultado lo indica en `profile`. Los `selectors` de la llamada sobrescriben los del perfil. Añadir
un sitio nuevo es añadir una entrada a `PROFILES`.

### Flujos

Secuencias guardadas en la extensión (se editan en Opciones) que el agente invoca por nombre. Los
textos admiten marcadores `{{variable}}`:

```json
{
  "buscar-en-hn": {
    "description": "Busca un tema en Hacker News y extrae los titulares",
    "steps": [
      { "do": "open", "url": "https://news.ycombinator.com/" },
      { "do": "type", "target": { "css": "input[name=q]" }, "text": "{{tema}}", "submit": true },
      { "do": "waitFor", "target": { "css": ".titleline" } },
      { "do": "extract", "mode": "selectors", "as": "resultados" }
    ]
  }
}
```

## Publicación en redes sociales

`webbot_post_social` escribe en el composer de Facebook o X y pulsa **Publicar**, sin pedir
confirmación. Publica de verdad y no se puede deshacer.

**El orden es siempre `dryRun` → confirmar la cuenta → publicar.** Con `dryRun: true` rellena el
cuadro de texto, localiza el botón y se detiene sin pulsarlo, devolviendo en `account` la cuenta con
la que saldría el post. Para publicar de verdad hay que pasar esa cuenta en `expectedAccount`
(`@usuario` en X, nombre visible en Facebook): sin ella, o si no coincide, se aborta antes de
escribir nada. Importa sobre todo en Facebook, donde la sesión puede estar actuando como una página
en lugar de como tu perfil.

Otras dos protecciones que conviene conocer:

- **Primer plano.** Antes de empezar trae al frente la pestaña de la red y su ventana, y el runtime
  se niega a arrancar en una pestaña oculta: en segundo plano Chrome congela la página y el flujo se
  quedaría a medias.
- **Plazo.** El servidor manda en cada petición cuánto va a esperar (90 s para publicar). Si el
  runtime llega al botón **Publicar** después de ese plazo, aborta sin pulsarlo con
  `deadline_exceeded`: nunca publica cuando ya nadie espera la respuesta.

> **Aviso.** Automatizar el composer por DOM incumple los Términos de Servicio de Facebook y X, y
> puede acabar en suspensión de la cuenta. X es especialmente agresivo detectando automatización.
> Pruébalo primero en una cuenta secundaria o en un grupo privado. Webbot no incluye —ni incluirá—
> resolución de CAPTCHAs, rotación de proxies, falsificación de huella ni publicación multicuenta.

Cuando los selectores dejen de funcionar (ocurrirá), están todos juntos en el objeto `SOCIAL` al
principio de `packages/extension/src/content/runtime.ts`. Arreglarlo es editar esa tabla.

## Seguridad

- **Token compartido**: el puente compara en tiempo constante y rechaza cualquier conexión sin él.
- **Solo loopback**: tanto el WebSocket del puente como el endpoint `/mcp` escuchan en
  `127.0.0.1`. Importa sobre todo en el segundo: `/mcp` no pide token, así que exponerlo en
  otra interfaz deja tu navegador a merced de cualquiera en la red. `WEBBOT_HTTP_HOST` solo se
  cambia dentro del contenedor, donde compose publica los puertos ya atados al loopback del host.
- **Allowlist de dominios**: es el límite real de lo que un agente puede tocar. Los subdominios
  entran solos (`github.com` cubre `gist.github.com`), y el match es por etiquetas completas, así
  que `github.com` no habilita `evilgithub.com`. Poner `*` desactiva el filtro.
- **Inyección bajo demanda**: no hay ningún content script declarado para `<all_urls>`; el runtime
  entra solo en la pestaña sobre la que se actúa y solo tras pasar la allowlist.
- **Sin evaluación de JS arbitrario**: la superficie es el conjunto fijo de comandos del protocolo.

## Desarrollo

```bash
npm run dev        # Vite con recarga en caliente
npm run build      # compila la extensión a packages/extension/dist
npm run typecheck  # tsc sobre todo el workspace
npm test           # vitest
npm run verify     # typecheck + tests + build + comprobación del bundle
npm run mcp        # servidor MCP por stdio
npm run mcp:http   # servidor MCP por HTTP en /mcp
npm run cli -- tabs   # smoke test sin necesidad de un agente
```

El CLI usa el mismo puerto que el servidor MCP: ejecuta uno u otro, no los dos a la vez.

```bash
npm run cli -- status
npm run cli -- open https://example.com
npm run cli -- outline 42
npm run cli -- extract 42 readable
npm run cli -- post x "mensaje de prueba"        # simulado
npm run cli -- post x "mensaje de prueba" --real --as @tu_usuario # publica
```

### Cómo se prueba el runtime

El runtime viaja a la página como **texto** (`chrome.scripting.executeScript` serializa la función,
no su closure), por lo que no puede referirse a nada de su módulo. `runtime.test.ts` lo instala con
`new Function` sobre su propio código fuente: si alguien introduce una dependencia externa, el test
falla con `ReferenceError` en vez de fallar en producción sobre una página real.

`npm run check:bundle` repite la comprobación sobre el bundle **ya compilado y minificado**, que es
donde el empaquetador podría haber sacado algo fuera de la función. `npm run verify` encadena
typecheck, tests, build y esta comprobación.

## Docker (opcional, solo el servidor)

La extensión no se contenedoriza: vive en tu Chrome. El servidor sí:

```bash
docker compose up --build
```

Publica el puente en `127.0.0.1:8790` y el MCP HTTP en `http://127.0.0.1:8791/mcp`, así que la
extensión no nota la diferencia. El transporte stdio se queda fuera de Docker a propósito: el
cliente MCP lo lanza como subproceso local y envolverlo en `docker run -i` solo añade latencia.

## Resolución de problemas

| Síntoma | Causa habitual |
| --- | --- |
| El panel dice "Desconectado" | El servidor no está arrancado (`npm run mcp`). |
| `llm_not_configured` | Falta `WEBBOT_LLM_MODEL` o la clave en el `.env`: el panel no tiene modelo. |
| `llm_unauthorized` | El proveedor rechazó la clave de `WEBBOT_LLM_API_KEY`. |
| `agent_max_steps` | El agente dio 30 pasos sin terminar. Pídeselo por partes. |
| "Token rechazado" | El de Opciones no coincide con `WEBBOT_TOKEN` del `.env`. |
| `domain_blocked` | Falta el dominio en la allowlist de Opciones. |
| `element_not_found` | Llama a `webbot_outline` y usa el selector que devuelve. |
| `element_not_visible` | El elemento existe pero está oculto: solo se actúa sobre lo visible. |
| `composer_not_found` | No hay sesión iniciada en la red, o cambió su UI: revisa `SOCIAL`. |
| `post_button_disabled` | El texto no llegó al editor, o supera el límite de caracteres. |
| `account_required` | Falta `expectedAccount` para publicar: haz antes un `dryRun` y usa su `account`. |
| `account_mismatch` | La sesión activa es otra cuenta (en Facebook, quizá una página): cámbiala o corrige `expectedAccount`. |
| `tab_hidden` | La pestaña de la red no está visible: tráela al frente y reintenta. |
| `deadline_exceeded` | El flujo llegó a Publicar fuera de plazo y abortó sin pulsar. No se publicó nada. |
| `composer_text_mismatch` | El editor no quedó con el texto pedido, así que no se publica. |
| El worker parece dormido | La alarma de keepalive lo revive en menos de 30 s; el panel fuerza la reconexión. |
