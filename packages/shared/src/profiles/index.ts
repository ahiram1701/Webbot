import type { FieldSpec } from "../protocol.js";

/**
 * Perfil de extraccion para un dominio concreto. Se aplica automaticamente cuando la URL de la
 * pestana encaja con `match`; los `selectors` que el agente pase en la llamada lo sobrescriben
 * campo a campo.
 */
export interface SiteProfile {
  /** Identificador estable, se devuelve en el resultado para que el agente sepa que se aplico. */
  id: string;
  /** Sufijos de hostname. "example.com" encaja con "www.example.com" pero no con "notexample.com". */
  match: string[];
  /** Contenedor del contenido principal; acota el modo "readable". */
  container?: string;
  /** Selectores de ruido a eliminar antes de extraer texto. */
  remove?: string[];
  /** Campos estructurados que se devuelven siempre para este dominio. */
  fields?: Record<string, FieldSpec>;
}

export const PROFILES: SiteProfile[] = [
  {
    id: "wikipedia",
    match: ["wikipedia.org"],
    container: "#mw-content-text .mw-parser-output",
    remove: [".navbox", ".infobox", ".reflist", "table.ambox", "sup.reference", ".mw-editsection", "#toc"],
    fields: {
      titulo: { css: "#firstHeading" },
      resumen: { css: "#mw-content-text .mw-parser-output > p" },
      secciones: { css: ".mw-heading h2, h2 .mw-headline", all: true },
    },
  },
  {
    id: "github-repo",
    match: ["github.com"],
    container: "article.markdown-body, main",
    remove: [".js-navigation-container", "nav", "footer"],
    fields: {
      repo: { css: 'strong[itemprop="name"] a, h1 strong a' },
      descripcion: { css: 'p.f4.my-3, [data-testid="repository-description"]' },
      estrellas: { css: "#repo-stars-counter-star" },
      lenguaje: { css: '.BorderGrid-row .color-fg-default.text-bold[itemprop="programmingLanguage"]', all: true },
      readme: { css: "article.markdown-body" },
    },
  },
  {
    id: "hackernews",
    match: ["news.ycombinator.com"],
    container: "#hnmain",
    fields: {
      titulos: { css: ".titleline > a", all: true },
      enlaces: { css: ".titleline > a", attr: "href", all: true },
      puntos: { css: ".score", all: true },
    },
  },
];

/** Normaliza un hostname quitando el "www." inicial. */
function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

/** Devuelve el perfil registrado para una URL, o undefined si el dominio no tiene ninguno. */
export function profileFor(url: string): SiteProfile | undefined {
  let host: string;
  try {
    host = normalizeHost(new URL(url).hostname);
  } catch {
    return undefined;
  }
  return PROFILES.find((profile) =>
    profile.match.some((suffix) => {
      const needle = normalizeHost(suffix);
      return host === needle || host.endsWith(`.${needle}`);
    }),
  );
}
