// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { installWebbotRuntime, RUNTIME_VERSION, type WebbotApi } from "./runtime.js";

/**
 * El runtime viaja a la pagina como TEXTO (chrome.scripting.executeScript solo serializa la
 * funcion, no su closure). Instalarlo aqui con `new Function` sobre su propio codigo fuente
 * reproduce esa condicion: si algun dia alguien referencia una variable del modulo desde dentro,
 * este test falla con ReferenceError en vez de fallar en produccion sobre una pagina real.
 */
function installFromSource(): WebbotApi {
  delete (globalThis as { __webbot?: unknown }).__webbot;
  const factory = new Function(`return (${installWebbotRuntime.toString()})`)() as () => void;
  factory();
  const api = (globalThis as { __webbot?: WebbotApi }).__webbot;
  if (!api) throw new Error("el runtime no se instalo");
  return api;
}

/**
 * jsdom no calcula layout ni implementa innerText, asi que sin estos apanos todo elemento seria
 * "invisible" y sin texto. En Chrome ambos son nativos.
 */
function patchJsdom(): void {
  Element.prototype.getClientRects = function getClientRects(this: Element) {
    const visible = this.isConnected && (this as HTMLElement).style?.display !== "none";
    const rects = visible ? [{ x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 }] : [];
    return Object.assign(rects, { item: (i: number) => rects[i] ?? null }) as unknown as DOMRectList;
  };
  Element.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, toJSON: () => ({}) }) as DOMRect;
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true,
    get(this: HTMLElement) {
      return this.textContent ?? "";
    },
  });
  Element.prototype.scrollIntoView = () => {};
}

let api: WebbotApi;

beforeEach(() => {
  patchJsdom();
  document.body.innerHTML = "";
  // Algunos tests sustituyen execCommand para imitar a un editor concreto.
  delete (document as { execCommand?: unknown }).execCommand;
  api = installFromSource();
});

/**
 * Imita lo medido con Lexical real: ignora la seleccion que un script fija con un Range y solo
 * actua sobre la suya, la que crea al recibir Ctrl+A. execCommand("delete") dice que si pero no
 * hace nada, igual que sobre Lexical.
 */
function editorTipoLexical(contenido: string): { el: HTMLElement; exec: ReturnType<typeof vi.fn> } {
  document.body.innerHTML = `<div id="lx" data-lexical-editor="true" contenteditable="true" role="textbox">${contenido}</div>`;
  const el = document.getElementById("lx") as HTMLElement;
  let todoSeleccionado = false;
  el.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "a") todoSeleccionado = true;
  });
  el.addEventListener("beforeinput", (event) => {
    event.preventDefault();
    if (event.inputType === "deleteContentBackward" && todoSeleccionado) el.textContent = "";
  });
  const exec = vi.fn((command: string, _ui: boolean, value: string) => {
    if (command === "insertText") {
      el.textContent = todoSeleccionado ? value : `${value}${el.textContent ?? ""}`;
      todoSeleccionado = false;
    }
    return true;
  });
  Object.defineProperty(document, "execCommand", { configurable: true, value: exec });
  return { el, exec };
}

describe("instalacion", () => {
  it("se instala a partir de su propio codigo fuente, sin depender del modulo", () => {
    // Atado a la constante: el runtime lleva su version duplicada dentro (no puede leer el
    // modulo), asi que esto tambien vigila que las dos copias no se separen.
    expect(api.version).toBe(RUNTIME_VERSION);
    expect(typeof api.click).toBe("function");
  });

  it("es idempotente", () => {
    const first = (globalThis as { __webbot?: WebbotApi }).__webbot;
    installWebbotRuntime();
    expect((globalThis as { __webbot?: WebbotApi }).__webbot).toBe(first);
  });
});

