import { createServer } from "node:net";

import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { ErrorCodes, PROTOCOL_VERSION, SOCIAL_POST_TIMEOUT_MS, type Frame } from "@webbot/shared";

import { Bridge } from "./bridge.js";

const TOKEN = "token-de-prueba-suficientemente-largo";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address) {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("no se pudo reservar un puerto")));
      }
    });
  });
}

let bridge: Bridge | null = null;
let socket: WebSocket | null = null;

async function startBridge(requestTimeoutMs = 1_000): Promise<Bridge> {
  const port = await freePort();
  const created = new Bridge({ port, host: "127.0.0.1", token: TOKEN, requestTimeoutMs });
  await created.start();
  bridge = created;
  return created;
}

/** Cliente de prueba que hace de extension: se autentica y responde a las peticiones. */
async function connectFakeExtension(
  target: Bridge,
  options: { token?: string; version?: number; onRequest?: (frame: Extract<Frame, { kind: "request" }>, ws: WebSocket) => void } = {},
): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${target.port}`);
  socket = ws;
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  ws.send(
    JSON.stringify({
      kind: "hello",
      token: options.token ?? TOKEN,
      version: options.version ?? PROTOCOL_VERSION,
      agent: "test",
    } satisfies Frame),
  );
  ws.on("message", (raw) => {
    const frame = JSON.parse(raw.toString()) as Frame;
    if (frame.kind === "request") options.onRequest?.(frame, ws);
  });
  return ws;
}

/** Se autentica y devuelve el welcome, que es donde el puente se presenta. */
async function connectAndReadWelcome(target: Bridge): Promise<Extract<Frame, { kind: "welcome" }>> {
  const ws = new WebSocket(`ws://127.0.0.1:${target.port}`);
  socket = ws;
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  const welcome = new Promise<Extract<Frame, { kind: "welcome" }>>((resolve) => {
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame;
      if (frame.kind === "welcome") resolve(frame);
    });
  });
  ws.send(JSON.stringify({ kind: "hello", token: TOKEN, version: PROTOCOL_VERSION, agent: "test" } satisfies Frame));
  return welcome;
}
/** El puente marca `connected` al procesar el hello, no al abrirse el socket. */
async function waitForConnected(target: Bridge, expected = true): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (target.connected === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`el puente no llego a connected=${expected}`);
}

afterEach(async () => {
  socket?.close();
  socket = null;
  await bridge?.close();
  bridge = null;
});

