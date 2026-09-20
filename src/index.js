import { DurableObject } from "cloudflare:workers";

const MAX_PLAYERS_PER_ROOM = 10;
const MAX_MESSAGE_BYTES = 64 * 1024;
const EVENT_TTL_MS = 15000;
const MAX_EVENTS = 5000;
const ATTACKS_PER_SECOND = 30;

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("청구 RPG 멀티 서버 정상 작동");
    }

    const match = url.pathname.match(/^\/room\/([^/]+)$/);
    if (!match) {
      return new Response("청구 RPG 멀티 서버", { status: 200 });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket 연결이 필요합니다.", { status: 426 });
    }

    const roomId = decodeURIComponent(match[1]);
    const id = env.ROOMS.idFromName(roomId);
    return env.ROOMS.get(id).fetch(request);
  }
};

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.clients = new Map();
    this.playerStates = new Map();
    this.hostId = "";
    this.lastWorldSnapshot = null;
    this.lastMonsterSnapshot = null;
    this.lastBossSnapshot = null;
    this.seenEvents = new Map();
    this.attackWindows = new Map();
  }

  broadcast(data, exceptSocket = null) {
    for (const [socket] of this.clients) {
      if (socket === exceptSocket) continue;
      try {
        socket.send(data);
      } catch {
        this.removeSocket(socket);
      }
    }
  }

  sendToPlayer(playerId, data) {
    for (const [socket, id] of this.clients) {
      if (String(id) !== String(playerId)) continue;
      try {
        socket.send(data);
      } catch {
        this.removeSocket(socket);
      }
      return true;
    }
    return false;
  }

  pruneEvents(now = Date.now()) {
    for (const [id, ts] of this.seenEvents) {
      if (now - ts > EVENT_TTL_MS) this.seenEvents.delete(id);
    }

    while (this.seenEvents.size > MAX_EVENTS) {
      const first = this.seenEvents.keys().next();
      if (first.done) break;
      this.seenEvents.delete(first.value);
    }
  }

  isDuplicateEvent(requestId) {
    if (!requestId) return false;

    const id = String(requestId).slice(0, 160);
    const now = Date.now();

    this.pruneEvents(now);

    if (this.seenEvents.has(id)) return true;

    this.seenEvents.set(id, now);
    return false;
  }

  allowAttack(playerId) {
    const now = Date.now();
    let w = this.attackWindows.get(String(playerId));

    if (!w || now - w.start >= 1000) {
      w = {
        start: now,
        count: 0
      };

      this.attackWindows.set(String(playerId), w);
    }

    w.count++;

    return w.count <= ATTACKS_PER_SECOND;
  }

  sendRoomSnapshot(socket) {
    try {
      socket.send(
        JSON.stringify({
          type: "room_snapshot",
          version: "246.1",
          hostId: this.hostId,
          players: [...this.playerStates.values()],
          world: this.lastWorldSnapshot
            ? safeJsonParse(this.lastWorldSnapshot)
            : null,
          monsters: this.lastMonsterSnapshot
            ? safeJsonParse(this.lastMonsterSnapshot)?.monsters ?? null
            : null,
          bosses: this.lastBossSnapshot
            ? safeJsonParse(this.lastBossSnapshot)?.bosses ?? null
            : null
        })
      );
    } catch {
      this.removeSocket(socket);
    }
  }

  removeSocket(socket) {
    const id = this.clients.get(socket);
    if (!id) return;

    const wasHost =
      String(id) === String(this.hostId);

    this.clients.delete(socket);
    this.playerStates.delete(String(id));
    this.attackWindows.delete(String(id));

    if (wasHost) {
      const next = this.clients.values().next();

      this.hostId = next.done
        ? ""
        : next.value;

      this.lastWorldSnapshot = null;
      this.lastMonsterSnapshot = null;
      this.lastBossSnapshot = null;
    }

    this.broadcast(
      JSON.stringify({
        type: "player_left",
        id: String(id),
        players: this.clients.size,
        maxPlayers: MAX_PLAYERS_PER_ROOM,
        hostId: this.hostId
      })
    );

    if (wasHost && this.hostId) {
      this.broadcast(
        JSON.stringify({
          type: "room_host",
          hostId: this.hostId,
          players: this.clients.size,
          maxPlayers: MAX_PLAYERS_PER_ROOM
        })
      );
    }
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket only", {
        status: 426
      });
    }

    if (this.clients.size >= MAX_PLAYERS_PER_ROOM) {
      return new Response(
        "방이 가득 찼습니다. 최대 10명까지 입장할 수 있습니다.",
        { status: 409 }
      );
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const connectionId = crypto.randomUUID();

    server.accept();

    this.clients.set(server, connectionId);

    if (!this.hostId) {
      this.hostId = connectionId;
    }

    server.send(
      JSON.stringify({
        type: "connected",
        version: "246.1",
        players: this.clients.size,
        maxPlayers: MAX_PLAYERS_PER_ROOM,
        id: connectionId,
        hostId: this.hostId
      })
    );

    this.sendRoomSnapshot(server);

    this.broadcast(
      JSON.stringify({
        type: "player_joined",
        id: connectionId,
        players: this.clients.size,
        maxPlayers: MAX_PLAYERS_PER_ROOM,
        hostId: this.hostId
      }),
      server
    );

    server.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;

      if (
        new TextEncoder()
          .encode(event.data)
          .byteLength > MAX_MESSAGE_BYTES
      ) {
        return;
      }

      const msg = safeJsonParse(event.data);

      if (!msg || typeof msg !== "object") {
        return;
      }

      const playerId =
        this.clients.get(server);

      if (!playerId) return;

      const type = String(msg.type || "");

      if (type === "state") {
        const state = {
          ...msg,
          id: String(playerId),
          hostId: this.hostId,

          x: Number(msg.x) || 0,
          y: Number(msg.y) || 0,

          hp: Math.max(
            0,
            Number(msg.hp) || 0
          ),

          maxHp: Math.max(
            1,
            Number(msg.maxHp) || 1
          ),

          mp: Math.max(
            0,
            Number(msg.mp) || 0
          ),

          maxMp: Math.max(
            1,
            Number(msg.maxMp) || 1
          ),

          st: Math.max(
            0,
            Number(msg.st) || 0
          ),

          maxSt: Math.max(
            1,
            Number(msg.maxSt) || 1
          ),

          updatedAt: Date.now()
        };

        this.playerStates.set(
          String(playerId),
          state
        );

        this.broadcast(
          JSON.stringify(state),
          server
        );

        return;
      }

      if (type === "world_snapshot") {
        if (
          String(playerId) !==
          String(this.hostId)
        ) {
          return;
        }

        this.lastWorldSnapshot =
          event.data;

        this.broadcast(
          event.data,
          server
        );

        return;
      }

      if (type === "monster_state") {
        if (
          String(playerId) !==
          String(this.hostId)
        ) {
          return;
        }

        this.lastMonsterSnapshot =
          event.data;

        this.broadcast(
          event.data,
          server
        );

        return;
      }

      if (type === "boss_state") {
        if (
          String(playerId) !==
          String(this.hostId)
        ) {
          return;
        }

        this.lastBossSnapshot =
          event.data;

        this.broadcast(
          event.data,
          server
        );

        return;
      }

      if (
        type === "monster_attack" ||
        type === "boss_attack"
      ) {
        const attackerId =
          String(msg.attackerId || "");

        if (
          attackerId !==
          String(playerId)
        ) {
          return;
        }

        if (!this.allowAttack(attackerId)) {
          return;
        }

        if (
          this.isDuplicateEvent(
            msg.requestId
          )
        ) {
          return;
        }

        if (
          String(playerId) !==
          String(this.hostId)
        ) {
          this.sendToPlayer(
            this.hostId,
            event.data
          );
        }

        return;
      }

      if (
        type === "monster_reward" ||
        type === "boss_reward" ||
        type === "player_damage" ||
        type === "player_status"
      ) {
        if (
          String(playerId) !==
          String(this.hostId)
        ) {
          return;
        }

        this.broadcast(
          event.data,
          server
        );

        return;
      }

      this.broadcast(
        event.data,
        server
      );
    });

    const remove =
      () => this.removeSocket(server);

    server.addEventListener(
      "close",
      remove
    );

    server.addEventListener(
      "error",
      remove
    );

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }
}
