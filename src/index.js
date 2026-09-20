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

    // 현재 방의 최신 월드 상태
    this.lastWorldSnapshot = null;

    // 현재 방의 최신 몬스터 상태
    this.lastMonsterSnapshot = null;
  }

  broadcast(data, exceptSocket = null) {
    for (const [socket] of this.clients) {
      if (socket === exceptSocket) continue;

      try {
        socket.send(data);
      } catch {
        this.clients.delete(socket);
      }
    }
  }

  socketForPlayer(id) {
    for (const [socket, playerId] of this.clients) {
      if (String(playerId) === String(id)) {
        return socket;
      }
    }

    return null;
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

    server.send(
      JSON.stringify({
        type: "connected",
        id: connectionId,
        hostId: this.hostId,
        players: this.clients.size,
        maxPlayers: MAX_PLAYERS_PER_ROOM
      })
    );

    // 새 플레이어에게 현재 월드 전달
    if (this.lastWorldSnapshot) {
      try {
        server.send(this.lastWorldSnapshot);
      } catch {}
    }

    // 새 플레이어에게 현재 몬스터 상태 전달
    if (this.lastMonsterSnapshot) {
      try {
        server.send(this.lastMonsterSnapshot);
      } catch {}
    }

    // 기존 플레이어에게 입장 알림
    this.broadcast(
      JSON.stringify({
        type: "player_joined",
        id: connectionId,
        hostId: this.hostId,
        players: this.clients.size,
        maxPlayers: MAX_PLAYERS_PER_ROOM
      }),
      server
    );

    server.addEventListener("message", (event) => {
      let msg = null;

      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      const senderId = this.clients.get(server);

      if (!senderId) {
        return;
      }

      // ---------------------------------------------------------
      // 방장 월드 스냅샷
      // ---------------------------------------------------------
      if (msg.type === "world_snapshot") {
        if (String(senderId) !== String(this.hostId)) {
          return;
        }

        this.lastWorldSnapshot = event.data;
        this.broadcast(event.data, server);
        return;
      }

      // ---------------------------------------------------------
      // 방장 몬스터 스냅샷
      // ---------------------------------------------------------
      if (msg.type === "monster_state") {
        if (String(senderId) !== String(this.hostId)) {
          return;
        }

        this.lastMonsterSnapshot = event.data;
        this.broadcast(event.data, server);
        return;
      }

      // ---------------------------------------------------------
      // 플레이어 상태 / 위치
      // ---------------------------------------------------------
      if (msg.type === "state") {
        this.broadcast(event.data, server);
        return;
      }

      // ---------------------------------------------------------
      // 비방장의 몬스터 공격
      // → 방장에게만 전달
      // ---------------------------------------------------------
      if (msg.type === "monster_attack") {
        if (String(senderId) === String(this.hostId)) {
          return;
        }

        // 다른 사람의 ID를 사칭하지 못하게 확인
        if (
          String(msg.attackerId || "") !==
          String(senderId)
        ) {
          return;
        }

        const hostSocket = this.socketForPlayer(
          this.hostId
        );

        if (hostSocket) {
          try {
            hostSocket.send(event.data);
          } catch {}
        }

        return;
      }

      // ---------------------------------------------------------
      // 방장이 비방장에게 몬스터 피해 전달
      // ---------------------------------------------------------
      if (msg.type === "monster_hit_player") {
        if (
          String(senderId) !==
          String(this.hostId)
        ) {
          return;
        }

        const targetSocket =
          this.socketForPlayer(msg.targetId);

        if (targetSocket) {
          try {
            targetSocket.send(event.data);
          } catch {}
        }

        return;
      }

      // ---------------------------------------------------------
      // 기타 메시지
      // ---------------------------------------------------------
      this.broadcast(event.data, server);
    });

    let removed = false;

    const removePlayer = () => {
      if (removed) {
        return;
      }

      removed = true;

      const id = this.clients.get(server);

      const wasHost =
        String(id) ===
        String(this.hostId);

      this.clients.delete(server);

      // 방장이 나가면 다음 사람을 새 방장으로 지정
      if (wasHost) {
        const next =
          this.clients.values().next();

        this.hostId = next.done
          ? ""
          : next.value;

        // 이전 방장 기준 월드는 폐기
        this.lastWorldSnapshot = null;
        this.lastMonsterSnapshot = null;
      }

      this.broadcast(
        JSON.stringify({
          type: "player_left",
          id,
          hostId: this.hostId,
          players: this.clients.size,
          maxPlayers: MAX_PLAYERS_PER_ROOM
        })
      );

      // 새 방장 알림
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
    };

    server.addEventListener(
      "close",
      removePlayer
    );

    server.addEventListener(
      "error",
      removePlayer
    );

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }
}
