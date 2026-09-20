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

    return env.ROOMS.get(id).fetch(request);
  }
};

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

    this.clients = new Map();
    this.hostId = "";

    // 방의 최신 월드 상태
    this.lastWorldSnapshot = null;

    // 방의 최신 몬스터 상태
    this.lastMonsterSnapshot = null;
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

    // 첫 번째 플레이어가 방장
    if (!this.hostId) {
      this.hostId = connectionId;
    }

    // 서버가 사용하는 실제 플레이어 ID 전달
    server.send(
      JSON.stringify({
        type: "connected",
        players: this.clients.size,
        maxPlayers: MAX_PLAYERS_PER_ROOM,
        id: connectionId,
        hostId: this.hostId
      })
    );

    // 새 플레이어에게 최신 월드 상태 전달
    if (this.lastWorldSnapshot) {
      try {
        server.send(this.lastWorldSnapshot);
      } catch {}
    }

    // 새 플레이어에게 최신 몬스터 상태 전달
    if (this.lastMonsterSnapshot) {
      try {
        server.send(this.lastMonsterSnapshot);
      } catch {}
    }

    // 기존 플레이어들에게 새 플레이어 입장 알림
    for (const [other] of this.clients) {
      if (other === server) continue;

      try {
        other.send(
          JSON.stringify({
            type: "player_joined",
            id: connectionId,
            players: this.clients.size,
            maxPlayers: MAX_PLAYERS_PER_ROOM,
            hostId: this.hostId
          })
        );
      } catch {
        this.clients.delete(other);
      }
    }

    server.addEventListener("message", (event) => {
      let message = null;

      try {
        message = JSON.parse(event.data);
      } catch {}

      const senderId = this.clients.get(server);

      // 서버 기준 방장인지 확인
      const isHostMessage =
        !!senderId && senderId === this.hostId;

      // 방장이 보낸 월드 상태 저장
      if (
        isHostMessage &&
        message?.type === "world_snapshot"
      ) {
        this.lastWorldSnapshot = event.data;
      }

      // 방장이 보낸 몬스터 상태 저장
      if (
        isHostMessage &&
        message?.type === "monster_state"
      ) {
        this.lastMonsterSnapshot = event.data;
      }

      // 같은 방의 다른 플레이어에게 전달
      for (const [other] of this.clients) {
        if (other === server) continue;

        try {
          other.send(event.data);
        } catch {
          this.clients.delete(other);
        }
      }
    });

    const remove = () => {
      const id = this.clients.get(server);

      const wasHost =
        id === this.hostId;

      this.clients.delete(server);

      // 방장이 나가면 다음 사람을 방장으로
      if (wasHost) {
        const next = this.clients.values().next();

        this.hostId = next.done
          ? ""
          : next.value;

        // 기존 방장 기준 월드 데이터 제거
        this.lastWorldSnapshot = null;
        this.lastMonsterSnapshot = null;
      }

      for (const [other] of this.clients) {
        try {
          other.send(
            JSON.stringify({
              type: "player_left",
              id,
              players: this.clients.size,
              maxPlayers: MAX_PLAYERS_PER_ROOM,
              hostId: this.hostId
            })
          );
        } catch {
          this.clients.delete(other);
        }
      }
    };

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
