import { randomUUID, timingSafeEqual } from "node:crypto";

import { WebSocketServer, type WebSocket } from "ws";

import {
  ErrorCodes,
  FrameSchema,
  PROTOCOL_VERSION,
  timeoutFor,
  type AgentFrame,
  type Command,
  type Frame,
  type LlmStatus,
} from "@webbot/shared";

import { log } from "./config.js";

/** Margen para que la extension mande su `hello` antes de que la echemos. */
const AUTH_TIMEOUT_MS = 5_000;
/**
 * Chrome mata el service worker de MV3 tras 30 s de inactividad, pero desde Chrome 116 el trafico
 * WebSocket reinicia ese contador. Un ping cada 20 s lo mantiene vivo indefinidamente.
 */
const PING_INTERVAL_MS = 20_000;

export class BridgeError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  /** Conexion por la que salio la peticion: si se cierra o la sustituyen, la respuesta no llegara. */
  socket: WebSocket;
}

export interface BridgeOptions {
  port: number;
  host: string;
  token: string;
  requestTimeoutMs: number;
}

/**
 * Puente entre el servidor MCP y la extension. El service worker de MV3 no puede escuchar en un
 * puerto, asi que invertimos la conexion: nosotros escuchamos y la extension entra como cliente.
 * Solo se admite un cliente a la vez; si llega uno nuevo autenticado (recarga de la extension)
 * sustituye al anterior.
 */
export class Bridge {
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly tokenBuffer: Buffer;
  /** Quien atiende lo que la extension inicia por su cuenta (el panel del agente). */
  private agentHandler: ((frame: AgentFrame) => void) | null = null;
  private disconnectHandler: (() => void) | null = null;
  /** Lo que se le cuenta al panel en el welcome: si detras hay modelo o no. */
  private llmStatus: LlmStatus | null = null;

  constructor(private readonly options: BridgeOptions) {
    this.tokenBuffer = Buffer.from(options.token, "utf8");
  }

  get connected(): boolean {
    return this.client !== null && this.client.readyState === this.client.OPEN;
  }

