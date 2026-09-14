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
  // Sin layout no hay forma de saber que hay delante: se contesta que el punto cae en el body,
  // que hace que todo elemento cuente como alcanzable. En Chrome esto lo resuelve el navegador.
  document.elementFromPoint = () => document.body;
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

describe("compartir en grupos de Facebook", () => {
  /**
   * La pantalla real, tal como se midio: el composer acaba en "Siguiente", la de configuracion trae
   * "Publicar" y la opcion de grupos, y al pulsarla la lista de grupos aparece DENTRO de ese mismo
   * dialogo, mezclada con los controles del editor. No se abre ningun dialogo nuevo.
   *
   * Los nombres llegan con la coletilla de Facebook pegada detras, que es como los devuelve.
   */
  /**
   * Como se comporta el selector en esta variante. Facebook no lo pinta siempre igual y cada una de
   * estas formas acababa en el mismo "la lista de grupos no llego a aparecer".
   */
  type FormaDelSelector = {
    /** La lista sale en un dialogo NUEVO en vez de dentro del de configuracion. */
    dialogoAparte?: boolean;
    /** Rol de cada fila: en unas versiones es un boton y en otras una casilla. */
    rolFila?: string;
    /** El nombre lo lleva un contenedor sin manejador y el boton de verdad es un hijo suyo. */
    openerEnvuelto?: boolean;
    /** Botones propios del dialogo antes de la lista. */
    ruido?: number;
    /** Filas por tanda: la lista se carga a trozos segun se hace scroll. */
    porTanda?: number;
    /** Ademas de cargar a trozos, solo mantiene en el arbol las filas de la ventana visible. */
    recicla?: boolean;
    /** Pulsar la opcion no abre nada. */
    sinLista?: boolean;
    /** La lista ya esta puesta al llegar, y la opcion la cierra en vez de abrirla. */
    yaAbierto?: boolean;
    /** Queda abierto el dialogo de un ensayo anterior, con su Publicar y su opcion de grupos. */
    restos?: boolean;
    /** Cada fila lleva su casilla dentro, como el selector de verdad. */
    conCasilla?: boolean;
    /** La casilla no cambia al pulsar: imita una fila que no esta de verdad delante. */
    casillaMuerta?: boolean;
  };

  function facebookConGrupos(
    grupos: string[],
    forma: FormaDelSelector = {},
  ): { elegidos: string[]; clics: () => number } {
    const {
      dialogoAparte = false,
      rolFila = "button",
      openerEnvuelto = false,
      ruido = 0,
      porTanda = 0,
      recicla = false,
      sinLista = false,
      yaAbierto = false,
      restos = false,
      conCasilla = false,
      casillaMuerta = false,
    } = forma;
    const elegidos: string[] = [];
    let clics = 0;
    // Los restos van DELANTE, que es lo que los hacia ganar cuando se miraba por orden.
    const reclamo =
      "Compartir en grupos Llega a mas personas cuando compartes tu publicacion en grupos relevantes.";
    const sobras = restos
      ? `<div role="dialog" aria-label="Configuracion de antes" data-testid="restos">
           <div role="button" aria-label="Volver">volver</div>
           <div role="button" aria-label="Publicar">Publicar</div>
           <div role="button" data-testid="abrir-viejo">${reclamo}</div>
         </div>`
      : "";
    document.body.innerHTML = `
      <div role="navigation"><a href="https://www.facebook.com/Ahiram1701">Ahiram SG</a></div>
      ${sobras}
      <div role="dialog" aria-label="Crear publicacion">
        <div role="textbox" contenteditable="true"></div>
        <div role="button" data-testid="siguiente">Siguiente</div>
      </div>`;

    document.querySelector('[data-testid="siguiente"]')?.addEventListener("click", () => {
      // El nombre accesible puede llevarlo un contenedor y el manejador vivir en un hijo.
      const opener = openerEnvuelto
        ? `<div data-testid="abrir-grupos">${reclamo}<div role="button" data-testid="abrir-de-verdad"></div></div>`
        : `<div role="button" data-testid="abrir-grupos">${reclamo}</div>`;
      const relleno = Array.from(
        { length: ruido },
        (_, i) => `<div role="button" aria-label="Control ${i} del editor">c</div>`,
      ).join("");
      document.body.insertAdjacentHTML(
        "beforeend",
        `<div role="dialog" aria-label="Configuracion" data-testid="ajustes">
           <div role="button" aria-label="Volver">volver</div>
           <div role="button" aria-label="Foto/video">foto</div>
           <div role="button" aria-label="Emoji">emoji</div>
           <div role="button" aria-label="Etiquetar personas">etiquetar</div>
           ${relleno}
           <div role="button" data-testid="publicar">Publicar</div>
           ${opener}
         </div>`,
      );
      const ajustes = document.querySelector('[data-testid="ajustes"]') as HTMLElement;

      const abrirLista = (): void => {
        let casa = ajustes;
        if (dialogoAparte) {
          document.body.insertAdjacentHTML(
            "beforeend",
            `<div role="dialog" aria-label="Elige grupos" data-testid="picker"></div>`,
          );
          casa = document.querySelector('[data-testid="picker"]') as HTMLElement;
        }
        casa.insertAdjacentHTML(
          "beforeend",
          `<div data-testid="lista"></div><div role="button" aria-label="Listo" data-testid="listo">Listo</div>`,
        );
        const lista = casa.querySelector('[data-testid="lista"]') as HTMLElement;
        const casilla = conCasilla ? '<input type="checkbox" />' : "";
        const fila = (nombre: string): string =>
          `<div role="${rolFila}">${casilla}${nombre} Tu ultima visita fue hace aproximadamente un mes</div>`;
        const escuchar = (): void => {
          for (const el of Array.from(lista.children)) {
            if (el.hasAttribute("data-escuchando")) continue;
            el.setAttribute("data-escuchando", "1");
            el.addEventListener("click", () => {
              const caja = el.querySelector('input[type="checkbox"]');
              if (caja && casillaMuerta) return;
              if (caja instanceof HTMLInputElement) caja.checked = true;
              elegidos.push((el.textContent ?? "").replace(/ Tu ultima visita.*$/, "").trim());
            });
          }
        };

        const tanda = porTanda || grupos.length;
        let hasta = Math.min(tanda, grupos.length);
        lista.insertAdjacentHTML("beforeend", grupos.slice(0, hasta).map(fila).join(""));
        escuchar();

        // Sin carga perezosa no hay contenedor con scroll: la lista ya esta entera.
        if (porTanda) {
          let top = 0;
          Object.defineProperty(lista, "clientHeight", { configurable: true, value: 200 });
          Object.defineProperty(lista, "scrollHeight", {
            configurable: true,
            get: () => 200 + grupos.length * 50,
          });
          Object.defineProperty(lista, "scrollTop", {
            configurable: true,
            get: () => top,
            set: (valor: number) => {
              top = valor;
            },
          });
          lista.addEventListener("scroll", () => {
            if (recicla) {
              // Ventana movil: al subir del todo se vuelve a la primera tanda y las demas se van.
              hasta = top === 0 ? Math.min(tanda, grupos.length) : Math.min(grupos.length, hasta + tanda);
              const desde = top === 0 ? 0 : Math.max(0, hasta - tanda * 2);
              lista.innerHTML = grupos.slice(desde, hasta).map(fila).join("");
              escuchar();
              return;
            }
            if (top === 0 || hasta >= grupos.length) return;
            const previo = hasta;
            hasta = Math.min(grupos.length, hasta + tanda);
            lista.insertAdjacentHTML("beforeend", grupos.slice(previo, hasta).map(fila).join(""));
            escuchar();
          });
        }

        casa.querySelector('[data-testid="listo"]')?.addEventListener("click", () => {
          lista.remove();
          casa.querySelector('[data-testid="listo"]')?.remove();
        });
      };

      // La opcion alterna: si la lista esta puesta, la quita. Es lo que hace Facebook.
      const alternarLista = (): void => {
        const puesta = document.querySelector('[data-testid="lista"]');
        if (!puesta) {
          abrirLista();
          return;
        }
        puesta.remove();
        document.querySelector('[data-testid="listo"]')?.remove();
      };

      const boton =
        ajustes.querySelector('[data-testid="abrir-de-verdad"]') ??
        ajustes.querySelector('[data-testid="abrir-grupos"]');
      boton?.addEventListener("click", () => {
        clics += 1;
      });
      if (!sinLista) boton?.addEventListener("click", alternarLista);
      if (yaAbierto) abrirLista();
    });
    return { elegidos, clics: () => clics };
  }

  it("elige los grupos pedidos y vuelve a la pantalla donde vive Publicar", { timeout: 15_000 }, async () => {
    const { elegidos } = facebookConGrupos(["Memes y mas memes", "Programadores", "Mundo de memes"]);

    const result = (await api.postSocial({
      network: "facebook",
      text: "un chiste",
      dryRun: true,
      groups: ["Memes y mas memes", "Mundo de memes"],
    })) as { groupsMatched: string[]; groupsMissing: string[]; button: { selector: string } };

    expect(elegidos).toEqual(["Memes y mas memes", "Mundo de memes"]);
    // Sin la coletilla: es lo que se ensena en la tarjeta y lo que hay que poder copiar y pegar.
    expect(result.groupsMatched).toEqual(["Memes y mas memes", "Mundo de memes"]);
    expect(result.groupsMissing).toEqual([]);
    // Elegir repinta el dialogo: si no se volviera a buscar, Publicar seria un nodo ya desechado.
    expect(result.button.selector).toBe('[data-testid="publicar"]');
  });

  it("con la lista vacia solo mira que grupos hay, sin elegir ninguno", { timeout: 15_000 }, async () => {
    // Era imposible enterarse de los nombres: 'groupsAvailable' solo llegaba si ya acertabas uno, y
    // los nombres eran justo lo que se venia a buscar. Con [] se abre el selector y se lee la lista.
    const { elegidos } = facebookConGrupos(["Programadores & Software", "Comunidad de Programadores"]);

    const result = (await api.postSocial({
      network: "facebook",
      text: "un chiste",
      dryRun: true,
      groups: [],
    })) as { groupsAvailable: string[]; groupsMatched: string[] };

    expect(result.groupsAvailable).toEqual(["Programadores & Software", "Comunidad de Programadores"]);
    expect(result.groupsMatched).toEqual([]);
    // Mirar la lista no puede publicar en nada.
    expect(elegidos).toEqual([]);
  });

  it("un nombre ambiguo elige UN grupo, no todos los que encajan", { timeout: 15_000 }, async () => {
    // "memes" encaja con dos. Publicar en los dos porque la palabra era vaga no se puede deshacer.
    const { elegidos } = facebookConGrupos(["Memes y mas memes", "Mundo de memes"]);

    const result = (await api.postSocial({
      network: "facebook",
      text: "un chiste",
      dryRun: true,
      groups: ["memes"],
    })) as { groupsMatched: string[]; groupsAvailable: string[] };

    expect(elegidos).toEqual(["Memes y mas memes"]);
    expect(result.groupsMatched).toEqual(["Memes y mas memes"]);
    // El otro se devuelve para que se pueda pedir por su nombre si de verdad se quiere.
    expect(result.groupsAvailable).toEqual(["Memes y mas memes", "Mundo de memes"]);
  });

  it("se para en 9, que es lo que admite Facebook, y dice cuales se quedaron fuera", { timeout: 20_000 }, async () => {
    const letras = "ABCDEFGHIJKL".split("");
    const todos = letras.map((letra) => `Nicho ${letra}`);
    const { elegidos } = facebookConGrupos(todos);

    const result = (await api.postSocial({
      network: "facebook",
      text: "un chiste",
      dryRun: true,
      groups: todos,
    })) as { groupsMatched: string[]; groupsSkipped: string[]; groupsLimit: number };

    // Pedir doce no comparte en doce: Facebook se queda con nueve y pierde el resto sin avisar.
    expect(result.groupsLimit).toBe(9);
    expect(result.groupsMatched).toHaveLength(9);
    expect(elegidos).toHaveLength(9);
    expect(result.groupsSkipped).toEqual(["Nicho J", "Nicho K", "Nicho L"]);
  });

  it("con matchAll un solo nombre llena hasta el tope", { timeout: 20_000 }, async () => {
    // Es lo que fallaba en la practica: pedir "todos mis grupos de software" dependia de que el
    // modelo acertara a enumerar nueve nombres, y se quedaba en cinco. Con matchAll no enumera.
    const { elegidos } = facebookConGrupos([
      "Programadores & Software",
      "Comunidad de Programadores",
      "Desarrolladores de Software",
      "Ingenieros en software",
      "Diseño Web & Desarrollo de Software",
      "Software libre MX",
      "Software y algo mas",
      "Arquitectura de Software",
      "Testing de Software",
      "Software para todos",
      "Memes y mas memes",
      "Noticias de Software",
    ]);

    const result = (await api.postSocial({
      network: "facebook",
      text: "un post",
      dryRun: true,
      groups: ["software"],
      groupsMatchAll: true,
    })) as { groupsMatched: string[]; groupsSkipped: string[] };

    expect(result.groupsMatched).toHaveLength(9);
    expect(elegidos).toHaveLength(9);
    // El que sobraba se dice, para que se sepa que quedo fuera y no se de por completo.
    expect(result.groupsSkipped).toEqual(["Noticias de Software"]);
    // Y lo que no era del tema no entra aunque quede hueco.
    expect(result.groupsMatched).not.toContain("Memes y mas memes");
  });

  it("sin matchAll el segundo que encaja se dice, en vez de perderse en silencio", { timeout: 15_000 }, async () => {
    facebookConGrupos(["Memes y mas memes", "Mundo de memes", "Programadores"]);

    const result = (await api.postSocial({
      network: "facebook",
      text: "un post",
      dryRun: true,
      groups: ["memes"],
    })) as { groupsMatched: string[]; groupsSkipped: string[] };

    expect(result.groupsMatched).toEqual(["Memes y mas memes"]);
    // Saber que habia otro es lo que permite volver a pedirlo; antes no se enteraba nadie.
    expect(result.groupsSkipped).toEqual(["Mundo de memes"]);
  });

  it("no publica en el muro a secas cuando no encaja ningun grupo pedido", async () => {
    // Pedir grupos y acabar publicando solo en el muro se parece demasiado a haber acertado.
    facebookConGrupos(["Programadores"]);

    await expect(
      api.postSocial({ network: "facebook", text: "un chiste", dryRun: true, groups: ["memes"] }),
    ).rejects.toMatchObject({ webbotCode: "element_not_found" });
  });

  it("los controles del selector no se confunden con grupos", { timeout: 15_000 }, async () => {
    const { elegidos } = facebookConGrupos(["Buscar algo curioso", "Memes"]);

    const result = (await api.postSocial({
      network: "facebook",
      text: "un chiste",
      dryRun: true,
      groups: ["Memes"],
    })) as { groupsAvailable: string[] };

    // "Buscar" es un control y se descarta por nombre; el grupo que empieza igual tambien cae, que
    // es el precio de no arriesgarse a pulsar la lupa creyendo que es un grupo.
    expect(result.groupsAvailable).toEqual(["Memes"]);
    expect(elegidos).toEqual(["Memes"]);
  });

  it("reconoce la lista aunque Facebook la pinte en otro dialogo", { timeout: 20_000 }, async () => {
    // No siempre cae dentro del dialogo de configuracion. Buscarla solo ahi era no verla nunca.
    const { elegidos } = facebookConGrupos(["Programadores", "Memes"], { dialogoAparte: true });

    const result = (await api.postSocial({
      network: "facebook",
      text: "hola",
      dryRun: true,
      groups: ["Programadores"],
    })) as { groupsMatched: string[]; groupsAvailable: string[] };

    expect(result.groupsAvailable).toEqual(["Programadores", "Memes"]);
    expect(result.groupsMatched).toEqual(["Programadores"]);
    expect(elegidos).toEqual(["Programadores"]);
  });

  it("reconoce filas que son casillas y no botones", { timeout: 20_000 }, async () => {
    const { elegidos } = facebookConGrupos(["Programadores", "Memes"], { rolFila: "checkbox" });

    const result = (await api.postSocial({
      network: "facebook",
      text: "hola",
      dryRun: true,
      groups: ["Programadores"],
    })) as { groupsMatched: string[] };

    expect(result.groupsMatched).toEqual(["Programadores"]);
    expect(elegidos).toEqual(["Programadores"]);
  });

  it("prueba otro sitio donde pulsar cuando el nombre lo lleva un contenedor", { timeout: 20_000 }, async () => {
    // El clic burbujea hacia arriba, nunca hacia abajo: pulsar el contenedor no abria nada.
    const { elegidos } = facebookConGrupos(["Programadores"], { openerEnvuelto: true });

    const result = (await api.postSocial({
      network: "facebook",
      text: "hola",
      dryRun: true,
      groups: ["Programadores"],
    })) as { groupsMatched: string[] };

    expect(result.groupsMatched).toEqual(["Programadores"]);
    expect(elegidos).toEqual(["Programadores"]);
  });

  it("no pierde los grupos cuando el dialogo ya trae decenas de botones", { timeout: 20_000 }, async () => {
    // El recuento se cortaba en 40 ANTES de cribar por novedad: con 45 controles del editor por
    // delante, los grupos quedaban fuera del recuento y la lista parecia no haber aparecido.
    facebookConGrupos(["Programadores", "Memes"], { ruido: 45 });

    const result = (await api.postSocial({
      network: "facebook",
      text: "hola",
      dryRun: true,
      groups: [],
    })) as { groupsAvailable: string[] };

    expect(result.groupsAvailable).toEqual(["Programadores", "Memes"]);
  });

  it("hace scroll para traer los grupos que Facebook aun no habia pintado", { timeout: 30_000 }, async () => {
    // La lista llega a trozos: sin scroll, "todos mis grupos de software" se quedaba en los que
    // cupieron en la primera pantalla, y el tope de 9 era inalcanzable teniendo veinte.
    const todos = Array.from({ length: 20 }, (_, i) => `Software ${i + 1}`);
    const { elegidos } = facebookConGrupos(todos, { porTanda: 8 });

    const result = (await api.postSocial({
      network: "facebook",
      text: "hola",
      dryRun: true,
      groups: ["software"],
      groupsMatchAll: true,
    })) as { groupsAvailable: string[]; groupsMatched: string[]; groupsSkipped: string[] };

    expect(result.groupsAvailable).toEqual(todos);
    expect(result.groupsMatched).toHaveLength(9);
    expect(elegidos).toHaveLength(9);
    expect(result.groupsSkipped).toHaveLength(11);
  });

  it("vuelve a encontrar una fila que la lista habia reciclado", { timeout: 30_000 }, async () => {
    // Una lista con ventana movil se lleva por delante las filas que no se ven. Pulsar el nodo
    // guardado no habria hecho nada, y se habria contado como compartido igualmente.
    const todos = Array.from({ length: 14 }, (_, i) => `Grupo ${i + 1}`);
    const { elegidos } = facebookConGrupos(todos, { porTanda: 6, recicla: true });

    const result = (await api.postSocial({
      network: "facebook",
      text: "hola",
      dryRun: true,
      groups: ["Grupo 13"],
    })) as { groupsAvailable: string[]; groupsMatched: string[] };

    expect(result.groupsAvailable).toEqual(todos);
    expect(result.groupsMatched).toEqual(["Grupo 13"]);
    expect(elegidos).toEqual(["Grupo 13"]);
  });

  it("cuenta que habia en pantalla cuando la lista no llega a aparecer", { timeout: 30_000 }, async () => {
    // Al otro lado solo llega el mensaje: un fallo que no dice lo que vio obliga a ir a mirar la
    // pagina a mano, y para entonces el ensayo ya ha recogido el dialogo.
    facebookConGrupos(["Programadores"], { sinLista: true });

    await expect(
      api.postSocial({ network: "facebook", text: "hola", dryRun: true, groups: [] }),
    ).rejects.toMatchObject({
      webbotCode: "element_not_found",
      message: expect.stringContaining('button "Publicar"'),
    });
    // Y con que version paso, que es lo que no se podia saber desde fuera.
    await expect(
      api.postSocial({ network: "facebook", text: "hola", dryRun: true, groups: [] }),
    ).rejects.toMatchObject({ message: expect.stringContaining(`[runtime ${RUNTIME_VERSION}]`) });
  });

  it("reabre el selector cuando Facebook ya lo traia abierto", { timeout: 30_000 }, async () => {
    // Pasa en la segunda publicacion seguida: la lista ya esta puesta, y entonces el clic la
    // cierra. Esperando solo a que apareciera algo, se agotaba el plazo cerrandola una y otra vez.
    const { elegidos } = facebookConGrupos(["Memes y mas memes", "Programadores"], { yaAbierto: true });

    const result = (await api.postSocial({
      network: "facebook",
      text: "hola",
      dryRun: true,
      groups: ["Memes y mas memes"],
    })) as { groupsAvailable: string[]; groupsMatched: string[] };

    expect(result.groupsAvailable).toEqual(["Memes y mas memes", "Programadores"]);
    expect(result.groupsMatched).toEqual(["Memes y mas memes"]);
    expect(elegidos).toEqual(["Memes y mas memes"]);
  });

  it("no se queda en los restos de un ensayo anterior", { timeout: 30_000 }, async () => {
    // Un dialogo sin recoger de la vez anterior se llevaba el turno por estar antes en el arbol:
    // se encontraba SU "Publicar" y SU "Compartir en grupos", en una pantalla donde ya no pasa nada.
    const { elegidos } = facebookConGrupos(["Memes y mas memes"], { restos: true });

    const result = (await api.postSocial({
      network: "facebook",
      text: "hola",
      dryRun: true,
      groups: ["Memes y mas memes"],
    })) as { groupsMatched: string[] };

    expect(result.groupsMatched).toEqual(["Memes y mas memes"]);
    expect(elegidos).toEqual(["Memes y mas memes"]);
  });

  it("lee el selector ya montado sin volver a pulsarlo", { timeout: 30_000 }, async () => {
    // Lo medido sobre el Facebook real: la pantalla de grupos se queda montada, sus filas siguen
    // contando como visibles, y "lo que no estaba antes de pulsar" no encuentra ni una. Encima,
    // pulsar la opcion con el selector abierto lo CIERRA, asi que el intento se comia a si mismo.
    const { elegidos, clics } = facebookConGrupos(["Memes y mas memes", "Programadores"], {
      conCasilla: true,
      yaAbierto: true,
    });

    const result = (await api.postSocial({
      network: "facebook",
      text: "hola",
      dryRun: true,
      groups: ["Memes y mas memes"],
    })) as { groupsAvailable: string[]; groupsMatched: string[] };

    expect(result.groupsAvailable).toEqual(["Memes y mas memes", "Programadores"]);
    expect(result.groupsMatched).toEqual(["Memes y mas memes"]);
    expect(elegidos).toEqual(["Memes y mas memes"]);
    // Y no se pulso la opcion: habria cerrado el selector que ya estaba delante.
    expect(clics()).toBe(0);
  });

  it("abre el selector de casillas cuando no esta puesto", { timeout: 30_000 }, async () => {
    const { elegidos, clics } = facebookConGrupos(["Memes y mas memes", "Programadores"], {
      conCasilla: true,
    });

    const result = (await api.postSocial({
      network: "facebook",
      text: "hola",
      dryRun: true,
      groups: ["Programadores"],
    })) as { groupsMatched: string[] };

    expect(result.groupsMatched).toEqual(["Programadores"]);
    expect(elegidos).toEqual(["Programadores"]);
    expect(clics()).toBe(1);
  });

  it("no cuenta como compartido un grupo cuya casilla no cambia", { timeout: 30_000 }, async () => {
    // Pulsar una fila que no esta delante no hace nada. Contarla igual seria anunciar como
    // compartido algo que no se compartio, que es lo que nadie va a ir a comprobar.
    const { elegidos } = facebookConGrupos(["Memes y mas memes", "Programadores"], {
      conCasilla: true,
      casillaMuerta: true,
    });

    await expect(
      api.postSocial({ network: "facebook", text: "hola", dryRun: true, groups: ["Memes y mas memes"] }),
    ).rejects.toMatchObject({ webbotCode: "element_not_found" });
    expect(elegidos).toEqual([]);
  });

  it("X no tiene grupos y lo dice en vez de ignorarlos", async () => {
    document.body.innerHTML = `
      <div data-testid="tweetTextarea_0" contenteditable="true" role="textbox"></div>
      <div data-testid="tweetButtonInline" role="button">Postear</div>`;

    await expect(
      api.postSocial({ network: "x", text: "hola", dryRun: true, groups: ["memes"] }),
    ).rejects.toMatchObject({ webbotCode: "bad_request" });
  });
});

