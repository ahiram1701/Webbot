import { describe, expect, it } from "vitest";

import { FlowSchema, interpolate, interpolateStep } from "./flows.js";

describe("interpolate", () => {
  it("sustituye los marcadores por su valor", () => {
    expect(interpolate("hola {{nombre}}", { nombre: "Ada" })).toBe("hola Ada");
    expect(interpolate("{{ a }} y {{b}}", { a: "1", b: "2" })).toBe("1 y 2");
  });

  it("deja intactos los marcadores sin valor", () => {
    expect(interpolate("hola {{nombre}}", {})).toBe("hola {{nombre}}");
  });
});

describe("interpolateStep", () => {
  it("recorre el paso completo, incluidos los objetos anidados", () => {
    const step = interpolateStep(
      { do: "type", target: { css: "#q" }, text: "buscar {{tema}}" },
      { tema: "extensiones" },
    );
    expect(step).toEqual({ do: "type", target: { css: "#q" }, text: "buscar extensiones" });
  });

  it("no toca los valores que no son cadenas", () => {
    const step = interpolateStep({ do: "wait", ms: 500 }, { ms: "9" });
    expect(step).toEqual({ do: "wait", ms: 500 });
  });
});

describe("FlowSchema", () => {
  it("acepta un flujo valido", () => {
    const parsed = FlowSchema.safeParse({
      description: "buscar y extraer",
      steps: [
        { do: "open", url: "https://example.com" },
        { do: "click", target: { text: "Aceptar" } },
        { do: "extract", mode: "readable", as: "articulo" },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("rechaza un flujo sin pasos y un paso desconocido", () => {
    expect(FlowSchema.safeParse({ steps: [] }).success).toBe(false);
    expect(FlowSchema.safeParse({ steps: [{ do: "explotar" }] }).success).toBe(false);
  });

  it("rechaza un target vacio", () => {
    expect(FlowSchema.safeParse({ steps: [{ do: "click", target: {} }] }).success).toBe(false);
  });
});