  get port(): number {
    return this.options.port;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port: this.options.port, host: this.options.host });
      this.wss = wss;
      wss.on("connection", (socket) => this.onConnection(socket));
      wss.on("error", reject);
      wss.on("listening", () => {
        log(`puente escuchando en ws://${this.options.host}:${this.options.port}`);
        resolve();
      });
    });
  }

  /**
   * Registra quien atiende las tramas `agent.*`. Sin esto se descartan, que es justo lo que debe
   * pasar cuando el servidor corre sin modelo configurado.
   */
  onExtensionFrame(handler: (frame: AgentFrame) => void): void {
    this.agentHandler = handler;
  }

  /** Avisa de que la extension se fue, para abortar lo que estuviera en marcha. */
  onExtensionGone(handler: () => void): void {
    this.disconnectHandler = handler;
  }

  /**
   * Que anunciar en el welcome sobre el modelo. Lo pone attachAgent, que es quien sabe si hubo
   * proveedor; el puente solo lo repite, porque no tiene por que saber nada de modelos.
   */
  describeLlm(status: LlmStatus): void {
    this.llmStatus = status;
  }

  /** Empuja una trama a la extension sin esperar respuesta (eventos del agente). */
  sendToExtension(frame: Frame): void {
    const socket = this.client;
    if (socket && socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
  }

  /** Envia un comando a la extension y espera su respuesta. */
  send(command: Command): Promise<unknown> {
    const socket = this.client;
    if (!socket || socket.readyState !== socket.OPEN) {
      return Promise.reject(
        new BridgeError(
          "La extension Webbot no esta conectada. Abre Chrome, comprueba que la extension esta " +
            "activa y que su panel marca 'conectado' (token y puerto correctos en Opciones).",
          ErrorCodes.NOT_CONNECTED,
        ),
      );
    }

    const id = randomUUID();
    const timeoutMs = timeoutFor(command, this.options.requestTimeoutMs);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BridgeError(
            `La extension no respondio a '${command.type}' en ${timeoutMs} ms.`,
            ErrorCodes.TIMEOUT,
          ),
        );
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer, socket });
      // El plazo viaja con la peticion: la extension no ejecuta una accion irreversible despues de
      // que aqui ya se haya dado por perdida.
      socket.send(JSON.stringify({ kind: "request", id, command, timeoutMs } satisfies Frame));
    });
  }

  async close(): Promise<void> {
    this.stopPing();
    this.rejectAllPending(new BridgeError("Puente cerrado.", ErrorCodes.NOT_CONNECTED));
    this.client?.close();
    this.client = null;
    await new Promise<void>((resolve) => {
      if (!this.wss) {
        resolve();
        return;
      }
      this.wss.close(() => resolve());
    });
    this.wss = null;
  }

  // -------------------------------------------------------------------------

  private onConnection(socket: WebSocket): void {
    let authenticated = false;

    const authTimer = setTimeout(() => {
      if (!authenticated) socket.close(4401, "sin autenticar");
    }, AUTH_TIMEOUT_MS);

    socket.on("message", (raw) => {
      const frame = this.parseFrame(raw.toString());
      if (!frame) return;

      if (!authenticated) {
        if (frame.kind !== "hello") {
          socket.close(4401, "se esperaba hello");
          return;
        }
        if (!this.tokenMatches(frame.token)) {
          log("conexion rechazada: token invalido");
          socket.close(4403, "token invalido");
          return;
        }
        if (frame.version !== PROTOCOL_VERSION) {
          log(`conexion rechazada: protocolo v${frame.version}, se esperaba v${PROTOCOL_VERSION}`);
          socket.close(4400, "version de protocolo incompatible");
          return;
        }
        authenticated = true;
        clearTimeout(authTimer);
        this.adoptClient(socket);
        socket.send(
          JSON.stringify({ kind: "welcome", version: PROTOCOL_VERSION, llm: this.llmStatus ?? undefined } satisfies Frame),
        );
        log(`extension conectada (${frame.agent ?? "sin agent"})`);
        return;
      }

      this.handleFrame(socket, frame);
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      // Lo que salio por esta conexion ya no tendra respuesta, sea o no la conexion actual.
      this.rejectPendingOf(
        socket,
        new BridgeError("La extension se desconecto antes de responder.", ErrorCodes.NOT_CONNECTED),
      );
      if (this.client === socket) {
        this.client = null;
        this.stopPing();
        this.disconnectHandler?.();
        log("extension desconectada");
      }
    });

    socket.on("error", (error) => log(`error de socket: ${error.message}`));
  }

  private parseFrame(raw: string): Frame | null {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      log("frame descartado: JSON invalido");
      return null;
    }
    const parsed = FrameSchema.safeParse(json);
    if (!parsed.success) {
      log(`frame descartado: ${parsed.error.issues[0]?.message ?? "no encaja con el protocolo"}`);
      return null;
    }
    return parsed.data;
  }

  private handleFrame(socket: WebSocket, frame: Frame): void {
    switch (frame.kind) {
      case "response": {
        const pending = this.pending.get(frame.id);
        if (!pending) return; // llego tarde: ya habia saltado el timeout
        this.pending.delete(frame.id);
        clearTimeout(pending.timer);
        if (frame.ok) {
          pending.resolve(frame.result);
        } else {
          pending.reject(
            new BridgeError(
              frame.error?.message ?? "Error desconocido en la extension.",
              frame.error?.code ?? "extension_error",
            ),
          );
        }
        return;
      }
      case "ping":
        socket.send(JSON.stringify({ kind: "pong", t: frame.t } satisfies Frame));
        return;
      case "agent.start":
      case "agent.cancel":
      case "agent.confirm":
        this.agentHandler?.(frame);
        return;
      default:
        return;
    }
  }

  private adoptClient(socket: WebSocket): void {
    if (this.client && this.client !== socket) {
      log("sustituyendo la conexion anterior de la extension");
      // Sin esto, lo pendiente de la conexion sustituida esperaba al timeout completo.
      this.rejectPendingOf(
        this.client,
        new BridgeError("La conexion con la extension se sustituyo por otra antes de responder.", ErrorCodes.NOT_CONNECTED),
      );
      this.client.close(4409, "reemplazada por una conexion nueva");
    }
    this.client = socket;
    this.startPing();
  }

  private startPing(): void {
    this.stopPing();
    const timer = setInterval(() => {
      const socket = this.client;
      if (socket && socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ kind: "ping", t: Date.now() } satisfies Frame));
      }
    }, PING_INTERVAL_MS);
    timer.unref?.();
    this.pingTimer = timer;
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private rejectPendingOf(socket: WebSocket, error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.socket !== socket) continue;
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  /** Comparacion en tiempo constante para no filtrar el token por temporizacion. */
  private tokenMatches(candidate: string): boolean {
    const buffer = Buffer.from(candidate, "utf8");
    if (buffer.length !== this.tokenBuffer.length) return false;
    return timingSafeEqual(buffer, this.tokenBuffer);
  }
}