describe("compartir una publicacion existente", () => {
  /** Un feed con dos publicaciones, cada una con SU boton de compartir. */
  function feedConDosPublicaciones(): { compartidos: string[] } {
    const compartidos: string[] = [];
    document.body.innerHTML = `
      <div role="navigation"><a href="https://www.facebook.com/Ahiram1701">Ahiram SG</a></div>
      <div role="article" data-testid="post-1">
        <div>Un chiste sobre programadores</div>
        <div role="button" aria-label="Compartir" data-testid="share-1">12</div>
      </div>
      <div role="article" data-testid="post-2">
        <div>Una receta de lentejas</div>
        <div role="button" aria-label="Compartir" data-testid="share-2">3</div>
      </div>`;

    for (const n of ["1", "2"]) {
      document.querySelector(`[data-testid="share-${n}"]`)?.addEventListener("click", () => {
        compartidos.push(n);
        document.body.insertAdjacentHTML(
          "beforeend",
          `<div role="menu" data-testid="menu-${n}">
             <div role="menuitem" aria-label="Compartir ahora (amigos)">ahora</div>
             <div role="menuitem" aria-label="Compartir en el feed" data-testid="al-feed-${n}">al feed</div>
             <div role="menuitem" aria-label="Copiar enlace">copiar</div>
           </div>`,
        );
        document.querySelector(`[data-testid="al-feed-${n}"]`)?.addEventListener("click", () => {
          document.body.insertAdjacentHTML(
            "beforeend",
            `<div role="dialog" aria-label="Compartir">
               <div role="textbox" contenteditable="true"></div>
               <div role="button" data-testid="publicar">Publicar</div>
             </div>`,
          );
        });
      });
    }
    return { compartidos };
  }

  it("pulsa el Compartir de SU publicacion, no el primero del feed", { timeout: 15_000 }, async () => {
    const { compartidos } = feedConDosPublicaciones();

    const result = (await api.sharePost({ target: { text: "lentejas" }, dryRun: true })) as {
      sharing: string;
      shared: boolean;
    };

    // El feed esta lleno de botones identicos: sin acotar se habria compartido el chiste.
    expect(compartidos).toEqual(["2"]);
    expect(result.shared).toBe(true);
    expect(result.sharing).toContain("lentejas");
  });

  it("no usa 'Compartir ahora', que publicaria sin pasar por la tarjeta", { timeout: 15_000 }, async () => {
    feedConDosPublicaciones();
    const ahora = vi.fn();

    await api.sharePost({ target: { text: "lentejas" }, dryRun: true });

    document.querySelector('[aria-label="Compartir ahora (amigos)"]')?.addEventListener("click", ahora);
    expect(ahora).not.toHaveBeenCalled();
    // Y lo que se abrio fue un composer, que es donde el ensayo puede pararse.
    expect(document.querySelector('[role="dialog"] [role="textbox"]')).not.toBeNull();
  });

  it("dice que destinos ofrece Facebook cuando no reconoce ninguno", { timeout: 15_000 }, async () => {
    document.body.innerHTML = `
      <div role="article">
        <div>Un chiste</div>
        <div role="button" aria-label="Compartir" data-testid="share">1</div>
      </div>`;
    document.querySelector('[data-testid="share"]')?.addEventListener("click", () => {
      document.body.insertAdjacentHTML(
        "beforeend",
        `<div role="menu">
           <div role="menuitem" aria-label="Mandar a un chat">chat</div>
           <div role="menuitem" aria-label="Copiar enlace">copiar</div>
         </div>`,
      );
    });

    // Los nombres cambian con el idioma y con la version: el error los lista para poder corregirlos
    // sin tener que adivinar cual era.
    await expect(api.sharePost({ target: { text: "chiste" }, dryRun: true })).rejects.toThrow(/Mandar a un chat/);
  });

  it("compartir de verdad exige el extracto del ensayo", { timeout: 15_000 }, async () => {
    feedConDosPublicaciones();

    await expect(
      api.sharePost({ target: { text: "lentejas" }, expectedAccount: "Ahiram SG" }),
    ).rejects.toMatchObject({ webbotCode: "account_required" });
  });

  it("aborta si bajo ese target hay ya otra publicacion", { timeout: 15_000 }, async () => {
    // Un feed se reordena solo: entre el ensayo y la publicacion de verdad el mismo target puede
    // estar apuntando a otra cosa, y compartir la equivocada no se deshace.
    feedConDosPublicaciones();

    await expect(
      api.sharePost({
        target: { text: "lentejas" },
        expectedAccount: "Ahiram SG",
        expectedPost: "Un chiste sobre programadores",
      }),
    ).rejects.toMatchObject({ webbotCode: "account_mismatch" });
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
  it("con dryRun escribe y comprueba, pero no pulsa publicar ni deja el borrador puesto", async () => {
    document.body.innerHTML = `
      <div data-testid="tweetTextarea_0" contenteditable="true" role="textbox"></div>
      <div data-testid="tweetButtonInline" role="button">Postear</div>`;
    const spy = vi.fn();
    document.querySelector('[data-testid="tweetButtonInline"]')?.addEventListener("click", spy);

    const result = (await api.postSocial({ network: "x", text: "hola mundo", dryRun: true })) as {
      posted: boolean;
      dryRun: boolean;
      wrote: string;
    };

    expect(result.dryRun).toBe(true);
    expect(result.posted).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    // El ensayo escribio de verdad, y lo demuestra devolviendo lo que quedo en el editor...
    expect(result.wrote).toBe("hola mundo");
    // ...pero no deja el borrador montado: eso obligaba a la persona a recogerlo a mano.
    expect(document.querySelector('[data-testid="tweetTextarea_0"]')?.textContent).toBe("");
  });

  it("cierra el dialogo que abrio el ensayo, y lo vacia antes para que no pregunte si descartar", async () => {
    // Encadenar dos ensayos dejaba dos borradores abiertos y el segundo intento empezaba encima
    // de los restos del primero: asi es como se acababa con dialogos apilados.
    document.body.innerHTML = `
      <div role="navigation"><a href="https://www.facebook.com/Ahiram1701">Ahiram SG</a></div>
      <div role="dialog" aria-label="Crear publicacion">
        <div role="textbox" contenteditable="true"></div>
        <div role="button" data-testid="publicar">Publicar</div>
        <div role="button" aria-label="Cerrar">x</div>
      </div>`;
    const dialogo = document.querySelector('[role="dialog"]') as HTMLElement;
    dialogo.querySelector('[aria-label="Cerrar"]')?.addEventListener("click", () => dialogo.remove());

    const result = (await api.postSocial({ network: "facebook", text: "un chiste", dryRun: true })) as {
      wrote: string;
      tidied: boolean;
    };

    expect(result.wrote).toBe("un chiste");
    expect(result.tidied).toBe(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("un ensayo que no puede recoger sigue dando su respuesta, solo que lo dice", async () => {
    // Recoger es lo ultimo y lo menos importante: si falla, la comprobacion ya valio igual.
    document.body.innerHTML = `
      <div data-testid="tweetTextarea_0" contenteditable="true" role="textbox"></div>
      <div data-testid="tweetButtonInline" role="button">Postear</div>`;
    const composer = document.querySelector('[data-testid="tweetTextarea_0"]') as HTMLElement;
    // Un editor que se niega a vaciarse: writeComposer lanza y la recogida tiene que tragarselo.
    composer.addEventListener("input", () => {
      if (!composer.textContent) composer.textContent = "residuo";
    });

    const result = (await api.postSocial({ network: "x", text: "alfa", dryRun: true })) as {
      posted: boolean;
      wrote: string;
      tidied: boolean;
    };

    expect(result.posted).toBe(false);
    expect(result.wrote).toBe("alfa");
    expect(result.tidied).toBe(false);
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

    const result = (await api.postSocial({ network: "x", text: "alfa", dryRun: true })) as {
      posted: boolean;
      wrote: string;
    };

    expect(result.posted).toBe(false);
    expect(result.wrote).toBe("alfa");
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

  it("no se queda esperando un 'Publicar' que no existe en esa pantalla", { timeout: 15_000 }, async () => {
    // Cuando el composer acaba en "Siguiente" se esperaban 4 s a un boton que nunca iba a estar, y
    // ese tiempo muerto se pagaba entero en cada publicacion de las que van en dos pasos.
    document.body.innerHTML = `
      <div role="navigation"><a href="https://www.facebook.com/Ahiram1701">Ahiram SG</a></div>
      <div role="dialog" aria-label="Crear publicacion">
        <div role="textbox" contenteditable="true"></div>
        <div role="button" data-testid="siguiente">Siguiente</div>
      </div>`;
    document.querySelector('[data-testid="siguiente"]')?.addEventListener("click", () => {
      document.body.insertAdjacentHTML(
        "beforeend",
        `<div role="dialog"><div role="button" data-testid="publicar">Publicar</div></div>`,
      );
    });

    const empezo = Date.now();
    const result = (await api.postSocial({ network: "facebook", text: "hola", dryRun: true })) as {
      advancedStep: boolean;
    };

    expect(result.advancedStep).toBe(true);
    expect(Date.now() - empezo).toBeLessThan(3_000);
  });

  it("espera a que se habilite 'Publicar' en vez de irse por el camino largo", { timeout: 15_000 }, async () => {
    // El precio de no esperar los 4 s seria avanzar de pantalla en cuanto se ve "Siguiente", aunque
    // el "Publicar" de esta misma se estuviera habilitando. Por eso hay un margen antes de aceptarlo.
    document.body.innerHTML = `
      <div role="navigation"><a href="https://www.facebook.com/Ahiram1701">Ahiram SG</a></div>
      <div role="dialog" aria-label="Crear publicacion">
        <div role="textbox" contenteditable="true"></div>
        <div role="button" data-testid="publicar" aria-disabled="true">Publicar</div>
        <div role="button" data-testid="siguiente">Siguiente</div>
      </div>`;
    const avanzo = vi.fn();
    document.querySelector('[data-testid="siguiente"]')?.addEventListener("click", avanzo);
    setTimeout(() => document.querySelector('[data-testid="publicar"]')?.setAttribute("aria-disabled", "false"), 300);

    const result = (await api.postSocial({ network: "facebook", text: "hola", dryRun: true })) as {
      advancedStep: boolean;
      button: { selector: string };
    };

    expect(avanzo).not.toHaveBeenCalled();
    expect(result.advancedStep).toBe(false);
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

    const result = (await api.postSocial({ network: "facebook", text: "hola", dryRun: true })) as {
      posted: boolean;
      wrote: string;
    };

    expect(result.posted).toBe(false);
    expect(result.wrote).toBe("hola");
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

  it("no busca al autor en el panel de notificaciones abierto", { timeout: 15_000 }, async () => {
    // Medido en vivo: con las notificaciones desplegadas, el primer [role=dialog] de la pagina es
    // el suyo. Se sacaba de ahi un enlace cualquiera como autor, chocaba con la barra lateral y la
    // identidad quedaba en discordia, asi que no se podia publicar.
    document.body.innerHTML = `
      <div role="navigation"><a href="https://www.facebook.com/Ahiram1701">Ahiram SG</a></div>
      <div role="dialog" aria-label="Notificaciones">
        <a href="https://www.facebook.com/story.php">Empleos Monterrey publico algo</a>
        <a href="https://www.facebook.com/OtraPersona">Otra Persona</a>
      </div>
      <div role="dialog" aria-label="Crear publicacion">
        <div role="textbox" contenteditable="true"></div>
        <div role="button" data-testid="publicar">Publicar</div>
      </div>`;

    const result = (await api.postSocial({ network: "facebook", text: "hola", dryRun: true })) as {
      account: string | null;
    };

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

    const result = (await api.postSocial({ network: "facebook", text: "hola", dryRun: true })) as {
      account: string;
      wrote: string;
    };

    expect(result.account).toBe("Ahiram SG");
    expect(result.wrote).toBe("hola");
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
      wrote: string;
    };

    expect(abrirFeed).not.toHaveBeenCalled();
    expect(result.posted).toBe(false);
    expect(result.button.selector).toBe('[data-testid="publicar"]');
    expect(result.wrote).toBe("hola");
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
      wrote: string;
    };

    expect(result.posted).toBe(false);
    expect(result.wrote).toBe("desde webbot");
  });
});
