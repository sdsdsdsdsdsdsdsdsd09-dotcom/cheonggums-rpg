import { DurableObject } from "cloudflare:workers";

const MAX_PLAYERS_PER_ROOM = 10;

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
      return new Response("WebSocket 연결이 필요합니다.", {
        status: 426
      });
    }

    const roomId = decodeURIComponent(match[1]);
    const id = env.ROOMS.idFromName(roomId);
    const room = env.ROOMS.get(id);

    return room.fetch(request);
  }
};

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.clients = new Map();
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket only", {
        status: 426
      });
    }

    // 최대 10명
    if (this.clients.size >= MAX_PLAYERS_PER_ROOM) {
      return new Response(
        "방이 가득 찼습니다. 최대 10명까지 입장할 수 있습니다.",
        {
          status: 409
        }
      );
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const connectionId = crypto.randomUUID();

    server.accept();

    this.clients.set(server, connectionId);

    // 새로 접속한 플레이어에게 현재 방 인원 전달
    server.send(
      JSON.stringify({
        type: "connected",
        id: connectionId,
        players: this.clients.size,
        maxPlayers: MAX_PLAYERS_PER_ROOM
      })
    );

    // 기존 플레이어들에게 새 플레이어 입장 알림
    for (const [other] of this.clients) {
      if (other === server) continue;

      try {
        other.send(
          JSON.stringify({
            type: "player_joined",
            id: connectionId,
            players: this.clients.size,
            maxPlayers: MAX_PLAYERS_PER_ROOM
          })
        );
      } catch {
        this.clients.delete(other);
      }
    }

    // 메시지 전달
    server.addEventListener("message", (event) => {
      for (const [other] of this.clients) {
        if (other === server) continue;

        try {
          other.send(event.data);
        } catch {
          this.clients.delete(other);
        }
      }
    });

    const removePlayer = () => {
      const id = this.clients.get(server);

      this.clients.delete(server);

      // 남아 있는 플레이어들에게 퇴장 알림
      for (const [other] of this.clients) {
        try {
          other.send(
            JSON.stringify({
              type: "player_left",
              id,
              players: this.clients.size,
              maxPlayers: MAX_PLAYERS_PER_ROOM
            })
          );
        } catch {
          this.clients.delete(other);
        }
      }
    };

    server.addEventListener("close", removePlayer);
    server.addEventListener("error", removePlayer);

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }
}
