import { ErrorCodes, type LlmChoice, type LlmStatus } from "@webbot/shared";

import { createAgentRunner } from "./agent.js";
import type { Bridge } from "./bridge.js";
import { apiKeyFor, config, llmEnv, llmTimeoutMs, log } from "./config.js";
import { createProvider, LlmError, NO_LLM_MESSAGE, type LlmConfig, type LlmProvider } from "./llm/index.js";

/** Ultimo recurso cuando ni Opciones ni el .env dicen a que endpoint compatible llamar. */
const OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * Traduce la eleccion hecha en Opciones a configuracion de modelo. Es un PARCHE sobre el .env: cada
 * campo que Opciones deja vacio lo sigue poniendo el servidor. Antes cada hueco se rellenaba con un
 * default fijo, asi que elegir 'openai' y no repetir la URL base mandaba las peticiones a
 * api.openai.com con la clave de otro sitio, y elegir modelo apagaba la vision y forzaba el
 * razonamiento aunque el .env dijera lo contrario.
 *
 * La clave no viene de Opciones: se empareja con la que el servidor ya tenga para ese proveedor,
 * para que no tenga que salir del .env.
 */
export function fromChoice(choice: LlmChoice): LlmConfig {
  const provider = choice.provider ?? llmEnv.provider ?? "anthropic";
  // Solo se hereda dentro del mismo proveedor: la URL o el modelo del otro adaptador no valen aqui,
  // y colarlos seria peor que quedarse sin ellos.
  const mismo = provider === llmEnv.provider;
  const model = choice.model?.trim() || (mismo ? llmEnv.model : "");

  if (!model) {
    throw new LlmError(
      `Elegiste el proveedor '${provider}' en Opciones pero no pusiste modelo, y el .env del servidor ` +
        `${llmEnv.provider ? `tiene uno de '${llmEnv.provider}'` : "no tiene ninguno"}. Escribe el modelo en Opciones.`,
      ErrorCodes.LLM_NOT_CONFIGURED,
    );
  }

  return {
    provider,
    model,
    apiKey: apiKeyFor(provider),
    baseUrl: choice.baseUrl?.trim() || (mismo ? llmEnv.baseUrl : "") || OPENAI_BASE_URL,
    thinking: choice.thinking ?? (mismo ? llmEnv.thinking : true),
    vision: choice.vision ?? (mismo ? llmEnv.vision : false),
    timeoutMs: llmTimeoutMs,
  };
}

/**
 * Monta el proveedor, o devuelve el error ya traducido si no se puede. Recibe un thunk porque
 * componer la configuracion tambien puede fallar (una eleccion de Opciones sin modelo que heredar),
 * y ese motivo tiene que llegar a la cabecera del panel igual que los demas.
 */
function build(settings: () => LlmConfig | null): { provider: LlmProvider | null; error: LlmError | null } {
  try {
    return { provider: createProvider(settings()), error: null };
  } catch (error) {
    return { provider: null, error: error instanceof LlmError ? error : new LlmError(String(error), "llm_error") };
  }
}

/** Lo que el panel ensena en su cabecera nada mas conectar. */
function describe(provider: LlmProvider | null, error: LlmError | null): LlmStatus {
  return {
    ready: provider !== null,
    model: provider?.label,
    reason: provider ? undefined : (error?.message ?? NO_LLM_MESSAGE),
  };
}

/**
 * Engancha el agente del panel al puente. Lo llaman los dos entrypoints (stdio y HTTP) para que la
 * extension pueda pedir cosas por su cuenta con cualquiera de los dos arrancado.
 *
 * Que falte el modelo no es motivo para no arrancar: el camino MCP sigue entero y el panel lo dice
 * en su cabecera en vez de dejar que se descubra fallando.
 */
export function attachAgent(bridge: Bridge): void {
  const inicial = build(() => config.llm);

  if (inicial.provider) log(`agente del panel listo con ${inicial.provider.label}`);
  else log("sin modelo configurado: el panel de la extension no podra ejecutar instrucciones");

  bridge.describeLlm(describe(inicial.provider, inicial.error));

  const runner = createAgentRunner(bridge, inicial.provider, inicial.error, llmTimeoutMs);
  bridge.onExtensionFrame((frame) => runner.handle(frame));
  bridge.onExtensionGone(() => runner.stopAll());

  // Lo que se elija en Opciones gana al .env; sin eleccion se vuelve a lo que diga el .env.
  bridge.onLlmChoice((choice) => {
    const { provider, error } = build(() => (choice ? fromChoice(choice) : config.llm));

    log(
      provider
        ? `modelo del panel: ${provider.label}`
        : `el panel se queda sin modelo: ${error?.message ?? "sin configurar"}`,
    );
    runner.use(provider, error);
    return describe(provider, error);
  });
}