describe("Bridge", () => {
  it("rechaza enviar comandos si no hay extension conectada", async () => {
    const target = await startBridge();
    await expect(target.send({ type: "browser.listTabs" })).rejects.toMatchObject({
      code: ErrorCodes.NOT_CONNECTED,
    });
  });

  it("acepta una extension con el token correcto y enruta la respuesta", async () => {
    const target = await startBridge();
    await connectFakeExtension(target, {
      onRequest: (frame, ws) => {
        ws.send(JSON.stringify({ kind: "response", id: frame.id, ok: true, result: { tabs: [{ id: 7 }] } } satisfies Frame));
      },
    });
    await waitForConnected(target);

    await expect(target.send({ type: "browser.listTabs" })).resolves.toEqual({ tabs: [{ id: 7 }] });
  });

  it("anuncia en el welcome el modelo que tiene detras", async () => {
    const target = await startBridge();
    target.describeLlm({ ready: true, model: "falso:modelo" });

    const welcome = await connectAndReadWelcome(target);

    expect(welcome.kind).toBe("welcome");
    expect(welcome.llm).toEqual({ ready: true, model: "falso:modelo" });
  });

  it("anuncia por que no hay modelo, para que el panel lo ensene antes de que escriban nada", async () => {
    const target = await startBridge();
    target.describeLlm({ ready: false, reason: "Falta la clave del modelo." });

    const welcome = await connectAndReadWelcome(target);

    expect(welcome.llm).toEqual({ ready: false, reason: "Falta la clave del modelo." });
  });

  it("sin describeLlm el welcome no lleva llm: un panel nuevo no debe inventarse que falta algo", async () => {
    const target = await startBridge();

    const welcome = await connectAndReadWelcome(target);

    expect(welcome.llm).toBeUndefined();
  });
  it("propaga los errores que devuelve la extension con su codigo", async () => {
    const target = await startBridge();
    await connectFakeExtension(target, {
      onRequest: (frame, ws) => {
        ws.send(
          JSON.stringify({
            kind: "response",
            id: frame.id,
            ok: false,
            error: { message: "no encontrado", code: ErrorCodes.ELEMENT_NOT_FOUND },
          } satisfies Frame),
        );
      },
    });
    await waitForConnected(target);

    await expect(target.send({ type: "browser.listTabs" })).rejects.toMatchObject({
      code: ErrorCodes.ELEMENT_NOT_FOUND,
      message: "no encontrado",
    });
  });

  it("rechaza un token invalido", async () => {
    const target = await startBridge();
    const ws = await connectFakeExtension(target, { token: "token-incorrecto" });
    const code = await new Promise<number>((resolve) => ws.on("close", resolve));
    expect(code).toBe(4403);
    expect(target.connected).toBe(false);
  });

  it("rechaza una version de protocolo distinta", async () => {
    const target = await startBridge();
    const ws = await connectFakeExtension(target, { version: PROTOCOL_VERSION + 99 });
    const code = await new Promise<number>((resolve) => ws.on("close", resolve));
    expect(code).toBe(4400);
  });

  it("manda el plazo con la peticion y da mas margen a lo que puede publicar", async () => {
    const target = await startBridge(1_000);
    const plazos: Record<string, number | undefined> = {};
    await connectFakeExtension(target, {
      onRequest: (frame, ws) => {
        plazos[frame.command.type] = frame.timeoutMs;
        ws.send(JSON.stringify({ kind: "response", id: frame.id, ok: true, result: {} } satisfies Frame));
      },
    });
    await waitForConnected(target);

    await target.send({ type: "browser.listTabs" });
    await target.send({ type: "social.post", network: "x", text: "hola", dryRun: true });

    expect(plazos["browser.listTabs"]).toBe(1_000);
    expect(plazos["social.post"]).toBe(SOCIAL_POST_TIMEOUT_MS);
  });

  it("agota el tiempo si la extension no contesta", async () => {
    const target = await startBridge(300);
    await connectFakeExtension(target, { onRequest: () => {} });
    await waitForConnected(target);

    await expect(target.send({ type: "browser.listTabs" })).rejects.toMatchObject({ code: ErrorCodes.TIMEOUT });
  });

  it("rechaza las peticiones pendientes si la extension se desconecta", async () => {
    const target = await startBridge(10_000);
    const ws = await connectFakeExtension(target, { onRequest: () => ws.close() });
    await waitForConnected(target);

    await expect(target.send({ type: "browser.listTabs" })).rejects.toMatchObject({
      code: ErrorCodes.NOT_CONNECTED,
    });
  });

  it("rechaza al momento lo pendiente de una conexion que otra sustituye", async () => {
    const target = await startBridge(10_000);
    await connectFakeExtension(target, { onRequest: () => {} });
    await waitForConnected(target);

    const inicio = Date.now();
    const pendiente = expect(target.send({ type: "browser.listTabs" })).rejects.toMatchObject({
      code: ErrorCodes.NOT_CONNECTED,
    });
    // Una segunda conexion sustituye a la primera, como pasaba en bucle al recargar la extension.
    await connectFakeExtension(target, { onRequest: () => {} });

    await pendiente;
    expect(Date.now() - inicio).toBeLessThan(5_000);
  });

  it("responde a los ping de la extension para mantener vivo el canal", async () => {
    const target = await startBridge();
    const ws = await connectFakeExtension(target);
    await waitForConnected(target);

    const pong = new Promise<Frame>((resolve) => {
      ws.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as Frame;
        if (frame.kind === "pong") resolve(frame);
      });
    });
    ws.send(JSON.stringify({ kind: "ping", t: 123 } satisfies Frame));
    await expect(pong).resolves.toMatchObject({ kind: "pong", t: 123 });
  });

  it("entrega al agente lo que inicia la extension y le empuja los eventos de vuelta", async () => {
    const target = await startBridge();
    const recibidas: Frame[] = [];
    target.onExtensionFrame((frame) => recibidas.push(frame));

    const ws = await connectFakeExtension(target);
    await waitForConnected(target);

    const evento = new Promise<Frame>((resolve) => {
      ws.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as Frame;
        if (frame.kind === "agent.event") resolve(frame);
      });
    });

    ws.send(JSON.stringify({ kind: "agent.start", runId: "r1", prompt: "abre example.com" } satisfies Frame));
    for (let i = 0; i < 100 && recibidas.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(recibidas[0]).toMatchObject({ kind: "agent.start", runId: "r1", prompt: "abre example.com" });

    target.sendToExtension({ kind: "agent.event", runId: "r1", event: { type: "done", steps: 2 } });
    await expect(evento).resolves.toMatchObject({ runId: "r1", event: { type: "done", steps: 2 } });
  });

  it("avisa cuando la extension se va, para no dejar un run esperando", async () => {
    const target = await startBridge();
    let ido = false;
    target.onExtensionGone(() => {
      ido = true;
    });

    const ws = await connectFakeExtension(target);
    await waitForConnected(target);
    ws.close();
    await waitForConnected(target, false);

    expect(ido).toBe(true);
  });
});
