import type { ExtractMode, FieldSpec, Network, SiteProfile, Target } from "@webbot/shared";

/** Lo que el runtime expone en la pagina una vez instalado. */
export interface WebbotApi {
  version: number;
  describe(target: Target): unknown;
  outline(options: { maxNodes?: number }): unknown;
  extract(options: {
    mode?: ExtractMode;
    selectors?: Record<string, FieldSpec>;
    profile?: SiteProfile | null;
    maxChars?: number;
  }): unknown;
  links(options: { contains?: string; sameOrigin?: boolean }): unknown;
  /** Las tres devuelven promesa: esperan a que la pagina se asiente para poder contar que cambio. */
  click(options: { target: Target }): Promise<unknown>;
  type(options: { target: Target; text: string; clear?: boolean; submit?: boolean }): Promise<unknown>;
  scroll(options: { direction: "up" | "down" | "top" | "bottom"; amount?: number }): Promise<unknown>;
  waitFor(options: { target: Target; timeoutMs?: number }): Promise<unknown>;
  sharePost(options: {
    target: Target;
    /** Comentario opcional al compartir. Vacio = compartir sin decir nada. */
    comment?: string;
    dryRun?: boolean;
    expectedAccount?: string;
    /** Extracto devuelto por el ensayo. Obligatorio para compartir de verdad. */
    expectedPost?: string;
    deadlineAt?: number;
  }): Promise<unknown>;
  postSocial(options: {
    network: Network;
    text: string;
    dryRun?: boolean;
    /** Obligatoria para publicar de verdad: si la cuenta activa no coincide, no se toca nada. */
    expectedAccount?: string;
    /** Solo Facebook: grupos en los que compartir ademas del muro. */
    groups?: string[];
    /** Date.now() a partir del cual nadie espera ya la respuesta: despues no se pulsa Publicar. */
    deadlineAt?: number;
  }): Promise<unknown>;
}

export const RUNTIME_VERSION = 13;

/**
 * Runtime que vive dentro de la pagina. Se inyecta con chrome.scripting.executeScript, que solo
 * transmite el TEXTO de la funcion: por eso todo (helpers, selectores, adaptadores) esta anidado
 * aqui dentro y no puede referirse a nada del modulo. Es idempotente: si ya esta instalado, sale.
 *
 * Los tipos importados arriba son solo tipos y se borran al compilar, asi que no rompen la
 * autonomia de la funcion.
 */
