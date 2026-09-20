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
    this.playerStates = new Map();

    this.hostId = "";

    // 방장이 마지막으로 보낸 월드 상태
    this.lastHostState = null;

    // 방장이 마지막으로 보낸 몬스터 상태
    this.lastMonsterState = null;
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

    // 첫 번째 플레이어가 방장이 됩니다.
    if (!this.hostId) {
      this.hostId = connectionId;
    }

    // 새 플레이어에게 기본 연결 정보 전달
    server.send(
      JSON.stringify({
        type: "connected",
        players: this.clients.size,
        maxPlayers: MAX_PLAYERS_PER_ROOM,
        id: connectionId,
        hostId: this.hostId
      })
    );

    // 이미 들어와 있는 플레이어들의 최신 상태를 즉시 전달
    for (const [id, state] of this.playerStates) {
      if (id === connectionId || !state) continue;

      try {
        server.send(state);
      } catch {}
    }

    // 방장의 마지막 월드 상태를 즉시 전달
    if (this.lastHostState) {
      try {
        server.send(this.lastHostState);
      } catch {}
    }

    // 방장의 마지막 몬스터 상태를 즉시 전달
    if (this.lastMonsterState) {
      try {
        server.send(this.lastMonsterState);
      } catch {}
    }

    // 기존 플레이어에게 새 플레이어 입장 알림
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

      // 플레이어 상태 저장
      if (message?.type === "state" && message.id) {
        this.playerStates.set(
          String(message.id),
          event.data
        );

        // 방장 상태 저장
        if (String(message.id) === String(this.hostId)) {
          this.lastHostState = event.data;
        }
      }

      // 방장 몬스터 상태 저장
      if (
        message?.type === "monster_state" &&
        String(message.hostId || "") === String(this.hostId)
      ) {
        this.lastMonsterState = event.data;
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
        String(id) === String(this.hostId);

      this.clients.delete(server);
      this.playerStates.delete(String(id));

      // 방장이 나갔으면 다음 플레이어를 새 방장으로 지정
      if (wasHost) {
        const next = this.clients.values().next();

        this.hostId = next.done
          ? ""
          : next.value;

        // 기존 방장 월드 상태는 폐기
        this.lastHostState = null;
        this.lastMonsterState = null;
      }

      // 나머지 플레이어에게 퇴장 알림
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
