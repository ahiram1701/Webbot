import { afterEach, describe, expect, it, vi } from "vitest";

import type { LlmError } from "./llm/index.js";

/**
 * config.ts lee el entorno una sola vez al importarse, asi que cada caso monta su propio .env y
 * vuelve a cargar el modulo. Poner una variable a "" no es lo mismo que no ponerla para dotenv:
 * como la clave ya existe en process.env, dotenv no la pisa con la del .env del repo, que es justo
 * lo que hace falta para que estos tests no dependan de la maquina donde corren.
 *
 * LlmError sale del mismo grafo recien cargado a proposito: tras resetModules la clase importada
 * arriba ya no es la misma que lanza attach.js, y el instanceof fallaria sin que nada este mal.
 */
async function conEnv(env: Record<string, string>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const [attach, llm] = await Promise.all([import("./attach.js"), import("./llm/index.js")]);
  return { fromChoice: attach.fromChoice, LlmError: llm.LlmError };
}

/** Un .env de NVIDIA NIM: proveedor compatible, endpoint propio y clave que solo vale ahi. */
const NVIDIA = {
  WEBBOT_LLM_PROVIDER: "openai",
  WEBBOT_LLM_BASE_URL: "https://integrate.api.nvidia.com/v1",
  WEBBOT_LLM_API_KEY: "nvapi-xxx",
  WEBBOT_LLM_MODEL: "nvidia/nemotron-3-super-120b-a12b",
  WEBBOT_LLM_THINKING: "",
  WEBBOT_LLM_VISION: "",
};

afterEach(() => vi.unstubAllEnvs());

/**
 * Lo que se elige en Opciones es un parche sobre el .env, no una configuracion entera. Antes cada
 * hueco se rellenaba con un default fijo, y el resultado era que cambiar el modelo mandaba las
 * peticiones a api.openai.com con la clave de NVIDIA: un 401 en vez del modelo pedido.
 */
describe("fromChoice: la eleccion de Opciones sobre el .env", () => {
  it("cambiar solo el modelo conserva el proveedor y el endpoint del .env", async () => {
    const { fromChoice } = await conEnv(NVIDIA);
    const config = fromChoice({ model: "moonshotai/kimi-k2-instruct" });
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("moonshotai/kimi-k2-instruct");
    expect(config.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
  });

  it("elegir el proveedor que ya estaba no tira la URL base", async () => {
    const { fromChoice } = await conEnv(NVIDIA);
    expect(fromChoice({ provider: "openai", model: "otro/modelo" }).baseUrl).toBe(
      "https://integrate.api.nvidia.com/v1",
    );
  });

  it("no hereda el endpoint de un proveedor al otro", async () => {
    const { fromChoice } = await conEnv(NVIDIA);
    const config = fromChoice({ provider: "anthropic", model: "claude-opus-5" });
    expect(config.baseUrl).toBe("https://api.openai.com/v1");
    expect(config.model).toBe("claude-opus-5");
  });

  it("hereda la vision del .env cuando Opciones no opina, y la pisa cuando si", async () => {
    const { fromChoice } = await conEnv({ ...NVIDIA, WEBBOT_LLM_VISION: "on" });
    expect(fromChoice({ model: "otro/modelo" }).vision).toBe(true);
    expect(fromChoice({ model: "otro/modelo", vision: false }).vision).toBe(false);
  });

  it("hereda el razonamiento apagado del .env en vez de forzarlo", async () => {
    const { fromChoice } = await conEnv({ ...NVIDIA, WEBBOT_LLM_THINKING: "off" });
    expect(fromChoice({ model: "otro/modelo" }).thinking).toBe(false);
  });

  it("cambiar de proveedor sin modelo falla diciendo que falta el modelo, no que falta el .env", async () => {
    const { fromChoice, LlmError } = await conEnv(NVIDIA);
    let capturado: unknown;
    try {
      fromChoice({ provider: "anthropic" });
    } catch (error) {
      capturado = error;
    }
    expect(capturado).toBeInstanceOf(LlmError);
    expect((capturado as LlmError).message).toContain("anthropic");
    expect((capturado as LlmError).message).toContain("no pusiste modelo");
  });

  it("la clave se empareja con el proveedor elegido, no con el del .env", async () => {
    const { fromChoice } = await conEnv({
      ...NVIDIA,
      WEBBOT_LLM_API_KEY: "",
      OPENAI_API_KEY: "sk-openai",
      ANTHROPIC_API_KEY: "sk-ant",
    });
    expect(fromChoice({ model: "otro/modelo" }).apiKey).toBe("sk-openai");
    expect(fromChoice({ provider: "anthropic", model: "claude-opus-5" }).apiKey).toBe("sk-ant");
  });
});