describe("click", () => {
  it("hace clic en un boton localizado por texto", async () => {
    document.body.innerHTML = `<button id="b">Aceptar todo</button>`;
    const spy = vi.fn();
    document.getElementById("b")?.addEventListener("click", spy);

    const result = (await api.click({ target: { text: "Aceptar" } })) as { clicked: { tag: string } };

    expect(spy).toHaveBeenCalledOnce();
    expect(result.clicked.tag).toBe("button");
  });

  it("sube del span al boton que lo contiene", async () => {
    document.body.innerHTML = `<button id="b"><span>Publicar</span></button>`;
    const spy = vi.fn();
    document.getElementById("b")?.addEventListener("click", spy);

    const result = (await api.click({ target: { text: "Publicar" } })) as { clicked: { tag: string } };

    expect(spy).toHaveBeenCalledOnce();
    expect(result.clicked.tag).toBe("button");
  });

  it("encuentra el texto ignorando acentos y mayusculas", async () => {
    document.body.innerHTML = `<button>Publicación</button>`;
    await expect(api.click({ target: { text: "publicacion" } })).resolves.toBeTruthy();
  });

  it("dispara pointerdown ademas de click, como esperan las UIs modernas", async () => {
    document.body.innerHTML = `<button id="b">Ir</button>`;
    const orden: string[] = [];
    const el = document.getElementById("b");
    for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
      el?.addEventListener(type, () => orden.push(type));
    }

    await api.click({ target: { css: "#b" } });

    expect(orden).toEqual(["pointerdown", "mousedown", "mouseup", "click"]);
  });

  it("falla con element_not_found si no hay coincidencias", async () => {
    document.body.innerHTML = `<button>Otro</button>`;
    try {
      await api.click({ target: { text: "No existe" } });
      throw new Error("deberia haber lanzado");
    } catch (error) {
      expect((error as { webbotCode?: string }).webbotCode).toBe("element_not_found");
    }
  });

  it("no pulsa un elemento oculto y distingue ese caso de que no exista", async () => {
    document.body.innerHTML = `<button id="b" style="display:none">Enviar</button>`;
    const spy = vi.fn();
    document.getElementById("b")?.addEventListener("click", spy);

    try {
      await api.click({ target: { text: "Enviar" } });
      throw new Error("deberia haber lanzado");
    } catch (error) {
      expect((error as { webbotCode?: string }).webbotCode).toBe("element_not_visible");
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("prefiere la coincidencia visible cuando hay otra oculta con el mismo texto", async () => {
    document.body.innerHTML = `
      <button id="oculto" style="display:none">Publicar</button>
      <button id="visible">Publicar</button>`;
    const enOculto = vi.fn();
    const enVisible = vi.fn();
    document.getElementById("oculto")?.addEventListener("click", enOculto);
    document.getElementById("visible")?.addEventListener("click", enVisible);

    await api.click({ target: { text: "Publicar" } });

    expect(enOculto).not.toHaveBeenCalled();
    expect(enVisible).toHaveBeenCalledOnce();
  });

  it("describe si deja inspeccionar un elemento oculto", () => {
    document.body.innerHTML = `<button id="b" style="display:none">Enviar</button>`;

    const result = api.describe({ text: "Enviar" }) as Array<{ visible: boolean; tag: string }>;

    expect(result).toHaveLength(1);
    expect(result[0]?.tag).toBe("button");
    expect(result[0]?.visible).toBe(false);
  });

  it("se niega a pulsar un elemento deshabilitado", async () => {
    document.body.innerHTML = `<button disabled>Enviar</button>`;
    await expect(api.click({ target: { text: "Enviar" } })).rejects.toThrow(/deshabilitado/i);
  });
});

describe("type", () => {
  it("escribe en un input y notifica el evento input", async () => {
    document.body.innerHTML = `<input id="q" value="viejo" />`;
    const input = document.getElementById("q") as HTMLInputElement;
    const spy = vi.fn();
    input.addEventListener("input", spy);

    await api.type({ target: { css: "#q" }, text: "nuevo", clear: true });

    expect(input.value).toBe("nuevo");
    expect(spy).toHaveBeenCalled();
  });

  it("anade al final cuando clear es false", async () => {
    document.body.innerHTML = `<input id="q" value="hola " />`;
    await api.type({ target: { css: "#q" }, text: "mundo", clear: false });
    expect((document.getElementById("q") as HTMLInputElement).value).toBe("hola mundo");
  });

  it("escribe en un contenteditable", async () => {
    document.body.innerHTML = `<div id="c" contenteditable="true"></div>`;
    await api.type({ target: { css: "#c" }, text: "un post", clear: true });
    expect(document.getElementById("c")?.textContent).toBe("un post");
  });

  it("vacia un contenteditable con clear y texto vacio, borrando en vez de insertar nada", async () => {
    // Visto en vivo con el borrador que Facebook guarda en su composer: en Chrome,
    // execCommand("insertText", "") devuelve true pero no borra la seleccion.
    document.body.innerHTML = `<div id="c" contenteditable="true">borrador guardado</div>`;
    const el = document.getElementById("c") as HTMLElement;
    const exec = vi.fn((command: string) => {
      if (command === "delete") el.textContent = "";
      return true;
    });
    Object.defineProperty(document, "execCommand", { configurable: true, value: exec });
    try {
      await api.type({ target: { css: "#c" }, text: "", clear: true });
    } finally {
      delete (document as { execCommand?: unknown }).execCommand;
    }

    expect(exec).toHaveBeenCalledWith("delete", false, "");
    expect(el.textContent).toBe("");
  });

  it("vacia un contenteditable aunque no exista execCommand", async () => {
    document.body.innerHTML = `<div id="c" contenteditable="true">borrador guardado</div>`;
    await api.type({ target: { css: "#c" }, text: "", clear: true });
    expect(document.getElementById("c")?.textContent).toBe("");
  });

  it("vacia un editor Lexical con su propio seleccionar todo, no con la seleccion del DOM", async () => {
    const { el, exec } = editorTipoLexical("probando webbot");

    await api.type({ target: { css: "#lx" }, text: "", clear: true });

    expect(el.textContent).toBe("");
    expect(exec).not.toHaveBeenCalledWith("delete", false, "");
  });

  it("reescribe un editor Lexical con borrador sin duplicar el texto", async () => {
    // Con la seleccion del DOM, insertText sobre el borrador de Lexical real dejaba "alfaalfa".
    const { el } = editorTipoLexical("probando webbot");

    await api.type({ target: { css: "#lx" }, text: "alfa", clear: true });

    expect(el.textContent).toBe("alfa");
  });

  it("rechaza elementos que no admiten texto", async () => {
    document.body.innerHTML = `<p id="p">texto</p>`;
    await expect(api.type({ target: { css: "#p" }, text: "x" })).rejects.toThrow(/no admite escritura/i);
  });
});

/**
 * Lo que devuelve una accion sobre el estado de despues. Es el nucleo de que el agente no tenga que
 * gastar un outline detras de cada clic para enterarse de lo que provoco.
 */
interface Despues {
  after: {
    url: string;
    title: string;
    appeared: Array<{ tag: string; role: string; name: string }>;
    disappeared: string[];
    dialog: null | { role: string; elements: Array<{ name: string }> };
  };
}

describe("observacion posterior a la accion", () => {
  it("cuenta los elementos que aparecieron al pulsar", async () => {
    document.body.innerHTML = `<button id="abrir">Abrir menu</button>`;
    document.getElementById("abrir")?.addEventListener("click", () => {
      document.body.insertAdjacentHTML("beforeend", `<button>Descargar</button><button>Compartir</button>`);
    });

    const result = (await api.click({ target: { text: "Abrir menu" } })) as Despues;

    expect(result.after.appeared.map((el) => el.name)).toEqual(["Descargar", "Compartir"]);
    expect(result.after.disappeared).toEqual([]);
  });

  it("cuenta los que desaparecieron, que es como se sabe que un banner se cerro", async () => {
    document.body.innerHTML = `
      <div id="banner"><button id="ok">Aceptar todo</button><button>Rechazar</button></div>`;
    document.getElementById("ok")?.addEventListener("click", () => {
      document.getElementById("banner")?.remove();
    });

    const result = (await api.click({ target: { text: "Aceptar todo" } })) as Despues;

    expect(result.after.disappeared).toContain("button|Aceptar todo");
    expect(result.after.disappeared).toContain("button|Rechazar");
    expect(result.after.dialog).toBeNull();
  });

  it("avisa del dialogo que esta tapando la pagina, con lo que se puede pulsar dentro", async () => {
    document.body.innerHTML = `<button id="abrir">Configurar</button>`;
    document.getElementById("abrir")?.addEventListener("click", () => {
      document.body.insertAdjacentHTML(
        "beforeend",
        `<div role="dialog" aria-label="Preferencias"><button>Guardar</button><button>Cancelar</button></div>`,
      );
    });

    const result = (await api.click({ target: { text: "Configurar" } })) as Despues;

    expect(result.after.dialog?.role).toBe("dialog");
    expect(result.after.dialog?.elements.map((el) => el.name)).toEqual(["Guardar", "Cancelar"]);
  });

  it("un repintado que solo cambia los selectores no se reporta como cambio", async () => {
    // Es lo que hace cualquier React al re-renderizar. Si la clave fuera el selector, aqui saldria
    // la pagina entera como nueva y el agente creeria que su clic hizo algo que no hizo.
    document.body.innerHTML = `
      <button id="ir">Ir</button>
      <div id="lista"><button class="r1">Uno</button><button class="r1">Dos</button></div>`;
    document.getElementById("ir")?.addEventListener("click", () => {
      const lista = document.getElementById("lista") as HTMLElement;
      lista.innerHTML = `<button class="r2">Uno</button><button class="r2">Dos</button>`;
    });

    const result = (await api.click({ target: { text: "Ir" } })) as Despues;

    expect(result.after.appeared).toEqual([]);
    expect(result.after.disappeared).toEqual([]);
  });

  it("una pagina quieta no agota el techo de espera", async () => {
    document.body.innerHTML = `<button>Nada</button>`;

    const empezo = Date.now();
    await api.click({ target: { text: "Nada" } });

    // El techo son 2 s; con la pagina quieta tiene que volver en cuanto pasa el silencio.
    expect(Date.now() - empezo).toBeLessThan(1_000);
  });

  it("scroll tambien dice que aparecio, que es como se ve el scroll infinito", async () => {
    // jsdom no tiene layout: window.scrollBy no hace nada ni dispara scroll. Se sustituye la
    // primitiva por lo que provoca en una pagina real, que es lo que aqui interesa comprobar.
    document.body.innerHTML = `<button>Arriba</button>`;
    window.scrollBy = () => {
      document.body.insertAdjacentHTML("beforeend", `<button id="mas">Cargar mas</button>`);
    };

    const result = (await api.scroll({ direction: "down" })) as Despues;

    expect(result.after.appeared.map((el) => el.name)).toEqual(["Cargar mas"]);
  });
});

describe("extract", () => {
  const PAGINA = `
    <nav>menu de navegacion</nav>
    <article>
      <h1>Titular</h1>
      <p>Primer parrafo del cuerpo con contenido suficiente para pasar el umbral de longitud del contenedor.</p>
      <p>Segundo parrafo.</p>
      <script>var basura = 1;</script>
    </article>
    <footer>pie de pagina</footer>`;

  it("modo readable devuelve el texto del articulo y descarta nav, footer y scripts", () => {
    document.body.innerHTML = PAGINA;
    const result = api.extract({ mode: "readable" }) as { text: string; chars: number };

    expect(result.text).toContain("Primer parrafo");
    expect(result.text).toContain("Segundo parrafo");
    expect(result.text).not.toContain("menu de navegacion");
    expect(result.text).not.toContain("pie de pagina");
    expect(result.text).not.toContain("basura");
    expect(result.chars).toBeGreaterThan(0);
  });

  it("modo full incluye todo el texto visible", () => {
    document.body.innerHTML = PAGINA;
    const result = api.extract({ mode: "full" }) as { text: string };
    expect(result.text).toContain("menu de navegacion");
  });

  it("respeta maxChars y lo senala", () => {
    document.body.innerHTML = PAGINA;
    const result = api.extract({ mode: "readable", maxChars: 10 }) as { text: string; truncated: boolean };
    expect(result.text).toHaveLength(10);
    expect(result.truncated).toBe(true);
  });

  it("modo selectors lee campos, atributos y listas", () => {
    document.body.innerHTML = `
      <h1 class="t">Producto</h1>
      <span class="price">19,90</span>
      <a class="l" href="https://ejemplo.com/a">A</a>
      <a class="l" href="https://ejemplo.com/b">B</a>`;

    const result = api.extract({
      mode: "selectors",
      selectors: {
        titulo: { css: ".t" },
        precio: { css: ".price" },
        enlaces: { css: ".l", attr: "href", all: true },
      },
    }) as { fields: Record<string, unknown> };

    expect(result.fields.titulo).toBe("Producto");
    expect(result.fields.precio).toBe("19,90");
    expect(result.fields.enlaces).toEqual(["https://ejemplo.com/a", "https://ejemplo.com/b"]);
  });

  it("aplica el perfil del dominio y deja que los selectores de la llamada lo sobrescriban", () => {
    document.body.innerHTML = `<h1 id="firstHeading">Del perfil</h1><span class="mio">Mio</span>`;

    const result = api.extract({
      mode: "selectors",
      profile: { id: "wikipedia", match: ["wikipedia.org"], fields: { titulo: { css: "#firstHeading" } } },
      selectors: { propio: { css: ".mio" } },
    }) as { profile: string; fields: Record<string, unknown> };

    expect(result.profile).toBe("wikipedia");
    expect(result.fields.titulo).toBe("Del perfil");
    expect(result.fields.propio).toBe("Mio");
  });

  it("exige selectores en modo selectors si no hay perfil", () => {
    expect(() => api.extract({ mode: "selectors" })).toThrow(/necesita el parametro/i);
  });
});

describe("links", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <a href="https://localhost/uno">Uno</a>
      <a href="https://otro.com/dos">Dos</a>
      <a href="https://localhost/uno">Duplicado</a>
      <a href="#ancla">Ancla</a>`;
  });

  it("deduplica y descarta los enlaces que no son http", () => {
    const result = api.links({}) as { links: { href: string }[] };
    expect(result.links).toHaveLength(2);
  });

  it("filtra por subcadena", () => {
    const result = api.links({ contains: "otro.com" }) as { links: { href: string }[] };
    expect(result.links).toHaveLength(1);
    expect(result.links[0]?.href).toContain("otro.com");
  });
});

describe("outline", () => {
  it("lista los elementos interactivos con rol y nombre accesible", () => {
    document.body.innerHTML = `
      <button aria-label="Cerrar dialogo"></button>
      <a href="/x">Ir a X</a>
      <input type="text" placeholder="Buscar" />
      <div>texto suelto sin interaccion</div>`;

    const result = api.outline({}) as { elements: { role: string; name: string }[] };
    const roles = result.elements.map((el) => el.role);

    expect(roles).toContain("button");
    expect(roles).toContain("link");
    expect(roles).toContain("textbox");
    expect(result.elements.find((el) => el.role === "button")?.name).toBe("Cerrar dialogo");
  });

  it("respeta maxNodes", () => {
    document.body.innerHTML = Array.from({ length: 30 }, (_, i) => `<button>B${i}</button>`).join("");
    const result = api.outline({ maxNodes: 5 }) as { elements: unknown[] };
    expect(result.elements).toHaveLength(5);
  });
});

describe("waitFor", () => {
  it("resuelve cuando el elemento aparece mas tarde", async () => {
    setTimeout(() => {
      document.body.innerHTML = `<div id="tarde">listo</div>`;
    }, 100);

    await expect(api.waitFor({ target: { css: "#tarde" }, timeoutMs: 2_000 })).resolves.toMatchObject({
      found: { tag: "div" },
    });
  });

  it("falla con element_not_found al agotar el tiempo", async () => {
    await expect(api.waitFor({ target: { css: "#nunca" }, timeoutMs: 300 })).rejects.toMatchObject({
      webbotCode: "element_not_found",
    });
  });
});

describe("postSocial", () => {
  it("con dryRun rellena el composer de X pero no pulsa publicar", async () => {
    document.body.innerHTML = `
      <div data-testid="tweetTextarea_0" contenteditable="true" role="textbox"></div>
      <div data-testid="tweetButtonInline" role="button">Postear</div>`;
    const spy = vi.fn();
    document.querySelector('[data-testid="tweetButtonInline"]')?.addEventListener("click", spy);

    const result = (await api.postSocial({ network: "x", text: "hola mundo", dryRun: true })) as {
      posted: boolean;
      dryRun: boolean;
    };

    expect(result.dryRun).toBe(true);
    expect(result.posted).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="tweetTextarea_0"]')?.textContent).toBe("hola mundo");
  });

  it("sin dryRun pulsa el boton de publicar de X y confirma al vaciarse el composer", { timeout: 15_000 }, async () => {
    document.body.innerHTML = `
      <a data-testid="AppTabBar_Profile_Link" href="/ahiram1701">Perfil</a>
      <div data-testid="tweetTextarea_0" contenteditable="true" role="textbox"></div>
      <div data-testid="tweetButtonInline" role="button">Postear</div>`;
    const spy = vi.fn();
    // X vacia el cuadro de redaccion cuando el post sale: en eso se basa la confirmacion.
    document.querySelector('[data-testid="tweetButtonInline"]')?.addEventListener("click", () => {
      spy();
      const composer = document.querySelector('[data-testid="tweetTextarea_0"]');
      if (composer) composer.textContent = "";
    });

    const result = (await api.postSocial({ network: "x", text: "publicado", dryRun: false, expectedAccount: "@ahiram1701" })) as {
      posted: boolean;
      confirmed: boolean;
    };

    expect(spy).toHaveBeenCalledOnce();
    expect(result.posted).toBe(true);
    expect(result.confirmed).toBe(true);
  });

  // Espera a que el boton se habilite antes de rendirse, asi que necesita mas margen que el resto.
  it("no pulsa un boton deshabilitado y lo explica", { timeout: 15_000 }, async () => {
    document.body.innerHTML = `
      <div data-testid="tweetTextarea_0" contenteditable="true" role="textbox"></div>
      <div data-testid="tweetButtonInline" role="button" aria-disabled="true">Postear</div>
      <a data-testid="AppTabBar_Profile_Link" href="/ahiram1701">Perfil</a>`;

    await expect(api.postSocial({ network: "x", text: "x", dryRun: false, expectedAccount: "@ahiram1701" })).rejects.toMatchObject({
      webbotCode: "post_button_disabled",
    });
  });

  it("limpia el texto que el editor duplica en el DOM antes de seguir", async () => {
    // Reproduce lo visto en X: execCommand inserta de forma nativa y Draft.js ademas renderiza su
    // propio span[data-text], asi que el DOM acaba con el texto dos veces y textContent lo suma.
    document.body.innerHTML = `
      <div data-testid="tweetTextarea_0" contenteditable="true" role="textbox"></div>
      <div data-testid="tweetButtonInline" role="button">Postear</div>`;
    const composer = document.querySelector('[data-testid="tweetTextarea_0"]') as HTMLElement;
    composer.addEventListener("input", () => {
      if (composer.querySelector("[data-text]")) return;
      const propio = document.createElement("span");
      propio.setAttribute("data-text", "true");
      propio.textContent = composer.textContent ?? "";
      composer.append(propio);
    });

    const result = (await api.postSocial({ network: "x", text: "alfa", dryRun: true })) as { posted: boolean };

    expect(result.posted).toBe(false);
    expect(composer.textContent).toBe("alfa");
  });

  it("no publica si el composer acaba con un texto distinto del pedido", { timeout: 15_000 }, async () => {
    document.body.innerHTML = `
      <div data-testid="tweetTextarea_0" contenteditable="true" role="textbox"></div>
      <div data-testid="tweetButtonInline" role="button">Postear</div>`;
    const composer = document.querySelector('[data-testid="tweetTextarea_0"]') as HTMLElement;
    const spy = vi.fn();
    document.querySelector('[data-testid="tweetButtonInline"]')?.addEventListener("click", spy);
    // Un editor que mete texto de su cosecha y que nadie reconoce como suyo.
    document.body.insertAdjacentHTML("beforeend", '<a data-testid="AppTabBar_Profile_Link" href="/ahiram1701">Perfil</a>');
    composer.addEventListener("input", () => { composer.textContent = (composer.textContent ?? "") + " y algo mas"; });

    await expect(api.postSocial({ network: "x", text: "solo esto", dryRun: false, expectedAccount: "@ahiram1701" })).rejects.toMatchObject({
      webbotCode: "composer_text_mismatch",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("da por bueno el texto aunque el editor guarde los espacios a su manera", async () => {
    // Las regex de normalizacion perdieron la barra invertida (/s+/ en vez de \s+) y dejaron de
    // colapsar espacios. Como cambiaban cada "s" por un espacio en los dos lados de la comparacion,
    // eso por si solo no rompia nada; lo que fallaba era cualquier texto cuyos espacios guarde el
    // editor de otra forma, como hace un contenteditable con los espacios repetidos (&nbsp;).
    document.body.innerHTML = `
      <div data-testid="tweetTextarea_0" contenteditable="true" role="textbox"></div>
      <div data-testid="tweetButtonInline" role="button">Postear</div>`;
    const composer = document.querySelector('[data-testid="tweetTextarea_0"]') as HTMLElement;
    composer.addEventListener("input", () => {
      composer.textContent = (composer.textContent ?? "").replace(/ {2,}/g, (run) => "\u00a0".repeat(run.length));
    });

    const result = (await api.postSocial({ network: "x", text: "esto   es una  prueba", dryRun: true })) as {
      posted: boolean;
    };

    expect(result.posted).toBe(false);
  });

  it("no publica sin expectedAccount, y ni siquiera escribe", async () => {
    document.body.innerHTML = `
      <a data-testid="AppTabBar_Profile_Link" href="/ahiram1701">Perfil</a>
      <div data-testid="tweetTextarea_0" contenteditable="true" role="textbox"></div>
      <div data-testid="tweetButtonInline" role="button">Postear</div>`;
    const spy = vi.fn();
    document.querySelector('[data-testid="tweetButtonInline"]')?.addEventListener("click", spy);

    await expect(api.postSocial({ network: "x", text: "hola", dryRun: false })).rejects.toMatchObject({
      webbotCode: "account_required",
    });
    expect(spy).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="tweetTextarea_0"]')?.textContent).toBe("");
  });

  it("aborta sin escribir si la cuenta activa de X no es la esperada", async () => {
    document.body.innerHTML = `
      <a data-testid="AppTabBar_Profile_Link" href="https://x.com/otra_cuenta">Perfil</a>
      <div data-testid="tweetTextarea_0" contenteditable="true" role="textbox"></div>
      <div data-testid="tweetButtonInline" role="button">Postear</div>`;
    const spy = vi.fn();
    document.querySelector('[data-testid="tweetButtonInline"]')?.addEventListener("click", spy);

    await expect(
      api.postSocial({ network: "x", text: "hola", dryRun: false, expectedAccount: "@ahiram1701" }),
    ).rejects.toMatchObject({ webbotCode: "account_mismatch" });
    expect(spy).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="tweetTextarea_0"]')?.textContent).toBe("");
  });

  it("detecta que Facebook actua como una pagina y no publica con otra cuenta", async () => {
    // Lo visto en vivo: el composer saludaba a la pagina "Impulsa CV", no al perfil personal.
    document.body.innerHTML = `
      <div role="button">¿Qué estás pensando, Impulsa CV?</div>
      <div role="dialog" aria-label="Crear publicacion">
        <div role="textbox" contenteditable="true"></div>
        <div role="button" data-testid="publicar">Publicar</div>
      </div>`;
    const spy = vi.fn();
    document.querySelector('[data-testid="publicar"]')?.addEventListener("click", spy);

    const simulado = (await api.postSocial({ network: "facebook", text: "hola", dryRun: true })) as { account: string };
    expect(simulado.account).toBe("Impulsa CV");

    await expect(
      api.postSocial({ network: "facebook", text: "hola", dryRun: false, expectedAccount: "Ahiram" }),
    ).rejects.toMatchObject({ webbotCode: "account_mismatch" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("no pulsa Publicar si el plazo del servidor ya paso", async () => {
    document.body.innerHTML = `
      <a data-testid="AppTabBar_Profile_Link" href="/ahiram1701">Perfil</a>
      <div data-testid="tweetTextarea_0" contenteditable="true" role="textbox"></div>
      <div data-testid="tweetButtonInline" role="button">Postear</div>`;
    const spy = vi.fn();
    document.querySelector('[data-testid="tweetButtonInline"]')?.addEventListener("click", spy);

    await expect(
      api.postSocial({ network: "x", text: "hola", dryRun: false, expectedAccount: "@ahiram1701", deadlineAt: Date.now() - 1 }),
    ).rejects.toMatchObject({ webbotCode: "deadline_exceeded" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("se niega a empezar si la pestana no esta visible", async () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    try {
      await expect(api.postSocial({ network: "x", text: "hola", dryRun: true })).rejects.toMatchObject({
        webbotCode: "tab_hidden",
      });
    } finally {
      delete (document as { visibilityState?: unknown }).visibilityState;
    }
  });

  it("busca el boton de Facebook en el dialogo del composer, no en otro panel abierto", async () => {
    // El panel de notificaciones va primero en el DOM y trae su propio 'Publicar' como senuelo:
    // buscar el dialogo con un querySelector global se quedaba con este.
    document.body.innerHTML = `
      <div role="dialog" aria-label="Notificaciones">
        <div role="button" data-testid="senuelo">Publicar</div>
      </div>
      <div role="dialog" aria-label="Crear publicacion">
        <div role="textbox" contenteditable="true"></div>
        <div role="button" data-testid="real">Publicar</div>
      </div>`;

    const result = (await api.postSocial({ network: "facebook", text: "hola", dryRun: true })) as {
      button: { selector: string };
    };

    expect(result.button.selector).toBe('[data-testid="real"]');
  });

  // Sin ninguna fuente de identidad en el DOM, la deteccion agota su espera de 3 s antes de seguir.
  it("avanza a la pantalla de configuracion cuando el composer de Facebook acaba en 'Siguiente'", { timeout: 15_000 }, async () => {
    // Facebook partio la publicacion en dos pantallas: el composer ya no trae 'Publicar'.
    document.body.innerHTML = `
      <div role="dialog" aria-label="Crear publicacion">
        <div role="textbox" contenteditable="true"></div>
        <div role="button" data-testid="siguiente">Siguiente</div>
      </div>`;
    document.querySelector('[data-testid="siguiente"]')?.addEventListener("click", () => {
      const ajustes = document.createElement("div");
      ajustes.setAttribute("role", "dialog");
      ajustes.innerHTML = `<div role="button" data-testid="publicar">Publicar</div>`;
      document.body.append(ajustes);
    });

    const result = (await api.postSocial({ network: "facebook", text: "hola", dryRun: true })) as {
      advancedStep: boolean;
      button: { selector: string };
    };

    expect(result.advancedStep).toBe(true);
    expect(result.button.selector).toBe('[data-testid="publicar"]');
  });

  it("escribe en el composer de Facebook sobre un borrador guardado sin duplicarlo", async () => {
    // Facebook guarda el borrador al cerrar el dialogo y lo recupera al reabrirlo.
    const { el } = editorTipoLexical("probando webbot");
    const dialogo = document.createElement("div");
    dialogo.setAttribute("role", "dialog");
    el.replaceWith(dialogo);
    dialogo.append(el);
    dialogo.insertAdjacentHTML("beforeend", `<div role="button" data-testid="publicar">Publicar</div>`);

    const result = (await api.postSocial({ network: "facebook", text: "hola", dryRun: true })) as { posted: boolean };

    expect(result.posted).toBe(false);
    expect(el.textContent).toBe("hola");
  });

  it("detecta la cuenta por la barra lateral cuando un borrador tapa el saludo", async () => {
    // Con un borrador guardado, el boton del feed muestra el borrador en vez de "Que estas
    // pensando, X?", y esa era la unica fuente de identidad.
    document.body.innerHTML = `
      <div role="navigation">
        <a href="https://www.facebook.com/reel/?s=tab"></a>
        <a href="https://www.facebook.com/Ahiram1701">Ahiram SG</a>
        <a href="https://www.facebook.com/ahiramescritos/">Ahiram Escritos</a>
      </div>
      <div role="button">xd</div>
      <div role="dialog" aria-label="Crear publicacion">
        <div role="textbox" contenteditable="true"></div>
        <div role="button" data-testid="publicar">Publicar</div>
      </div>`;

    const result = (await api.postSocial({ network: "facebook", text: "hola", dryRun: true })) as { account: string };

    expect(result.account).toBe("Ahiram SG");
  });

  it("acepta el nombre corto del saludo y el completo de la barra lateral como la misma cuenta", async () => {
    document.body.innerHTML = `
      <div role="navigation"><a href="https://www.facebook.com/Ahiram1701">Ahiram SG</a></div>
      <div role="button">¿Qué estás pensando, Ahiram?</div>
      <div role="dialog" aria-label="Crear publicacion">
        <div role="textbox" contenteditable="true"></div>
        <div role="button" data-testid="publicar">Publicar</div>
      </div>`;
    const dialogo = document.querySelector('[role="dialog"]') as HTMLElement;
    const spy = vi.fn();
    document.querySelector('[data-testid="publicar"]')?.addEventListener("click", () => {
      spy();
      dialogo.remove();
    });

    const result = (await api.postSocial({
      network: "facebook",
      text: "hola",
      dryRun: false,
      expectedAccount: "Ahiram SG",
    })) as { posted: boolean; account: string };

    expect(spy).toHaveBeenCalledOnce();
    expect(result.posted).toBe(true);
    expect(result.account).toBe("Ahiram");
  });

  it("no publica si el saludo y la barra lateral apuntan a identidades distintas", async () => {
    document.body.innerHTML = `
      <div role="navigation"><a href="https://www.facebook.com/Ahiram1701">Ahiram SG</a></div>
      <div role="button">¿Qué estás pensando, Impulsa CV?</div>
      <div role="dialog" aria-label="Crear publicacion">
        <div role="textbox" contenteditable="true"></div>
        <div role="button" data-testid="publicar">Publicar</div>
      </div>`;
    const spy = vi.fn();
    document.querySelector('[data-testid="publicar"]')?.addEventListener("click", spy);

    await expect(
      api.postSocial({ network: "facebook", text: "hola", dryRun: false, expectedAccount: "Ahiram SG" }),
    ).rejects.toMatchObject({ webbotCode: "account_mismatch" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("abre el composer aunque el boton muestre un borrador en vez del saludo", async () => {
    // Medido en vivo: con un borrador guardado, el boton del feed pone "xd" y el unico botón sin
    // aria-label de la tarjeta es ese.
    document.body.innerHTML = `
      <div role="navigation"><a href="https://www.facebook.com/Ahiram1701">Ahiram SG</a></div>
      <div role="main">
        <div id="tarjeta">
          <div role="button" id="abrir">xd</div>
          <div role="button" aria-label="Foto/video">foto</div>
          <div role="button" aria-label="Reel">reel</div>
        </div>
      </div>`;
    document.getElementById("abrir")?.addEventListener("click", () => {
      document.body.insertAdjacentHTML(
        "beforeend",
        `<div role="dialog" aria-label="Crear publicacion">
           <div role="textbox" contenteditable="true">xd</div>
           <div role="button" data-testid="publicar">Publicar</div>
         </div>`,
      );
    });

    const result = (await api.postSocial({ network: "facebook", text: "hola", dryRun: true })) as { account: string };

    expect(result.account).toBe("Ahiram SG");
    expect(document.querySelector('[role="dialog"] [role="textbox"]')?.textContent).toBe("hola");
  });

  it("no pulsa nada si hay varios candidatos a abrir el composer", async () => {
    document.body.innerHTML = `
      <div role="main">
        <div id="tarjeta">
          <div role="button" id="uno">xd</div>
          <div role="button" id="otro">otro boton sin etiqueta</div>
          <div role="button" aria-label="Foto/video">foto</div>
        </div>
      </div>`;
    const spy = vi.fn();
    document.getElementById("uno")?.addEventListener("click", spy);
    document.getElementById("otro")?.addEventListener("click", spy);

    await expect(api.postSocial({ network: "facebook", text: "hola", dryRun: true })).rejects.toMatchObject({
      webbotCode: "composer_not_found",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("identifica al autor por el enlace del dialogo cuando no hay saludo ni barra lateral", async () => {
    document.body.innerHTML = `
      <div role="button">xd</div>
      <div role="dialog" aria-label="Crear publicacion">
        <a href="https://www.facebook.com/Ahiram1701?__tn__=%3C"></a>
        <div role="textbox" contenteditable="true"></div>
        <div role="button" data-testid="publicar">Publicar</div>
      </div>`;

    const result = (await api.postSocial({ network: "facebook", text: "hola", dryRun: true })) as { account: string };

    expect(result.account).toBe("Ahiram1701");
  });

  it("espera a que la pagina pinte la identidad antes de rendirse", async () => {
    // Una pestana recien traida al frente puede no tener aun la barra lateral.
    document.body.innerHTML = `
      <div role="button">xd</div>
      <div role="dialog" aria-label="Crear publicacion">
        <div role="textbox" contenteditable="true"></div>
        <div role="button" data-testid="publicar">Publicar</div>
      </div>`;
    setTimeout(() => {
      document.body.insertAdjacentHTML(
        "afterbegin",
        `<div role="navigation"><a href="https://www.facebook.com/Ahiram1701">Ahiram SG</a></div>`,
      );
    }, 400);

    const result = (await api.postSocial({ network: "facebook", text: "hola", dryRun: true })) as { account: string };

    expect(result.account).toBe("Ahiram SG");
  });

  it("reutiliza un composer ya abierto en la pantalla de configuracion en vez de apilar otro", async () => {
    // Visto en vivo: el dialogo se quedo en el segundo paso, sin cuadro de texto, y el runtime
    // pulsaba el boton del feed, abriendo un segundo composer encima del primero.
    document.body.innerHTML = `
      <div role="navigation"><a href="https://www.facebook.com/Ahiram1701">Ahiram SG</a></div>
      <div role="main">
        <div>
          <div role="button" id="abrir">xd</div>
          <div role="button" aria-label="Foto/video">foto</div>
        </div>
      </div>
      <div role="dialog" aria-label="Configuracion de la publicacion">
        <div role="button" aria-label="Volver">volver</div>
        <div role="button" data-testid="publicar">Publicar</div>
      </div>`;
    const abrirFeed = vi.fn();
    document.getElementById("abrir")?.addEventListener("click", abrirFeed);
    document.querySelector('[aria-label="Volver"]')?.addEventListener("click", () => {
      document.body.insertAdjacentHTML(
        "beforeend",
        `<div role="dialog" aria-label="Crear publicacion">
           <div role="textbox" contenteditable="true">xd</div>
           <div role="button" data-testid="siguiente">Siguiente</div>
         </div>`,
      );
    });

    const result = (await api.postSocial({ network: "facebook", text: "hola", dryRun: true })) as {
      posted: boolean;
      button: { selector: string };
    };

    expect(abrirFeed).not.toHaveBeenCalled();
    expect(result.posted).toBe(false);
    expect(result.button.selector).toBe('[data-testid="publicar"]');
    expect(document.querySelector('[aria-label="Crear publicacion"] [role="textbox"]')?.textContent).toBe("hola");
  });

  it("avisa si no encuentra el composer de Facebook", async () => {
    document.body.innerHTML = `<div>pagina sin composer</div>`;
    await expect(api.postSocial({ network: "facebook", text: "hola", dryRun: true })).rejects.toMatchObject({
      webbotCode: "composer_not_found",
    });
  });

  it("abre el dialogo de Facebook y rellena el cuadro de texto", async () => {
    document.body.innerHTML = `<div role="button" aria-label="¿Qué estás pensando?">abrir</div>`;
    document.querySelector('[role="button"]')?.addEventListener("click", () => {
      document.body.insertAdjacentHTML(
        "beforeend",
        `<div role="dialog">
           <div role="textbox" contenteditable="true"></div>
           <div role="button" aria-label="Publicar">Publicar</div>
         </div>`,
      );
    });

    const result = (await api.postSocial({ network: "facebook", text: "desde webbot", dryRun: true })) as {
      posted: boolean;
    };

    expect(result.posted).toBe(false);
    expect(document.querySelector('[role="dialog"] [role="textbox"]')?.textContent).toBe("desde webbot");
  });
});
