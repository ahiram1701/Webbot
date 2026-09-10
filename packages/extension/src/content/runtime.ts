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
  click(options: { target: Target }): unknown;
  type(options: { target: Target; text: string; clear?: boolean; submit?: boolean }): unknown;
  scroll(options: { direction: "up" | "down" | "top" | "bottom"; amount?: number }): unknown;
  waitFor(options: { target: Target; timeoutMs?: number }): Promise<unknown>;
  postSocial(options: { network: Network; text: string; dryRun?: boolean }): Promise<unknown>;
}

export const RUNTIME_VERSION = 1;

/**
 * Runtime que vive dentro de la pagina. Se inyecta con chrome.scripting.executeScript, que solo
 * transmite el TEXTO de la funcion: por eso todo (helpers, selectores, adaptadores) esta anidado
 * aqui dentro y no puede referirse a nada del modulo. Es idempotente: si ya esta instalado, sale.
 *
 * Los tipos importados arriba son solo tipos y se borran al compilar, asi que no rompen la
 * autonomia de la funcion.
 */
export function installWebbotRuntime(): void {
  const RUNTIME_VERSION_INNER = 1;
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
    },
    facebook: {
      openComposerNames: [
        /qu[eé] est[aá]s pensando/i,
        /what'?s on your mind/i,
        /crear publicaci[oó]n/i,
        /create post/i,
      ],
      composer: ['div[role="textbox"][contenteditable="true"]', '[data-lexical-editor="true"]'],
      postButtonNames: [/^publicar$/i, /^post$/i, /^compartir$/i, /^share$/i],
      // Facebook parte la publicacion en dos pantallas: el composer acaba en "Siguiente" y
      // "Publicar" vive en el dialogo de configuracion que viene despues.
      nextStepNames: [/^siguiente$/i, /^next$/i],
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
  function findAll(target: Target): Element[] {
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
    return visibles.length > 0 ? visibles : pool;
  }

  function findOne(target: Target): Element {
    const matches = findAll(target);
    const index = target.index ?? 0;
    const el = matches[index];
    if (!el) {
      const criterios = JSON.stringify(target);
      throw Object.assign(new Error(`No se encontro ningun elemento para ${criterios} (coincidencias: ${matches.length}).`), {
        webbotCode: "element_not_found",
      });
    }
    return el;
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

  /**
   * Editores con framework detras marcan como suyos los nodos de texto que salen de su modelo:
   * Draft.js (X) con data-text, Lexical (Facebook) con data-lexical-text.
   */
  const MANAGED_TEXT_SELECTOR = '[data-text="true"], [data-lexical-text="true"]';

  /** Texto colapsado tal cual esta en el DOM. No usa innerText a proposito: jsdom no lo implementa. */
  function rawText(el: Element): string {
    return (el.textContent ?? "").replace(/s+/g, " ").trim();
  }

  /** Lo que el editor reconoce como suyo, o null si no marca sus nodos. */
  function managedText(el: Element): string | null {
    const nodes = el.querySelectorAll(MANAGED_TEXT_SELECTOR);
    if (nodes.length === 0) return null;
    let out = "";
    for (const node of nodes) out += node.textContent ?? "";
    return out.replace(/s+/g, " ").trim();
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
    const wanted = text.replace(/s+/g, " ").trim();
    setText(composer, text, true);
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

  async function postToX(text: string, dryRun: boolean): Promise<Record<string, unknown>> {
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

    if (dryRun) {
      return { network: "x", dryRun: true, posted: false, composer: describeElement(composer), button: describeElement(button), text };
    }

    dispatchClick(button);
    const cleared = await until(() => {
      const current = firstMatching(SOCIAL.x.composer);
      return !current || visibleText(current).length === 0 ? true : null;
    }, 10_000);

    return { network: "x", dryRun: false, posted: true, confirmed: cleared === true, url: location.href, text };
  }

  async function postToFacebook(text: string, dryRun: boolean): Promise<Record<string, unknown>> {
    let composer = firstMatching(SOCIAL.facebook.composer);

    if (!composer) {
      const opener = buttonByName(SOCIAL.facebook.openComposerNames);
      if (!opener) {
        throw Object.assign(new Error("No se encontro el cuadro 'Que estas pensando' de Facebook. Abre facebook.com con la sesion iniciada."), {
          webbotCode: "composer_not_found",
        });
      }
      dispatchClick(opener);
      composer = await until(() => firstMatching(SOCIAL.facebook.composer), 10_000);
      if (!composer) {
        throw Object.assign(new Error("El dialogo de publicacion de Facebook no llego a abrirse."), {
          webbotCode: "composer_not_found",
        });
      }
    }

    await writeComposer(composer, text, 600);
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

    let button = await until(() => publishIn(scope), 4_000);

    /**
     * Si el composer acaba en "Siguiente", "Publicar" vive en la pantalla de configuracion que
     * viene detras. Se avanza y se busca alli, recorriendo los dialogos abiertos porque el nuevo
     * no es el que contenia el composer.
     */
    let advancedStep = false;
    if (!button) {
      const next = buttonByName(SOCIAL.facebook.nextStepNames, scope);
      if (next) {
        dispatchClick(next);
        advancedStep = true;
        button = await until(() => {
          for (const dlg of Array.from(document.querySelectorAll('[role="dialog"]'))) {
            const el = publishIn(dlg);
            if (el) return el;
          }
          return null;
        }, 8_000);
      }
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

    if (dryRun) {
      return { network: "facebook", dryRun: true, posted: false, advancedStep, composer: composerAtWrite, button: describeElement(button), text };
    }

    dispatchClick(button);
    // Se confirma con el dialogo que contenia ESTE composer, o con que el composer se vacie
    // cuando no habia dialogo. Antes bastaba con que hubiera cualquier otro panel abierto para
    // que la confirmacion no llegara nunca.
    const closed = await until(() => {
      if (dialogEl) return dialogEl.isConnected ? null : true;
      return composer.isConnected && rawText(composer).length > 0 ? null : true;
    }, 15_000);

    return { network: "facebook", dryRun: false, posted: true, confirmed: closed === true, url: location.href, text };
  }

  // -------------------------------------------------------------------------
  // API publica
  // -------------------------------------------------------------------------

  const api: WebbotApi = {
    version: RUNTIME_VERSION_INNER,

    describe(target) {
      return findAll(target).slice(0, 20).map(describeElement);
    },

    outline({ maxNodes }) {
      const limit = maxNodes ?? 200;
      const seen = new Set<Element>();
      const nodes: Record<string, unknown>[] = [];
      for (const el of Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR))) {
        if (nodes.length >= limit) break;
        if (seen.has(el) || !isVisible(el)) continue;
        const role = roleOf(el);
        if (role === "generic" && !el.hasAttribute("onclick")) continue;
        const name = accessibleName(el);
        if (!name && role !== "textbox") continue;
        seen.add(el);
        nodes.push({ index: nodes.length, ...describeElement(el) });
      }
      return { url: location.href, title: document.title, count: nodes.length, elements: nodes };
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

    click({ target }) {
      const el = clickableFrom(findOne(target));
      el.scrollIntoView({ block: "center", inline: "center" });
      const before = location.href;
      const described = describeElement(el);
      if (described.disabled) {
        throw Object.assign(new Error(`El elemento esta deshabilitado: ${JSON.stringify(described)}`), {
          webbotCode: "element_not_found",
        });
      }
      dispatchClick(el);
      return { clicked: described, urlBefore: before, urlAfter: location.href };
    },

    type({ target, text, clear, submit }) {
      const el = findOne(target);
      el.scrollIntoView({ block: "center" });
      setText(el, text, clear ?? true);
      if (submit) {
        const init = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 };
        el.dispatchEvent(new KeyboardEvent("keydown", init));
        el.dispatchEvent(new KeyboardEvent("keypress", init));
        el.dispatchEvent(new KeyboardEvent("keyup", init));
        if (el instanceof HTMLInputElement) el.form?.requestSubmit?.();
      }
      const value = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : visibleText(el);
      return { typed: describeElement(el), value: value.slice(0, 500), submitted: Boolean(submit) };
    },

    scroll({ direction, amount }) {
      const step = amount ?? window.innerHeight;
      if (direction === "top") window.scrollTo({ top: 0 });
      else if (direction === "bottom") window.scrollTo({ top: document.body.scrollHeight });
      else window.scrollBy({ top: direction === "down" ? step : -step });
      return { scrollY: window.scrollY, scrollHeight: document.body.scrollHeight };
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

    async postSocial({ network, text, dryRun }) {
      return network === "x" ? postToX(text, dryRun ?? false) : postToFacebook(text, dryRun ?? false);
    },
  };

  scope.__webbot = api;
}
