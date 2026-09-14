import {
  ErrorCodes,
  FlowSchema,
  interpolateStep,
  profileFor,
  type Command,
  type Flow,
  type FlowStep,
} from "@webbot/shared";

import { assertAllowed, WebbotError } from "../allowlist.js";
import { callRuntime, getTab, requireAllowedTab, waitForTabComplete } from "../inject.js";
import { getSettings, saveSettings, type WebbotSettings } from "../settings.js";

/** Paginas de arranque de cada red, usadas cuando no hay ninguna pestana abierta en ella. */
const SOCIAL_HOME = {
  x: { hosts: ["x.com", "twitter.com"], url: "https://x.com/home" },
  facebook: { hosts: ["facebook.com"], url: "https://www.facebook.com/" },
} as const;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function openTab(url: string, active: boolean, allowlist: string[]): Promise<chrome.tabs.Tab> {
  assertAllowed(url, allowlist);
  const tab = await chrome.tabs.create({ url, active });
  if (tab.id === undefined) throw new WebbotError("Chrome no devolvio el id de la pestana nueva.", ErrorCodes.TAB_NOT_FOUND);
  await waitForTabComplete(tab.id);
  return tab;
}

export interface CommandContext {
  /** Instante (Date.now) a partir del cual el servidor ya no espera la respuesta. */
  deadlineAt: number;
}

/**
 * Pone la pestana y su ventana en primer plano. Una pagina en segundo plano o en una ventana
 * tapada tiene los temporizadores congelados o racionados: un flujo de publicacion se queda a
 * medias y puede reanudarse minutos despues, cuando nadie espera ya el resultado.
 */
async function focusTab(tabId: number): Promise<void> {
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
  // Margen para que la pagina reciba visibilitychange antes de pedirle nada.
  await sleep(300);
}

/** Busca una pestana ya abierta en la red social; si no hay, abre una. */
async function tabForNetwork(network: "x" | "facebook", allowlist: string[]): Promise<number> {
  const { hosts, url } = SOCIAL_HOME[network];
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => {
    if (!tab.url || tab.id === undefined) return false;
    try {
      const host = new URL(tab.url).hostname.replace(/^www\./, "");
      return hosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
    } catch {
      return false;
    }
  });

  if (existing?.id !== undefined) {
    assertAllowed(existing.url ?? "", allowlist);
    await waitForTabComplete(existing.id);
    return existing.id;
  }

  const created = await openTab(url, true, allowlist);
  // Las redes sociales montan la interfaz despues de 'complete'; damos margen al primer render.
  await sleep(2_500);
  return created.id as number;
}

async function runFlowStep(
  step: FlowStep,
  state: { tabId: number | null; results: Record<string, unknown> },
  settings: WebbotSettings,
  context: CommandContext,
): Promise<unknown> {
  const needTab = (): number => {
    if (state.tabId === null) {
      throw new WebbotError(
        "El flujo intenta actuar sobre una pagina antes de abrir ninguna: empieza con un paso 'open'.",
        ErrorCodes.BAD_REQUEST,
      );
    }
    return state.tabId;
  };

  switch (step.do) {
    case "open": {
      const tab = await openTab(step.url, step.active ?? false, settings.allowlist);
      state.tabId = tab.id as number;
      return { tabId: state.tabId, url: step.url };
    }
    case "navigate": {
      const tabId = needTab();
      assertAllowed(step.url, settings.allowlist);
      await chrome.tabs.update(tabId, { url: step.url });
      await waitForTabComplete(tabId);
      return { tabId, url: step.url };
    }
    case "waitFor": {
      const tabId = needTab();
      await requireAllowedTab(tabId, settings.allowlist);
      return callRuntime(tabId, "waitFor", { target: step.target, timeoutMs: step.timeoutMs });
    }
    case "click": {
      const tabId = needTab();
      await requireAllowedTab(tabId, settings.allowlist);
      const result = await callRuntime(tabId, "click", { target: step.target });
      if (step.waitAfterMs) await sleep(step.waitAfterMs);
      return result;
    }
    case "type": {
      const tabId = needTab();
      await requireAllowedTab(tabId, settings.allowlist);
      return callRuntime(tabId, "type", { target: step.target, text: step.text, clear: step.clear, submit: step.submit });
    }
    case "scroll": {
      const tabId = needTab();
      await requireAllowedTab(tabId, settings.allowlist);
      return callRuntime(tabId, "scroll", { direction: step.direction, amount: step.amount });
    }
    case "extract": {
      const tabId = needTab();
      const tab = await requireAllowedTab(tabId, settings.allowlist);
      const result = await callRuntime(tabId, "extract", {
        mode: step.mode,
        selectors: step.selectors,
        profile: profileFor(tab.url ?? "") ?? null,
      });
      if (step.as) state.results[step.as] = result;
      return result;
    }
    case "post": {
      const tabId = await tabForNetwork(step.network, settings.allowlist);
      state.tabId = tabId;
      await focusTab(tabId);
      return callRuntime(tabId, "postSocial", {
        network: step.network,
        text: step.text,
        dryRun: step.dryRun,
        expectedAccount: step.expectedAccount,
        groups: step.groups,
        deadlineAt: context.deadlineAt,
      });
    }
    case "wait":
      await sleep(step.ms);
      return { waited: step.ms };
    default: {
      const exhaustive: never = step;
      throw new WebbotError(`Paso de flujo desconocido: ${JSON.stringify(exhaustive)}`, ErrorCodes.BAD_REQUEST);
    }
  }
}

