import { DurableObject } from "cloudflare:workers";

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
    const room = env.ROOMS.get(id);

    return room.fetch(request);
  }
};

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.clients = new Set();
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket only", { status: 426 });
    }

    if (this.clients.size >= 2) {
      return new Response("방이 가득 찼습니다.", { status: 409 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.accept();
    this.clients.add(server);

    server.send(JSON.stringify({
      type: "connected",
      players: this.clients.size
    }));

    for (const other of this.clients) {
      if (other !== server) {
        try {
          other.send(JSON.stringify({
            type: "player_joined"
          }));
        } catch {
          this.clients.delete(other);
        }
      }
    }

    server.addEventListener("message", (event) => {
      for (const other of this.clients) {
        if (other !== server) {
          try {
            other.send(event.data);
          } catch {
            this.clients.delete(other);
          }
        }
      }
    });

    const remove = () => {
      this.clients.delete(server);

      for (const other of this.clients) {
        try {
          other.send(JSON.stringify({
            type: "player_left"
          }));
        } catch {
          this.clients.delete(other);
        }
      }
    };

    server.addEventListener("close", remove);
    server.addEventListener("error", remove);

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }
}