export function installWebbotRuntime(): void {
  // Subirla con cada cambio de comportamiento: una pagina que ya tenga inyectada la version
  // anterior la conserva hasta recargarse, y seguiria ejecutando el codigo viejo.
  const RUNTIME_VERSION_INNER = 13;
  const scope = globalThis as unknown as { __webbot?: WebbotApi };
  if (scope.__webbot && scope.__webbot.version === RUNTIME_VERSION_INNER) return;

  // -------------------------------------------------------------------------
  // Selectores de las redes sociales. Cuando Facebook o X cambien su UI, esto es
  // lo unico que hay que tocar.
  // -------------------------------------------------------------------------
  const SOCIAL = {
    x: {
      composer: ['[data-testid="tweetTextarea_0"]', 'div[role="textbox"][contenteditable="true"]'],
      openComposer: ['[data-testid="SideNav_NewTweet_Button"]', 'a[href="/compose/post"]', 'a[href="/compose/tweet"]'],
      postButton: ['[data-testid="tweetButtonInline"]', '[data-testid="tweetButton"]'],
      postButtonNames: [/^postear$/i, /^publicar$/i, /^post$/i, /^tweet$/i, /^twittear$/i],
      // El enlace a "Perfil" de la barra lateral lleva el @usuario de la sesion activa.
      accountLink: '[data-testid="AppTabBar_Profile_Link"]',
      closeNames: [/^cerrar$/i, /^close$/i],
    },
    facebook: {
      openComposerNames: [
        /qu[eé] est[aá]s pensando/i,
        /what'?s on your mind/i,
        /crear publicaci[oó]n/i,
        /create post/i,
      ],
      // Botones fijos de la tarjeta del composer. Sirven de ancla cuando el boton que la abre
      // muestra un borrador guardado en vez del saludo.
      composerCardNames: [/^foto\/video$/i, /^photo\/video$/i, /^video en vivo$/i, /^live video$/i, /^reel$/i],
      composer: ['div[role="textbox"][contenteditable="true"]', '[data-lexical-editor="true"]'],
      postButtonNames: [/^publicar$/i, /^post$/i, /^compartir$/i, /^share$/i],
      // Facebook parte la publicacion en dos pantallas: el composer acaba en "Siguiente" y
      // "Publicar" vive en el dialogo de configuracion que viene despues.
      nextStepNames: [/^siguiente$/i, /^next$/i],
      backNames: [/^volver$/i, /^back$/i, /^atr[aá]s$/i],
      closeNames: [/^cerrar$/i, /^close$/i],
      // La opcion vive en la pantalla de configuracion y su nombre accesible arrastra el reclamo
      // entero ("Compartir en grupos Llega a mas personas..."), asi que se ancla al principio.
      shareToGroupsNames: [/^compartir en grupos/i, /^share (to|in) groups/i],
      doneNames: [/^listo$/i, /^done$/i, /^hecho$/i],
      // Controles del selector que NO son grupos, para no confundirlos con uno al elegir.
      share: {
        // El nombre accesible medido en vivo sobre una publicacion del feed no es 'Compartir':
        // es el reclamo entero, y el texto del boton es el numero de veces compartida.
        buttonNames: [/^compartir$/i, /^share$/i, /^env[ií]a esto a tus amigos/i, /^send this to friends/i],
        // Para acotar el boton a SU publicacion y no pulsar el de otra del feed.
        containers: ['[role="article"]', "article"],
        /**
         * Destinos que abren un composer. "Compartir ahora" NO esta y no puede estar: publica al
         * instante sin abrir nada, asi que no habria donde parar el ensayo ni tarjeta que
         * ensenar, que son justo las dos cosas que impiden publicar sin permiso.
         */
        toFeedNames: [/^compartir en (el )?(feed|tu perfil|tu biograf)/i, /^share to (your )?(feed|profile|timeline)/i],
        // Lo que no es un destino, para poder listar los que si cuando ninguno encaje.
        noise: [/^cerrar$/i, /^close$/i, /^buscar/i, /^search/i, /^copiar enlace/i, /^copy link/i],
      },
      pickerNoise: [/^listo$/i, /^done$/i, /^hecho$/i, /^volver$/i, /^back$/i, /^atr[aá]s$/i, /^cerrar$/i, /^close$/i, /^buscar/i, /^search/i, /^eliminar/i, /^remove/i, /^quitar/i],
      // El composer saluda a quien publica: "¿Qué estás pensando, Impulsa CV?". Si la sesion actua
      // como una pagina, ese nombre es el de la pagina y no el del perfil personal.
      accountInPrompt: [/pensando,\s*(.+?)\s*\?\s*$/i, /on your mind,\s*(.+?)\s*\?\s*$/i],
      // Secciones de la barra lateral: sus enlaces tambien son de un solo tramo, como los de
      // perfil, asi que hay que descartarlas para quedarse con quien publica.
      navSections: new Set([
        "reel", "reels", "pages", "groups", "friends", "professional_dashboard", "onthisday",
        "saved", "marketplace", "watch", "events", "memories", "policies", "business", "help",
        "privacy", "gaming", "fundraisers", "climatescience", "settings",
      ]),
    },
  };

  const NOISE_TAGS = new Set(["script", "style", "noscript", "svg", "canvas", "iframe", "template", "head"]);
  const BLOCK_TAGS = new Set([
    "address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "fieldset", "figcaption",
    "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav",
    "ol", "p", "pre", "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
  ]);
  const READABLE_NOISE = ["nav", "header", "footer", "aside", "form", '[role="navigation"]', '[role="banner"]', '[role="complementary"]', ".advertisement", "[aria-hidden='true']"];
  const READABLE_CONTAINERS = ["article", "main", '[role="main"]', "#content", "#main", ".post-content", ".entry-content"];
  const INTERACTIVE_SELECTOR =
    'a[href], button, input, textarea, select, summary, [role], [contenteditable="true"], [onclick], [tabindex]';

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Minuscula, sin acentos y con espacios colapsados: hace el matching de textos tolerante, que en
   * una UI en espanol importa ("Publicar" vs "publicar", "que" vs "qué").
   */
  function norm(value: string | null | undefined): string {
    const decomposed = (value ?? "").normalize("NFD");
    let stripped = "";
    for (const char of decomposed) {
      const code = char.codePointAt(0) ?? 0;
      // Rango de marcas diacriticas combinantes: se descartan tras la descomposicion NFD.
      if (code >= 0x300 && code <= 0x36f) continue;
      stripped += char;
    }
    return stripped.toLowerCase().replace(/\s+/g, " ").trim();
  }

  function isVisible(el: Element): boolean {
    if (!(el instanceof HTMLElement) && !(el instanceof SVGElement)) return false;
    const rects = el.getClientRects();
    if (rects.length === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  }

  function visibleText(el: Element): string {
    const text = el instanceof HTMLElement ? el.innerText : el.textContent;
    return (text ?? "").replace(/\s+/g, " ").trim();
  }

  function roleOf(el: Element): string {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
    if (tag === "button") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "img") return "img";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "input") {
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "search") return "searchbox";
      return "textbox";
    }
    if (el.getAttribute("contenteditable") === "true") return "textbox";
    return "generic";
  }

  function accessibleName(el: Element): string {
    const label = el.getAttribute("aria-label");
    if (label) return label.trim();
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const names = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter((node): node is HTMLElement => node !== null)
        .map((node) => visibleText(node));
      if (names.length) return names.join(" ").trim();
    }
    const attrName = el.getAttribute("alt") ?? el.getAttribute("title") ?? el.getAttribute("placeholder");
    if (attrName) return attrName.trim();
    if (el instanceof HTMLInputElement && ["button", "submit", "reset"].includes(el.type)) return el.value;
    return visibleText(el).slice(0, 200);
  }

  /** CSS.escape no existe en todos los entornos; un id nunca debe tumbar la descripcion. */
  function escapeIdent(value: string): string {
    const css = (globalThis as { CSS?: { escape?: (input: string) => string } }).CSS;
    return typeof css?.escape === "function" ? css.escape(value) : value.replace(/([^\w-])/g, "\\$1");
  }

  /** Selector corto y razonablemente estable para devolverselo al agente. */
  function cssPath(el: Element): string {
    if (el.id && !/^[0-9]/.test(el.id)) return `#${escapeIdent(el.id)}`;
    const testId = el.getAttribute("data-testid");
    if (testId) return `[data-testid="${testId}"]`;
    const parts: string[] = [];
    let node: Element | null = el;
    for (let depth = 0; node && depth < 4 && node.tagName.toLowerCase() !== "html"; depth += 1) {
      const tag = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const siblings = Array.from(parent.children).filter((child) => child.tagName === node!.tagName);
      parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
      if (parent.id && !/^[0-9]/.test(parent.id)) {
        parts.unshift(`#${escapeIdent(parent.id)}`);
        break;
      }
      node = parent;
    }
    return parts.join(" > ");
  }

  function describeElement(el: Element): Record<string, unknown> {
    return {
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      name: accessibleName(el).slice(0, 120),
      text: visibleText(el).slice(0, 160),
      selector: cssPath(el),
      visible: isVisible(el),
      disabled: el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true",
    };
  }

  /** Tope de elementos que se comparan antes y despues de actuar. */
  const SNAPSHOT_LIMIT = 300;
  /** Cuantos cambios se cuentan uno a uno antes de resumir el resto. */
  const DIFF_LIMIT = 15;
  const DIALOG_SELECTOR = '[aria-modal="true"], [role="dialog"], [role="alertdialog"], dialog[open]';

  /**
   * Espera a que el DOM deje de cambiar. Es la pregunta contraria a la de until(): no "cuando
   * aparezca esto" —donde la espera activa aguanta mejor un repintado completo— sino "cuando pare
   * todo", que es justo para lo que sirve un MutationObserver. Resuelve tras `quietMs` sin
   * mutaciones, o al llegar al techo si la pagina no se calla nunca.
   */
  function settle(quietMs = 250, maxMs = 2_000): Promise<void> {
    return new Promise((resolve) => {
      let quiet: ReturnType<typeof setTimeout> | undefined;
      let cap: ReturnType<typeof setTimeout> | undefined;
      function done(): void {
        if (quiet) clearTimeout(quiet);
        if (cap) clearTimeout(cap);
        observer.disconnect();
        resolve();
      }
      const observer = new MutationObserver(() => {
        if (quiet) clearTimeout(quiet);
        quiet = setTimeout(done, quietMs);
      });
      cap = setTimeout(done, maxMs);
      quiet = setTimeout(done, quietMs);
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    });
  }

  /**
   * Elementos interactivos que merece la pena ensenar. Lo usan outline y la comparacion posterior a
   * cada accion: si barrieran distinto, el "ha aparecido esto" mentiria.
   */
  function interactiveElements(limit: number): Element[] {
    const found: Element[] = [];
    const seen = new Set<Element>();
    for (const el of Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR))) {
      if (found.length >= limit) break;
      if (seen.has(el) || !isVisible(el)) continue;
      const role = roleOf(el);
      if (role === "generic" && !el.hasAttribute("onclick")) continue;
      if (!accessibleName(el) && role !== "textbox") continue;
      seen.add(el);
      found.push(el);
    }
    return found;
  }

  /**
   * Clave por rol y nombre, nunca por selector: un React cualquiera reescribe los selectores en
   * cada render, y entonces el repintado mas tonto pareceria una pagina entera nueva.
   */
  function snapshot(): Map<string, Element> {
    const map = new Map<string, Element>();
    for (const el of interactiveElements(SNAPSHOT_LIMIT)) {
      const key = `${roleOf(el)}|${accessibleName(el).slice(0, 120)}`;
      if (!map.has(key)) map.set(key, el);
    }
    return map;
  }

  /**
   * La capa que esta tapando la pagina, si la hay, con lo que se puede pulsar dentro. Sin esto el
   * modelo recibe una lista plana de elementos y no tiene forma de saber que hay un banner de
   * cookies encima bloqueandolos todos.
   */
  function openDialog(): Record<string, unknown> | null {
    const el = Array.from(document.querySelectorAll(DIALOG_SELECTOR)).find(isVisible);
    if (!el) return null;
    const inside = Array.from(el.querySelectorAll(INTERACTIVE_SELECTOR))
      .filter((child) => isVisible(child) && (Boolean(accessibleName(child)) || roleOf(child) === "textbox"))
      .slice(0, 20)
      .map(describeElement);
    return { ...describeElement(el), elements: inside };
  }

  /**
   * Que provoco la accion. Es lo que evita tener que gastar otro paso en outline detras de cada
   * clic, y lo que garantiza que lo que se lea sea el DOM de despues del repintado y no el de antes.
   */
  async function pageAfter(before: Map<string, Element>): Promise<Record<string, unknown>> {
    await settle();
    const after = snapshot();
    const appeared: Record<string, unknown>[] = [];
    const disappeared: string[] = [];
    for (const [key, el] of after) if (!before.has(key)) appeared.push(describeElement(el));
    for (const key of before.keys()) if (!after.has(key)) disappeared.push(key);

    const extra: Record<string, unknown> = {};
    if (appeared.length > DIFF_LIMIT) extra.appearedMore = appeared.length - DIFF_LIMIT;
    if (disappeared.length > DIFF_LIMIT) extra.disappearedMore = disappeared.length - DIFF_LIMIT;

    return {
      url: location.href,
      title: document.title,
      appeared: appeared.slice(0, DIFF_LIMIT),
      disappeared: disappeared.slice(0, DIFF_LIMIT),
      dialog: openDialog(),
      ...extra,
    };
  }

  function queryPool(target: Target): Element[] {
    if (target.xpath) {
      const result = document.evaluate(target.xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const nodes: Element[] = [];
      for (let i = 0; i < result.snapshotLength; i += 1) {
        const node = result.snapshotItem(i);
        if (node instanceof Element) nodes.push(node);
      }
      return nodes;
    }
    try {
      return Array.from(document.querySelectorAll(target.css ?? "*"));
    } catch {
      throw new Error(`Selector CSS invalido: ${target.css}`);
    }
  }

  /** Aplica todos los criterios del target como AND y ordena de mas especifico a menos. */
  function findAll(target: Target, includeHidden = false): Element[] {
    let pool = queryPool(target);
    if (target.role) {
      const wanted = target.role.toLowerCase();
      pool = pool.filter((el) => roleOf(el) === wanted);
    }
    if (target.name) {
      const wanted = norm(target.name);
      pool = pool.filter((el) => norm(accessibleName(el)).includes(wanted));
    }
    if (target.text) {
      const wanted = norm(target.text);
      pool = pool.filter((el) => norm(visibleText(el)).includes(wanted));
    }
    // Buscar por texto encaja tambien con todos los ancestros; nos quedamos con el mas interno.
    if (target.text || target.name) {
      pool = pool.filter((el) => !pool.some((other) => other !== el && el.contains(other)));
    }
    const visibles = pool.filter(isVisible);
    if (visibles.length > 0) return visibles;
    // Las ocultas solo salen si se piden para inspeccionar: actuar sobre algo que no se ve casi
    // nunca hace lo que el agente cree, y antes se pulsaban elementos invisibles sin avisar.
    return includeHidden ? pool : [];
  }

  function findOne(target: Target, includeHidden = false): Element {
    const matches = findAll(target, includeHidden);
    const index = target.index ?? 0;
    const el = matches[index];
    if (el) return el;

    const criterios = JSON.stringify(target);
    // Distinguir "no existe" de "existe pero no se ve" le ahorra al agente perseguir un fantasma.
    const ocultas = !includeHidden && matches.length === 0 ? findAll(target, true).length : 0;
    if (ocultas > 0) {
      throw Object.assign(
        new Error(`Hay ${ocultas} coincidencia(s) para ${criterios}, pero ninguna visible: no se actua sobre lo oculto.`),
        { webbotCode: "element_not_visible" },
      );
    }
    throw Object.assign(new Error(`No se encontro ningun elemento para ${criterios} (coincidencias: ${matches.length}).`), {
      webbotCode: "element_not_found",
    });
  }

  /** Para clics: si el elemento encontrado es un span dentro de un boton, sube al boton. */
  function clickableFrom(el: Element): Element {
    const clickable = el.closest('a[href], button, [role="button"], [role="link"], [role="menuitem"], input, summary, label');
    return clickable ?? el;
  }

  function dispatchClick(el: Element): void {
    const rect = el.getBoundingClientRect();
    // Se omite `view` a proposito: casi ningun manejador lo lee y hay entornos que lo rechazan.
    const init: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    // Muchas UIs modernas escuchan pointerdown, no click: reproducimos la secuencia completa.
    const pointer = (type: string): Event => {
      const Ctor = (globalThis as { PointerEvent?: typeof PointerEvent }).PointerEvent;
      if (!Ctor) return new MouseEvent(type, init);
      return new Ctor(type, { ...init, pointerType: "mouse", isPrimary: true });
    };

    if (el instanceof HTMLElement) el.focus({ preventScroll: true });
    el.dispatchEvent(pointer("pointerdown"));
    el.dispatchEvent(new MouseEvent("mousedown", init));
    el.dispatchEvent(pointer("pointerup"));
    el.dispatchEvent(new MouseEvent("mouseup", init));
    el.dispatchEvent(new MouseEvent("click", init));
  }

  /**
   * Escribir texto de forma que React, Vue, Draft.js y Lexical se enteren. Asignar `value` o
   * `textContent` a pelo no sirve: el estado interno del framework no cambia y el boton de enviar
   * sigue deshabilitado.
   */
  function setText(el: Element, text: string, clear: boolean): void {
    if (el instanceof HTMLElement) el.focus({ preventScroll: true });

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      const next = clear ? text : `${el.value}${text}`;
      if (setter) setter.call(el, next);
      else el.value = next;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    if (el.getAttribute("contenteditable") === "true" || (el instanceof HTMLElement && el.isContentEditable)) {
      const selection = window.getSelection();
      const range = document.createRange();
      if (clear) {
        range.selectNodeContents(el);
      } else {
        range.selectNodeContents(el);
        range.collapse(false);
      }
      selection?.removeAllRanges();
      selection?.addRange(range);

      // execCommand esta obsoleto pero sigue siendo lo unico que Draft.js y Lexical entienden.
      // Puede no existir, asi que se comprueba antes de llamarlo.
      const exec = (document as { execCommand?: (name: string, ui: boolean, value: string) => boolean }).execCommand;

      if (clear && text === "") {
        // insertText con cadena vacia devuelve true en Chrome pero no borra la seleccion: vaciar es
        // borrar. Lexical no pasa por aqui, porque ignora la seleccion hecha por script (ver
        // setLexicalText). Si Chrome dice que borro, no se toca el DOM a mano: vaciarlo por detras
        // de un editor dejaria su modelo con el texto, y es el modelo lo que se publica.
        const deleted = typeof exec === "function" ? exec.call(document, "delete", false, "") : false;
        if (!deleted) {
          el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, composed: true, cancelable: true, inputType: "deleteContentBackward" }));
          el.textContent = "";
          el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "deleteContentBackward" }));
        }
        return;
      }

      const inserted = typeof exec === "function" ? exec.call(document, "insertText", false, text) : false;
      if (!inserted) {
        // Camino alternativo para editores que ignoran execCommand.
        el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, composed: true, cancelable: true, inputType: "insertText", data: text }));
        el.textContent = clear ? text : `${el.textContent ?? ""}${text}`;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
      }
      return;
    }

    throw new Error(`El elemento <${el.tagName.toLowerCase()}> no admite escritura de texto.`);
  }

  /** Raiz de un editor Lexical (el composer de Facebook), o null si el elemento no esta en uno. */
  /**
   * Vacia el composer y cierra su dialogo si lo tiene. El orden importa: con el cuadro ya vacio
   * Facebook cierra sin preguntar si descartar el borrador, y asi no hay un segundo dialogo que
   * atender.
   */
  async function closeComposer(composer: Element, closeNames: RegExp[]): Promise<void> {
    await writeComposer(composer, "", 200);
    const dialog = composer.closest('[role="dialog"]');
    if (!dialog) return;
    const close = buttonByName(closeNames, dialog);
    if (!close) return;
    dispatchClick(close);
    await until(() => (dialog.isConnected ? null : true), 3_000);
  }

  /**
   * Deshace lo que monto el ensayo. El dryRun no simula: abre el composer de verdad y escribe el
   * texto de verdad, y en Facebook hasta puede haber avanzado a la pantalla de configuracion. Si
   * no se recoge, la persona se queda un borrador abierto que no pidio y el siguiente intento
   * empieza encima de esos restos, que es justo como se acaba con dos dialogos apilados.
   *
   * Es el mejor esfuerzo y nunca lanza: el ensayo ya tiene su respuesta, y fallar al recoger no
   * puede convertir en error una comprobacion que salio bien. Lo que pasara se dice en 'tidied'.
   */
  async function tidyAfterDryRun(composer: Element, closeNames: RegExp[], advancedStep = false): Promise<boolean> {
    try {
      // Si se avanzo de pantalla el composer esta detras, y hay que volver para poder vaciarlo.
      const target = advancedStep ? ((await facebookBackToComposer()) ?? composer) : composer;
      await closeComposer(target, closeNames);
      return true;
    } catch {
      return false;
    }
  }

  function lexicalRoot(el: Element): HTMLElement | null {
    const root = el.closest('[data-lexical-editor="true"]');
    return root instanceof HTMLElement ? root : null;
  }

  /**
   * Reemplaza TODO el contenido de un editor Lexical. Lexical ignora la seleccion que se fija por
   * script con un Range: medido con Lexical real, borrar tras seleccionar asi no hace nada, e
   * insertText sobre un borrador duplica el texto y parte el modelo en parrafos. Lo que si funciona
   * es pedirle a Lexical que seleccione todo con su propio atajo (Ctrl+A, o Cmd+A en Apple, la misma
   * regla que usa Lexical) y actuar despues sobre esa seleccion. Funciona tambien sin foco.
   */
  async function setLexicalText(root: HTMLElement, text: string): Promise<void> {
    root.focus({ preventScroll: true });
    const apple = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
    const selectAll = {
      key: "a", code: "KeyA", keyCode: 65, which: 65,
      bubbles: true, cancelable: true, composed: true,
      ctrlKey: !apple, metaKey: apple,
    };
    root.dispatchEvent(new KeyboardEvent("keydown", selectAll));
    root.dispatchEvent(new KeyboardEvent("keyup", selectAll));
    await sleep(60);

    if (text === "") {
      root.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, composed: true, cancelable: true, inputType: "deleteContentBackward" }));
      await sleep(60);
      return;
    }

    const exec = (document as { execCommand?: (name: string, ui: boolean, value: string) => boolean }).execCommand;
    const inserted = typeof exec === "function" ? exec.call(document, "insertText", false, text) : false;
    if (!inserted && typeof DataTransfer === "function" && typeof ClipboardEvent === "function") {
      // Pegar es la otra via que Lexical atiende sobre su propia seleccion.
      const data = new DataTransfer();
      data.setData("text/plain", text);
      root.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, composed: true, clipboardData: data }));
    }
    await sleep(60);
  }

  /**
   * Editores con framework detras marcan como suyos los nodos de texto que salen de su modelo:
   * Draft.js (X) con data-text, Lexical (Facebook) con data-lexical-text.
   */
  const MANAGED_TEXT_SELECTOR = '[data-text="true"], [data-lexical-text="true"]';

  /** Texto colapsado tal cual esta en el DOM. No usa innerText a proposito: jsdom no lo implementa. */
  function rawText(el: Element): string {
    return (el.textContent ?? "").replace(/\s+/g, " ").trim();
  }

  /** Lo que el editor reconoce como suyo, o null si no marca sus nodos. */
  function managedText(el: Element): string | null {
    const nodes = el.querySelectorAll(MANAGED_TEXT_SELECTOR);
    if (nodes.length === 0) return null;
    let out = "";
    for (const node of nodes) out += node.textContent ?? "";
    return out.replace(/\s+/g, " ").trim();
  }

  /**
   * Borra los nodos de texto que el editor no reconoce como suyos. execCommand("insertText")
   * inserta de forma nativa y el editor ademas renderiza el suyo desde el modelo: en el composer
   * de X eso deja el texto duplicado en el DOM (un nodo suelto junto al span con data-text).
   */
  function dropStrayText(el: Element): void {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const strays: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = (node as Text).parentElement;
      if (parent && !parent.closest(MANAGED_TEXT_SELECTOR)) strays.push(node as Text);
    }
    for (const stray of strays) stray.remove();
  }

  /**
   * Escribe en el composer y NO SIGUE si lo que quedo dentro no es lo que se pidio. Publicar un
   * texto distinto del que pidio el agente no tiene vuelta atras, asi que ante la duda se falla.
   */
  async function writeComposer(composer: Element, text: string, settleMs: number): Promise<void> {
    const wanted = text.replace(/\s+/g, " ").trim();
    const lexical = lexicalRoot(composer);
    if (lexical) await setLexicalText(lexical, text);
    else setText(composer, text, true);
    await sleep(settleMs);
    if (rawText(composer) === wanted) return;

    // Si el modelo del editor si tiene el texto correcto, lo que sobra es basura en el DOM.
    if (managedText(composer) === wanted) {
      dropStrayText(composer);
      await sleep(120);
      if (rawText(composer) === wanted) return;
    }

    throw Object.assign(
      new Error(
        "El composer quedo con un texto distinto del pedido, asi que no se publica nada. Pedido: " +
          JSON.stringify(wanted) + ". Quedo: " + JSON.stringify(rawText(composer).slice(0, 200)) + ".",
      ),
      { webbotCode: "composer_text_mismatch" },
    );
  }

  function textFrom(root: Element, removeSelectors: string[]): string {
    const skip = new Set<Element>();
    for (const selector of removeSelectors) {
      try {
        root.querySelectorAll(selector).forEach((node) => skip.add(node));
      } catch {
        // Un selector invalido en un perfil no debe tumbar la extraccion entera.
      }
    }
    const parts: string[] = [];
    const walk = (node: Node): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        const value = (node.nodeValue ?? "").replace(/\s+/g, " ");
        if (value.trim()) parts.push(value);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node as Element;
      if (skip.has(el) || NOISE_TAGS.has(el.tagName.toLowerCase())) return;
      if (!isVisible(el)) return;
      const isBlock = BLOCK_TAGS.has(el.tagName.toLowerCase());
      if (isBlock) parts.push("\n");
      el.childNodes.forEach(walk);
      if (isBlock) parts.push("\n");
    };
    walk(root);
    return parts.join("").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }

  /** Autor segun el marcado de la pagina, cuando no hay meta que lo declare. */
  function authorFromDom(): string | undefined {
    const el = document.querySelector('[rel="author"], [itemprop="author"], .author, .byline');
    const text = el ? visibleText(el) : "";
    return text.length > 0 && text.length < 120 ? text : undefined;
  }

  function metaContent(...names: string[]): string | undefined {
    for (const name of names) {
      const el =
        document.querySelector(`meta[property="${name}"]`) ?? document.querySelector(`meta[name="${name}"]`);
      const content = el?.getAttribute("content")?.trim();
      if (content) return content;
    }
    return undefined;
  }

  function readField(spec: FieldSpec): string | string[] | null {
    const target: Target = { css: spec.css, xpath: spec.xpath, index: 0 };
    let nodes: Element[];
    try {
      nodes = queryPool(target);
    } catch {
      return null;
    }
    const read = (el: Element): string => {
      if (!spec.attr) return visibleText(el);
      if (spec.attr === "href" && el instanceof HTMLAnchorElement) return el.href;
      if (spec.attr === "src" && el instanceof HTMLImageElement) return el.src;
      return el.getAttribute(spec.attr) ?? "";
    };
    if (spec.all) return nodes.map(read);
    return nodes[0] ? read(nodes[0]) : null;
  }

  function pickContainer(profile: SiteProfile | null | undefined): Element {
    if (profile?.container) {
      const el = document.querySelector(profile.container);
      if (el) return el;
    }
    for (const selector of READABLE_CONTAINERS) {
      const el = document.querySelector(selector);
      if (el && visibleText(el).length > 200) return el;
    }
    return document.body;
  }

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  /** Espera activa: mas fiable que MutationObserver cuando la UI se repinta por completo. */
  async function until<T>(probe: () => T | null, timeoutMs: number, everyMs = 150): Promise<T | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = probe();
      if (value) return value;
      if (Date.now() > deadline) return null;
      await sleep(everyMs);
    }
  }

  function firstMatching(selectors: string[], root: ParentNode = document): Element | null {
    for (const selector of selectors) {
      const el = root.querySelector(selector);
      if (el && isVisible(el)) return el;
    }
    return null;
  }

  function buttonByName(patterns: RegExp[], root: ParentNode = document): Element | null {
    const candidates = Array.from(root.querySelectorAll('[role="button"], button, [data-testid]'));
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const name = accessibleName(el).trim();
      if (patterns.some((pattern) => pattern.test(name))) return el;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Adaptadores de redes sociales
  // -------------------------------------------------------------------------

  type PostOptions = { dryRun: boolean; expectedAccount?: string; deadlineAt?: number; groups?: string[] };

  /** Quita la arroba y normaliza, para que "@Ahiram1701" y "ahiram1701" sean la misma cuenta. */
  function accountKey(value: string): string {
    return norm(value).replace(/^@/, "");
  }

  function xAccount(): string | null {
    const href = document.querySelector(SOCIAL.x.accountLink)?.getAttribute("href") ?? "";
    let path = href;
    try {
      path = new URL(href, location.href).pathname;
    } catch {
      // href vacio o raro: se usa tal cual.
    }
    const handle = path.split("/").filter(Boolean)[0];
    return handle ? `@${handle}` : null;
  }

  /**
   * Los dos sitios donde Facebook dice quien publica. El saludo del composer desaparece en cuanto
   * hay un borrador guardado, que es justo cuando mas falta hace saberlo; el acceso directo de la
   * barra lateral sobrevive y tambien cambia al actuar como una pagina.
   */
  /** Primer enlace a un perfil o pagina dentro de `scope`, con su tramo de URL y su texto. */
  function facebookProfileLink(scope: ParentNode): { slug: string; nombre: string } | null {
    for (const link of Array.from(scope.querySelectorAll("a[href]"))) {
      if (!isVisible(link)) continue;
      let path: string;
      try {
        path = new URL(link.getAttribute("href") ?? "", location.href).pathname;
      } catch {
        continue;
      }
      // Un solo tramo: "/Ahiram1701" o "/profile.php" son perfiles; "/groups/..." no.
      const [tramo, ...resto] = path.split("/").filter(Boolean);
      if (!tramo || resto.length > 0 || SOCIAL.facebook.navSections.has(tramo.toLowerCase())) continue;
      return { slug: tramo, nombre: visibleText(link).trim() };
    }
    return null;
  }

  function facebookAccountNames(): { saludo: string | null; barra: string | null; slug: string | null } {
    let saludo: string | null = null;
    for (const el of Array.from(document.querySelectorAll('[role="button"], [role="textbox"], [aria-placeholder]'))) {
      if (saludo) break;
      if (!isVisible(el)) continue;
      for (const candidate of [el.getAttribute("aria-placeholder") ?? "", accessibleName(el)]) {
        for (const pattern of SOCIAL.facebook.accountInPrompt) {
          const match = candidate.trim().match(pattern);
          if (match?.[1] && !saludo) saludo = match[1].trim();
        }
      }
    }

    const dialogo = firstMatching(['[role="dialog"]']);
    const autor = dialogo ? facebookProfileLink(dialogo) : null;

    let barraLink: { slug: string; nombre: string } | null = null;
    for (const nav of Array.from(document.querySelectorAll('[role="navigation"]'))) {
      barraLink = facebookProfileLink(nav);
      if (barraLink?.nombre) break;
    }

    // Si el autor del dialogo y el perfil de la barra no son el mismo, no se sabe quien publicaria.
    if (autor && barraLink && autor.slug.toLowerCase() !== barraLink.slug.toLowerCase()) {
      return { saludo: null, barra: null, slug: null };
    }

    return { saludo, barra: barraLink?.nombre || null, slug: autor?.slug ?? barraLink?.slug ?? null };
  }

  /**
   * Nombre con el que se publicaria, o null si no se puede saber o las dos fuentes se contradicen.
   * "Ahiram" y "Ahiram SG" son la misma identidad; "Impulsa CV" y "Ahiram SG" no.
   */
  function facebookAccount(): string | null {
    const { saludo, barra, slug } = facebookAccountNames();
    if (saludo && barra) {
      const unas = accountKey(saludo).split(" ");
      const otras = accountKey(barra).split(" ");
      const cortas = unas.length <= otras.length ? unas : otras;
      const largas = unas.length <= otras.length ? otras : unas;
      if (!cortas.every((palabra, i) => palabra === largas[i])) return null;
    }
    return saludo ?? barra ?? slug;
  }

  /**
   * Publicar exige decir con que cuenta, y se comprueba ANTES de escribir nada: una sesion de
   * Facebook que actua como pagina publicaria en nombre de la pagina sin avisar.
   */
  function checkAccount(detected: string | null, options: PostOptions, aliases: string[] = []): void {
    if (!options.dryRun && !options.expectedAccount) {
      throw Object.assign(
        new Error(
          "Para publicar de verdad hay que indicar expectedAccount. Lanza antes un dryRun: devuelve en 'account' " +
            "la cuenta activa" + (detected ? ` (ahora: ${JSON.stringify(detected)}).` : "."),
        ),
        { webbotCode: "account_required" },
      );
    }
    if (!options.expectedAccount) return;
    if (!detected) {
      throw Object.assign(new Error("No se pudo determinar con que cuenta se publicaria, asi que no se publica nada."), {
        webbotCode: "account_mismatch",
      });
    }
    // Vale cualquiera de los nombres con los que la red llama a esa misma identidad.
    const esperado = accountKey(options.expectedAccount);
    if (![detected, ...aliases].some((name) => accountKey(name) === esperado)) {
      throw Object.assign(
        new Error(
          `La cuenta activa es ${JSON.stringify(detected)}, no ${JSON.stringify(options.expectedAccount)}. No se ha tocado nada.`,
        ),
        { webbotCode: "account_mismatch" },
      );
    }
  }

  /** Ultima comprobacion antes del unico clic que no tiene vuelta atras. */
  function checkDeadline(options: PostOptions): void {
    if (options.deadlineAt === undefined || Date.now() <= options.deadlineAt) return;
    throw Object.assign(
      new Error("Se agoto el plazo antes de pulsar Publicar: el servidor ya no esperaba la respuesta. No se ha publicado nada."),
      { webbotCode: "deadline_exceeded" },
    );
  }

  async function postToX(text: string, options: PostOptions): Promise<Record<string, unknown>> {
    if (options.groups?.length) {
      throw Object.assign(new Error("X no tiene grupos: 'groups' solo vale para Facebook."), {
        webbotCode: "bad_request",
      });
    }
    const account = xAccount();
    checkAccount(account, options);

    let composer = firstMatching(SOCIAL.x.composer);
    if (!composer) {
      const opener = firstMatching(SOCIAL.x.openComposer);
      if (opener) {
        dispatchClick(opener);
        composer = await until(() => firstMatching(SOCIAL.x.composer), 8_000);
      }
    }
    if (!composer) {
      throw Object.assign(new Error("No se encontro el cuadro de redaccion de X. Comprueba que la sesion esta iniciada."), {
        webbotCode: "composer_not_found",
      });
    }

    await writeComposer(composer, text, 400);

    const button = await until(() => {
      const el = firstMatching(SOCIAL.x.postButton) ?? buttonByName(SOCIAL.x.postButtonNames);
      if (!el) return null;
      return el.getAttribute("aria-disabled") === "true" ? null : el;
    }, 5_000);

    if (!button) {
      throw Object.assign(new Error("El boton de publicar de X sigue deshabilitado: el texto no llego al editor o supera el limite."), {
        webbotCode: "post_button_disabled",
      });
    }

    if (options.dryRun) {
      const found = { composer: describeElement(composer), button: describeElement(button), wrote: rawText(composer) };
      const tidied = await tidyAfterDryRun(composer, SOCIAL.x.closeNames);
      return { network: "x", dryRun: true, posted: false, account, ...found, tidied, text };
    }

    checkDeadline(options);
    dispatchClick(button);
    const cleared = await until(() => {
      const current = firstMatching(SOCIAL.x.composer);
      return !current || visibleText(current).length === 0 ? true : null;
    }, 10_000);

    return { network: "x", dryRun: false, posted: true, confirmed: cleared === true, account, url: location.href, text };
  }

  /**
   * El boton que abre el cuadro de publicacion del feed. Normalmente su texto es el saludo, pero
   * cuando Facebook guarda un borrador pasa a mostrar el borrador, y buscarlo por texto deja de
   * funcionar. El respaldo se ancla en los botones fijos de la tarjeta (Foto/video, Reel, Video en
   * vivo) y sube buscando el unico boton sin aria-label y con texto que hay dentro: si hubiera mas
   * de un candidato no se devuelve ninguno, porque pulsar a ciegas en el feed no es aceptable.
   */
  function facebookComposerOpener(): Element | null {
    const byName = buttonByName(SOCIAL.facebook.openComposerNames);
    if (byName) return byName;

    const anchor = buttonByName(SOCIAL.facebook.composerCardNames);
    if (!anchor) return null;

    let node: Element | null = anchor.parentElement;
    for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
      const candidates = Array.from(node.querySelectorAll('[role="button"]')).filter(
        (el) => isVisible(el) && !el.hasAttribute("aria-label") && !el.contains(anchor) && visibleText(el).trim().length > 0,
      );
      if (candidates.length === 1) return candidates[0] ?? null;
      if (candidates.length > 1) return null;
    }
    return null;
  }

  /**
   * Un composer ya abierto en la pantalla de configuracion no muestra el cuadro de texto, asi que
   * parecia que no hubiera composer y se intentaba abrir otro: Facebook acababa con dos dialogos
   * apilados y el segundo tapando al primero. Se reconoce esa pantalla por estructura, no por su
   * titulo, que depende del idioma: es el dialogo visible que tiene a la vez un boton de volver y
   * uno de publicar. Volviendo se recupera el composer en vez de crear otro.
   */
  async function facebookBackToComposer(): Promise<Element | null> {
    const settings = Array.from(document.querySelectorAll('[role="dialog"]')).find(
      (dialog) =>
        isVisible(dialog) &&
        buttonByName(SOCIAL.facebook.backNames, dialog) !== null &&
        buttonByName(SOCIAL.facebook.postButtonNames, dialog) !== null,
    );
    if (!settings) return null;

    const back = buttonByName(SOCIAL.facebook.backNames, settings);
    if (!back) return null;

    dispatchClick(back);
    return until(() => firstMatching(SOCIAL.facebook.composer), 5_000);
  }

  /** Lo que en el selector es un grupo y no un control. */
  function groupCandidates(picker: Element): Element[] {
    const vistos = new Set<string>();
    const found: Element[] = [];
    for (const el of Array.from(picker.querySelectorAll('[role="button"], button'))) {
      if (!isVisible(el)) continue;
      const name = accessibleName(el).trim();
      if (!name || vistos.has(name)) continue;
      if (SOCIAL.facebook.pickerNoise.some((pattern) => pattern.test(name))) continue;
      vistos.add(name);
      found.push(el);
      if (found.length >= 40) break;
    }
    return found;
  }

  /**
   * Elige grupos en la pantalla de configuracion y vuelve a ella. Cada nombre pedido selecciona
   * COMO MUCHO UN grupo: 'memes' podria encajar con cinco, y publicar en cinco sitios porque una
   * palabra era ambigua no es una sorpresa que se pueda deshacer. Los demas se devuelven en
   * 'groupsAvailable' para que quien pida pueda nombrarlos uno a uno si los quiere.
   */
  async function selectFacebookGroups(wanted: string[]): Promise<Record<string, unknown>> {
    const opener = buttonByName(SOCIAL.facebook.shareToGroupsNames);
    if (!opener) {
      throw Object.assign(
        new Error(
          "No aparece la opcion 'Compartir en grupos' en esta publicacion. Facebook no la ofrece siempre: " +
            "depende del tipo de publicacion y de si tienes grupos donde puedas publicar.",
        ),
        { webbotCode: "element_not_found" },
      );
    }
    dispatchClick(opener);

    // El selector es el dialogo que trae el boton de confirmar; por titulo no vale, depende del idioma.
    const picker = await until(
      () =>
        Array.from(document.querySelectorAll('[role="dialog"]')).find(
          (dialog) => isVisible(dialog) && buttonByName(SOCIAL.facebook.doneNames, dialog) !== null,
        ) ?? null,
      8_000,
    );
    if (!picker) {
      throw Object.assign(new Error("El selector de grupos de Facebook no llego a abrirse."), {
        webbotCode: "element_not_found",
      });
    }

    const candidates = groupCandidates(picker);
    const groupsAvailable = candidates.map((el) => accessibleName(el).trim());
    const groupsMatched: string[] = [];
    const groupsMissing: string[] = [];

    for (const needle of wanted) {
      const aguja = norm(needle);
      const hit = candidates.find((el) => {
        const name = accessibleName(el).trim();
        return !groupsMatched.includes(name) && norm(name).includes(aguja);
      });
      if (!hit) {
        groupsMissing.push(needle);
        continue;
      }
      dispatchClick(hit);
      groupsMatched.push(accessibleName(hit).trim());
      await sleep(350);
    }

    // Confirmar y volver a la pantalla donde vive Publicar, se haya elegido algo o no.
    const done = buttonByName(SOCIAL.facebook.doneNames, picker);
    if (done) {
      dispatchClick(done);
      await until(() => (picker.isConnected ? null : true), 5_000);
    }

    /**
     * Pedir grupos y acabar publicando solo en el muro seria la peor de las salidas: se parece
     * tanto a haber acertado que nadie lo mira. Mejor no publicar nada y decir que hay.
     */
    if (groupsMatched.length === 0) {
      throw Object.assign(
        new Error(
          `Ninguno de los grupos pedidos (${wanted.join(", ")}) esta entre los que Facebook ofrece aqui: ` +
            `${groupsAvailable.join(" | ") || "ninguno"}. No se ha publicado nada.`,
        ),
        { webbotCode: "element_not_found" },
      );
    }

    return { groupsMatched, groupsMissing, groupsAvailable };
  }

  /** Como buttonByName pero tambien mira menus y enlaces: un destino no siempre es un boton. */
  function optionByName(patterns: RegExp[], root: ParentNode): Element | null {
    for (const el of Array.from(root.querySelectorAll('[role="button"], [role="menuitem"], button, a[href]'))) {
      if (!isVisible(el)) continue;
      if (patterns.some((pattern) => pattern.test(accessibleName(el).trim()))) return el;
    }
    return null;
  }

  /**
   * La publicacion a la que pertenece un elemento. Acotar importa mas de lo que parece: el feed
   * esta lleno de botones 'Compartir' identicos, y pulsar el primero de la pagina compartiria una
   * publicacion cualquiera en vez de la que se pidio.
   */
  function facebookPostContainer(el: Element): Element {
    for (const selector of SOCIAL.facebook.share.containers) {
      const found = el.closest(selector);
      if (found) return found;
    }
    // Sin contenedor reconocible se sube hasta el primer antepasado que tenga un Compartir dentro.
    let node: Element | null = el;
    for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
      if (buttonByName(SOCIAL.facebook.share.buttonNames, node)) return node;
    }
    throw Object.assign(
      new Error(
        "No se pudo acotar la publicacion a la que pertenece ese elemento, y sin acotarla no se pulsa " +
          "ningun Compartir: seria el de otra publicacion del feed.",
      ),
      { webbotCode: "element_not_found" },
    );
  }

  /**
   * Comparte una publicacion que ya existe. Solo abre el camino que pasa por un composer, para
   * que el resto —identidad, ensayo, tarjeta, recogida— sea exactamente el mismo que al publicar.
   */
  async function sharePost(
    target: Target,
    comment: string,
    options: PostOptions & { expectedPost?: string },
  ): Promise<Record<string, unknown>> {
    const container = facebookPostContainer(findOne(target));
    // Extracto de lo que se va a compartir: es lo que se comprueba y lo que se ensena en la tarjeta.
    const sharing = visibleText(container).replace(/\s+/g, " ").trim().slice(0, 200);

    /**
     * Se comprueba ANTES de tocar nada, igual que la cuenta y por el mismo motivo: un feed se
     * reordena solo, asi que entre el ensayo y la publicacion de verdad el mismo target puede
     * haber pasado a apuntar a otra publicacion. Compartir la equivocada no se deshace.
     */
    if (!options.dryRun) {
      if (!options.expectedPost) {
        throw Object.assign(
          new Error(
            "Para compartir de verdad hay que indicar expectedPost. Lanza antes un dryRun: devuelve en " +
              "'sharing' el extracto de la publicacion que se compartiria.",
          ),
          { webbotCode: "account_required" },
        );
      }
      if (!norm(sharing).includes(norm(options.expectedPost).slice(0, 120))) {
        throw Object.assign(
          new Error(
            `La publicacion que hay ahora bajo ese target no es la del ensayo. Se esperaba ` +
              `${JSON.stringify(options.expectedPost.slice(0, 80))} y hay ${JSON.stringify(sharing.slice(0, 80))}. ` +
              "No se ha compartido nada.",
          ),
          { webbotCode: "account_mismatch" },
        );
      }
    }

    const shareButton = buttonByName(SOCIAL.facebook.share.buttonNames, container);
    if (!shareButton) {
      throw Object.assign(
        new Error("Esa publicacion no tiene boton de compartir visible: puede estar limitada por su autor."),
        { webbotCode: "element_not_found" },
      );
    }

    // El menu se reconoce por ser NUEVO, no por su titulo: el feed ya tiene menus abiertos suyos.
    const antes = new Set(Array.from(document.querySelectorAll('[role="dialog"], [role="menu"]')));
    dispatchClick(shareButton);
    const menu = await until(
      () =>
        Array.from(document.querySelectorAll('[role="dialog"], [role="menu"]')).find(
          (el) => !antes.has(el) && isVisible(el),
        ) ?? null,
      8_000,
    );
    if (!menu) {
      throw Object.assign(new Error("El menu de compartir de Facebook no llego a abrirse."), {
        webbotCode: "element_not_found",
      });
    }

    const destino = optionByName(SOCIAL.facebook.share.toFeedNames, menu);
    if (!destino) {
      // Se dicen los destinos que SI hay: los nombres cambian con el idioma y con la version de
      // Facebook, y leerlos aqui es lo que permite corregir el patron sin adivinar.
      const ofrecidos = Array.from(menu.querySelectorAll('[role="button"], [role="menuitem"], button, a[href]'))
        .filter((el) => isVisible(el) && accessibleName(el).trim())
        .map((el) => accessibleName(el).trim())
        .filter((name) => !SOCIAL.facebook.share.noise.some((pattern) => pattern.test(name)))
        .slice(0, 20);
      throw Object.assign(
        new Error(
          "No se reconocio ninguna opcion de compartir que abra un cuadro de publicacion. Facebook ofrece " +
            `aqui: ${ofrecidos.join(" | ") || "nada reconocible"}.`,
        ),
        { webbotCode: "element_not_found" },
      );
    }

    dispatchClick(destino);
    const composer = await until(() => firstMatching(SOCIAL.facebook.composer), 10_000);
    if (!composer) {
      throw Object.assign(
        new Error(
          "Tras elegir el destino no se abrio ningun cuadro de publicacion. No se ha compartido nada, pero " +
            "revisa la pestana por si quedo algo abierto.",
        ),
        { webbotCode: "composer_not_found" },
      );
    }

    return publishFromComposer(composer, comment, options, { shared: true, sharing });
  }

  async function postToFacebook(text: string, options: PostOptions): Promise<Record<string, unknown>> {
    let composer = firstMatching(SOCIAL.facebook.composer);

    // Antes de abrir uno nuevo: puede haber un composer abierto en la pantalla de configuracion.
    if (!composer) composer = await facebookBackToComposer();

    if (!composer) {
      const opener = facebookComposerOpener();
      if (!opener) {
        throw Object.assign(
          new Error(
            "No se encontro el boton que abre el cuadro de publicacion de Facebook. Comprueba que estas en facebook.com " +
              "con la sesion iniciada.",
          ),
          { webbotCode: "composer_not_found" },
        );
      }
      dispatchClick(opener);
      composer = await until(() => firstMatching(SOCIAL.facebook.composer), 10_000);
      if (!composer) {
        throw Object.assign(new Error("El dialogo de publicacion de Facebook no llego a abrirse."), {
          webbotCode: "composer_not_found",
        });
      }
    }

    return publishFromComposer(composer, text, options);
  }

  /**
   * De un composer abierto a la publicacion hecha. Lo comparten publicar y compartir: llegar al
   * composer es lo unico que cambia entre los dos, y todo lo delicado —comprobar la identidad, el
   * ensayo, el paso de dos pantallas, los grupos, la recogida— pasa de aqui para abajo.
   *
   * `extra` son los campos que solo tienen sentido en uno de los dos caminos, como que se estaba
   * compartiendo.
   */
  async function publishFromComposer(
    composer: Element,
    text: string,
    options: PostOptions,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    /**
     * La identidad se comprueba con el composer ya abierto y antes de escribir nada: en el dialogo
     * esta el autor del post, y una pagina recien traida al frente puede no haber pintado todavia
     * la barra lateral. Abrir el dialogo no publica, asi que abortar aqui sigue sin dejar rastro.
     */
    const names =
      (await until(() => {
        const found = facebookAccountNames();
        return found.saludo || found.barra || found.slug ? found : null;
      }, 3_000)) ?? facebookAccountNames();
    const account = facebookAccount();
    // Sin identidad clara no se ofrece ningun alias: si las fuentes se contradicen, no vale ninguna.
    const accountAliases = account
      ? [names.saludo, names.barra, names.slug].filter((name): name is string => Boolean(name))
      : [];
    checkAccount(account, options, accountAliases);

    // Compartir sin comentario es no escribir nada, no escribir vacio.
    if (text) await writeComposer(composer, text, 600);
    // Se describe el composer AQUI: si hay que avanzar de pantalla, Facebook se lleva el texto a
    // su propio estado y el elemento queda oculto y vacio, que es una foto enganosa del dryRun.
    const composerAtWrite = describeElement(composer);

    /**
     * El ambito de busqueda del boton sale del composer hacia arriba, nunca de un
     * querySelector('[role=dialog]') global: el primer dialogo de la pagina puede ser cualquier
     * otro panel abierto (notificaciones, chat). Buscarlo asi acababa mirando en el dialogo
     * equivocado o, si ninguno estaba abierto todavia, en el documento entero.
     */
    const dialogEl = composer.closest('[role="dialog"]');
    const scope: ParentNode = dialogEl ?? composer.closest("form") ?? document;

    const publishIn = (root: ParentNode): Element | null => {
      const el = buttonByName(SOCIAL.facebook.postButtonNames, root);
      if (!el) return null;
      return el.getAttribute("aria-disabled") === "true" ? null : el;
    };

    /**
     * Si el composer acaba en "Siguiente", "Publicar" vive en la pantalla de configuracion que
     * viene detras. Se avanza y se busca alli, recorriendo los dialogos abiertos porque el nuevo
     * no es el que contenia el composer.
     */
    const findPublish = (timeoutMs: number): Promise<Element | null> =>
      until(() => {
        for (const dlg of Array.from(document.querySelectorAll('[role="dialog"]'))) {
          const el = publishIn(dlg);
          if (el) return el;
        }
        return null;
      }, timeoutMs);

    /**
     * Se esperan los dos a la vez. Antes se agotaban los 4 s buscando "Publicar" en una pantalla
     * que solo tiene "Siguiente", y ese tiempo muerto se pagaba entero en cada publicacion de las
     * que van en dos pasos.
     *
     * "Siguiente" no se acepta hasta pasado un margen: un "Publicar" que todavia esta
     * deshabilitado porque el editor no ha confirmado el texto se habilita en cuanto lo hace, y
     * avanzar de pantalla ahi seria irse por el camino largo sin necesidad. Los dos botones no
     * suelen convivir, pero el margen sale barato y la equivocacion no.
     */
    const GRACIA_SIGUIENTE_MS = 800;
    const empezo = Date.now();
    const primero = await until<{ publish?: Element; next?: Element }>(() => {
      const publish = publishIn(scope);
      if (publish) return { publish };
      if (Date.now() - empezo < GRACIA_SIGUIENTE_MS) return null;
      const next = buttonByName(SOCIAL.facebook.nextStepNames, scope);
      return next ? { next } : null;
    }, 4_000);

    let button = primero?.publish ?? null;
    let advancedStep = false;
    if (!button && primero?.next) {
      dispatchClick(primero.next);
      advancedStep = true;
      button = await findPublish(8_000);
    }

    if (!button) {
      throw Object.assign(
        new Error(
          advancedStep
            ? "No aparecio un boton 'Publicar' habilitado en Facebook ni tras avanzar con 'Siguiente'."
            : "El boton 'Publicar' de Facebook no aparecio habilitado tras escribir el texto.",
        ),
        { webbotCode: "post_button_disabled" },
      );
    }

    /**
     * Los grupos se eligen AQUI: la opcion vive en la misma pantalla que Publicar, y tiene que
     * estar resuelta antes de pulsarlo. Elegir repinta el dialogo, asi que el boton se vuelve a
     * buscar: el de antes ya no esta en el arbol.
     */
    let groups: Record<string, unknown> = {};
    if (options.groups?.length) {
      groups = await selectFacebookGroups(options.groups);
      button = await findPublish(8_000);
      if (!button) {
        throw Object.assign(new Error("Tras elegir los grupos no volvio a aparecer un boton 'Publicar' habilitado."), {
          webbotCode: "post_button_disabled",
        });
      }
    }

    if (options.dryRun) {
      const found = { composer: composerAtWrite, button: describeElement(button), wrote: rawText(composer) };
      const tidied = await tidyAfterDryRun(composer, SOCIAL.facebook.closeNames, advancedStep);
      return { network: "facebook", dryRun: true, posted: false, account, accountAliases, advancedStep, ...found, ...groups, ...extra, tidied, text };
    }

    checkDeadline(options);
    dispatchClick(button);
    // Se confirma con el dialogo que contenia ESTE composer, o con que el composer se vacie
    // cuando no habia dialogo. Antes bastaba con que hubiera cualquier otro panel abierto para
    // que la confirmacion no llegara nunca.
    const closed = await until(() => {
      if (dialogEl) return dialogEl.isConnected ? null : true;
      return composer.isConnected && rawText(composer).length > 0 ? null : true;
    }, 15_000);

    return { network: "facebook", dryRun: false, posted: true, confirmed: closed === true, account, accountAliases, ...groups, ...extra, url: location.href, text };
  }

  // -------------------------------------------------------------------------
  // API publica
  // -------------------------------------------------------------------------

  const api: WebbotApi = {
    version: RUNTIME_VERSION_INNER,

    describe(target) {
      // Inspeccionar si ve lo oculto: es la herramienta para entender por que algo no se puede pulsar.
      return findAll(target, true).slice(0, 20).map(describeElement);
    },

    outline({ maxNodes }) {
      const nodes = interactiveElements(maxNodes ?? 200).map((el, index) => ({ index, ...describeElement(el) }));
      // El dialogo abierto se dice aparte: mientras lo haya, lo demas de la lista no se puede pulsar.
      return { url: location.href, title: document.title, count: nodes.length, elements: nodes, dialog: openDialog() };
    },

    extract({ mode, selectors, profile, maxChars }) {
      const effectiveMode: ExtractMode = mode ?? "readable";
      const limit = maxChars ?? 100_000;
      const fields: Record<string, FieldSpec> = { ...(profile?.fields ?? {}), ...(selectors ?? {}) };

      const base = {
        url: location.href,
        title: document.title,
        profile: profile?.id ?? null,
        mode: effectiveMode,
      };

      if (effectiveMode === "selectors") {
        if (Object.keys(fields).length === 0) {
          throw new Error("mode='selectors' necesita el parametro 'selectors' (o un dominio con perfil registrado).");
        }
        const values: Record<string, unknown> = {};
        for (const [name, spec] of Object.entries(fields)) values[name] = readField(spec);
        return { ...base, fields: values };
      }

      const container = effectiveMode === "full" ? document.body : pickContainer(profile);
      const removeSelectors = effectiveMode === "full" ? (profile?.remove ?? []) : [...READABLE_NOISE, ...(profile?.remove ?? [])];
      const text = textFrom(container, removeSelectors);
      const values: Record<string, unknown> = {};
      for (const [name, spec] of Object.entries(fields)) values[name] = readField(spec);

      return {
        ...base,
        meta: {
          description: metaContent("og:description", "description"),
          author: metaContent("article:author", "author") ?? authorFromDom(),
          published: metaContent("article:published_time", "date") ?? document.querySelector("time[datetime]")?.getAttribute("datetime") ?? undefined,
          lang: document.documentElement.lang || undefined,
          canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? undefined,
        },
        container: cssPath(container),
        chars: text.length,
        truncated: text.length > limit,
        text: text.slice(0, limit),
        ...(Object.keys(values).length > 0 ? { fields: values } : {}),
      };
    },

    links({ contains, sameOrigin }) {
      const needle = contains ? norm(contains) : null;
      const origin = location.origin;
      const links = Array.from(document.querySelectorAll("a[href]"))
        .filter((el): el is HTMLAnchorElement => el instanceof HTMLAnchorElement)
        // Las anclas internas y los javascript: no llevan a ninguna parte: son ruido para el agente.
        .filter((el) => {
          const raw = el.getAttribute("href")?.trim() ?? "";
          return !raw.startsWith("#") && !raw.toLowerCase().startsWith("javascript:");
        })
        .map((el) => ({ text: visibleText(el).slice(0, 120), href: el.href }))
        .filter((link) => link.href.startsWith("http"))
        .filter((link) => (sameOrigin ? link.href.startsWith(origin) : true))
        .filter((link) => (needle ? norm(link.text).includes(needle) || norm(link.href).includes(needle) : true));

      const unique = new Map<string, { text: string; href: string }>();
      for (const link of links) if (!unique.has(link.href)) unique.set(link.href, link);
      const result = Array.from(unique.values());
      return { url: location.href, count: result.length, links: result.slice(0, 500) };
    },

    async click({ target }) {
      const el = clickableFrom(findOne(target));
      el.scrollIntoView({ block: "center", inline: "center" });
      const described = describeElement(el);
      if (described.disabled) {
        throw Object.assign(new Error(`El elemento esta deshabilitado: ${JSON.stringify(described)}`), {
          webbotCode: "element_not_found",
        });
      }
      // Ya no se guarda la url de antes: leerla en el mismo tick que el clic daba siempre la
      // misma, porque el navegador todavia no habia hecho nada. 'after' la mide cuando ya paro.
      const antes = snapshot();
      dispatchClick(el);
      return { clicked: described, after: await pageAfter(antes) };
    },

    async type({ target, text, clear, submit }) {
      const el = findOne(target);
      el.scrollIntoView({ block: "center" });
      const antes = snapshot();

      // Lexical necesita esperar a su propio "seleccionar todo"; el resto escribe en el acto. Un
      // elemento que no admite texto sigue fallando antes de tocar nada, ahora como rechazo.
      const lexical = (clear ?? true) ? lexicalRoot(el) : null;
      if (lexical) await setLexicalText(lexical, text);
      else setText(el, text, clear ?? true);

      if (submit) {
        const init = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 };
        el.dispatchEvent(new KeyboardEvent("keydown", init));
        el.dispatchEvent(new KeyboardEvent("keypress", init));
        el.dispatchEvent(new KeyboardEvent("keyup", init));
        if (el instanceof HTMLInputElement) el.form?.requestSubmit?.();
      }
      const value = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : visibleText(el);
      return {
        typed: describeElement(el),
        value: value.slice(0, 500),
        submitted: Boolean(submit),
        after: await pageAfter(antes),
      };
    },

    async scroll({ direction, amount }) {
      const step = amount ?? window.innerHeight;
      const antes = snapshot();
      if (direction === "top") window.scrollTo({ top: 0 });
      else if (direction === "bottom") window.scrollTo({ top: document.body.scrollHeight });
      else window.scrollBy({ top: direction === "down" ? step : -step });
      // Bajar suele cargar contenido nuevo: aqui el diff es justo lo que hay que ver.
      const after = await pageAfter(antes);
      return { scrollY: window.scrollY, scrollHeight: document.body.scrollHeight, after };
    },

    async waitFor({ target, timeoutMs }) {
      const found = await until(() => {
        const matches = findAll(target);
        return matches[target.index ?? 0] ?? null;
      }, timeoutMs ?? 10_000);
      if (!found) {
        throw Object.assign(new Error(`Se agoto la espera de ${JSON.stringify(target)} tras ${timeoutMs ?? 10_000} ms.`), {
          webbotCode: "element_not_found",
        });
      }
      return { found: describeElement(found), url: location.href };
    },

    async sharePost({ target, comment, dryRun, expectedAccount, expectedPost, deadlineAt }) {
      if (document.visibilityState === "hidden") {
        throw Object.assign(new Error("La pestana no esta visible. Traela al primer plano y reintenta."), {
          webbotCode: "tab_hidden",
        });
      }
      return sharePost(target, comment ?? "", { dryRun: dryRun ?? false, expectedAccount, expectedPost, deadlineAt });
    },

    async postSocial({ network, text, dryRun, expectedAccount, deadlineAt, groups }) {
      // Una pagina oculta tiene los temporizadores congelados: el flujo avanzaria a trompicones y
      // podria llegar a Publicar cuando ya nadie espera. Mejor no empezar.
      if (document.visibilityState === "hidden") {
        throw Object.assign(new Error("La pestana de la red social no esta visible. Traela al primer plano y reintenta."), {
          webbotCode: "tab_hidden",
        });
      }
      const options: PostOptions = { dryRun: dryRun ?? false, expectedAccount, deadlineAt, groups };
      return network === "x" ? postToX(text, options) : postToFacebook(text, options);
    },
  };

  scope.__webbot = api;
}