/** Ejecuta un comando del agente. Cada rama valida permisos antes de tocar la pagina. */
export async function runCommand(command: Command, context: CommandContext): Promise<unknown> {
  const settings = await getSettings();

  switch (command.type) {
    case "browser.listTabs": {
      const tabs = await chrome.tabs.query({});
      return {
        tabs: tabs
          .filter((tab) => tab.id !== undefined)
          .map((tab) => ({
            tabId: tab.id,
            url: tab.url ?? "",
            title: tab.title ?? "",
            active: tab.active,
            status: tab.status,
            allowed: tab.url ? assertAllowedSafe(tab.url, settings.allowlist) : false,
          })),
      };
    }

    case "browser.openTab": {
      const tab = await openTab(command.url, command.active ?? false, settings.allowlist);
      return { tabId: tab.id, url: tab.url ?? command.url, title: tab.title ?? "" };
    }

    case "browser.closeTab": {
      await getTab(command.tabId);
      await chrome.tabs.remove(command.tabId);
      return { closed: command.tabId };
    }

    case "browser.navigate": {
      await getTab(command.tabId);
      assertAllowed(command.url, settings.allowlist);
      await chrome.tabs.update(command.tabId, { url: command.url });
      await waitForTabComplete(command.tabId, command.timeoutMs ?? 30_000);
      const tab = await getTab(command.tabId);
      return { tabId: command.tabId, url: tab.url ?? command.url, title: tab.title ?? "" };
    }

    case "page.waitFor": {
      await requireAllowedTab(command.tabId, settings.allowlist);
      return callRuntime(command.tabId, "waitFor", { target: command.target, timeoutMs: command.timeoutMs });
    }

    case "page.extract": {
      const tab = await requireAllowedTab(command.tabId, settings.allowlist);
      return callRuntime(command.tabId, "extract", {
        mode: command.mode,
        selectors: command.selectors,
        maxChars: command.maxChars,
        profile: profileFor(tab.url ?? "") ?? null,
      });
    }

    case "page.links": {
      await requireAllowedTab(command.tabId, settings.allowlist);
      return callRuntime(command.tabId, "links", { contains: command.contains, sameOrigin: command.sameOrigin });
    }

    case "page.outline": {
      await requireAllowedTab(command.tabId, settings.allowlist);
      return callRuntime(command.tabId, "outline", { maxNodes: command.maxNodes });
    }

    case "page.describe": {
      await requireAllowedTab(command.tabId, settings.allowlist);
      return callRuntime(command.tabId, "describe", { target: command.target });
    }

    case "page.click": {
      await requireAllowedTab(command.tabId, settings.allowlist);
      // Ya no hay espera fija: el runtime aguarda a que la pagina se asiente y devuelve en
      // 'after' lo que cambio. waitAfterMs se respeta como espera extra para quien la pida.
      const result = await callRuntime(command.tabId, "click", { target: command.target });
      if (command.waitAfterMs) await sleep(command.waitAfterMs);
      return result;
    }

    case "page.type": {
      await requireAllowedTab(command.tabId, settings.allowlist);
      return callRuntime(command.tabId, "type", {
        target: command.target,
        text: command.text,
        clear: command.clear,
        submit: command.submit,
      });
    }

    case "page.scroll": {
      await requireAllowedTab(command.tabId, settings.allowlist);
      return callRuntime(command.tabId, "scroll", { direction: command.direction, amount: command.amount });
    }

    case "page.screenshot": {
      const tab = await requireAllowedTab(command.tabId, settings.allowlist);
      // captureVisibleTab solo fotografia la pestana activa de la ventana.
      if (!tab.active) await chrome.tabs.update(command.tabId, { active: true });
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      return { tabId: command.tabId, url: tab.url ?? "", dataUrl };
    }

    case "social.share": {
      // Compartir actua sobre una publicacion concreta de una pestana concreta: aqui el tabId lo
      // pone quien llama, no se busca una pestana de Facebook cualquiera como en social.post.
      await requireAllowedTab(command.tabId, settings.allowlist);
      await focusTab(command.tabId);
      return callRuntime(command.tabId, "sharePost", {
        target: command.target,
        comment: command.comment,
        dryRun: command.dryRun ?? false,
        expectedAccount: command.expectedAccount,
        expectedPost: command.expectedPost,
        deadlineAt: context.deadlineAt,
      });
    }

    case "social.post": {
      const tabId = await tabForNetwork(command.network, settings.allowlist);
      await focusTab(tabId);
      return callRuntime(tabId, "postSocial", {
        network: command.network,
        text: command.text,
        dryRun: command.dryRun ?? false,
        expectedAccount: command.expectedAccount,
        groups: command.groups,
        deadlineAt: context.deadlineAt,
      });
    }

    case "flow.list":
      return {
        flows: Object.entries(settings.flows).map(([name, flow]) => ({
          name,
          description: flow.description ?? "",
          steps: flow.steps.length,
          vars: variablesOf(flow),
        })),
      };

    case "flow.save": {
      const parsed = FlowSchema.safeParse({ description: undefined, steps: command.steps });
      if (!parsed.success) {
        throw new WebbotError(`Flujo invalido: ${parsed.error.issues[0]?.message ?? "no encaja con el esquema"}`, ErrorCodes.BAD_REQUEST);
      }
      await saveSettings({ flows: { ...settings.flows, [command.name]: parsed.data } });
      return { saved: command.name, steps: parsed.data.steps.length };
    }

    case "flow.run": {
      const flow = settings.flows[command.name];
      if (!flow) {
        const disponibles = Object.keys(settings.flows).join(", ") || "ninguno";
        throw new WebbotError(`No existe el flujo '${command.name}'. Guardados: ${disponibles}.`, ErrorCodes.BAD_REQUEST);
      }
      const state: { tabId: number | null; results: Record<string, unknown> } = { tabId: null, results: {} };
      const steps: unknown[] = [];
      for (const [index, rawStep] of flow.steps.entries()) {
        const step = interpolateStep(rawStep, command.vars);
        try {
          steps.push({ index, do: step.do, ok: true, result: await runFlowStep(step, state, settings, context) });
        } catch (error) {
          steps.push({ index, do: step.do, ok: false, error: error instanceof Error ? error.message : String(error) });
          return { flow: command.name, completed: false, failedAt: index, steps, named: state.results };
        }
      }
      return { flow: command.name, completed: true, steps, named: state.results };
    }

    case "config.get":
      return {
        runtimeVersion: chrome.runtime.getManifest().version,
        allowlist: settings.allowlist,
        bridgePort: settings.bridgePort,
        flows: Object.keys(settings.flows),
        tokenConfigured: settings.token.length > 0,
      };

    default: {
      const exhaustive: never = command;
      throw new WebbotError(`Comando desconocido: ${JSON.stringify(exhaustive)}`, ErrorCodes.BAD_REQUEST);
    }
  }
}

/** Version no lanzante de assertAllowed, para anotar el listado de pestanas. */
function assertAllowedSafe(url: string, allowlist: string[]): boolean {
  try {
    assertAllowed(url, allowlist);
    return true;
  } catch {
    return false;
  }
}

/** Extrae los nombres de variable {{x}} que usa un flujo, para mostrarselos al agente. */
function variablesOf(flow: Flow): string[] {
  const found = new Set<string>();
  const scan = (value: unknown): void => {
    if (typeof value === "string") {
      for (const match of value.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) {
        if (match[1]) found.add(match[1]);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(scan);
      return;
    }
    if (value && typeof value === "object") Object.values(value).forEach(scan);
  };
  scan(flow.steps);
  return Array.from(found);
}
