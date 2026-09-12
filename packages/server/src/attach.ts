import { createAgentRunner } from "./agent.js";
import type { Bridge } from "./bridge.js";
import { config, log } from "./config.js";
import { createProvider, LlmError } from "./llm/index.js";

/**
 * Engancha el agente del panel al puente. Lo llaman los dos entrypoints (stdio y HTTP) para que la
 * extension pueda pedir cosas por su cuenta con cualquiera de los dos arrancado.
 *
 * Que falte el modelo no es motivo para no arrancar: el camino MCP sigue entero y el panel recibe
 * un evento de error explicando que le falta al .env.
 */
export function attachAgent(bridge: Bridge): void {
  let provider = null;
  let providerError: LlmError | null = null;
  try {
    provider = createProvider(config.llm);
  } catch (error) {
    providerError = error instanceof LlmError ? error : new LlmError(String(error), "llm_error");
  }

  if (provider) log(`agente del panel listo con ${provider.label}`);
  else log("sin modelo configurado: el panel de la extension no podra ejecutar instrucciones");

  const runner = createAgentRunner(bridge, provider, providerError);
  bridge.onExtensionFrame((frame) => runner.handle(frame));
  bridge.onExtensionGone(() => runner.stopAll());
}
