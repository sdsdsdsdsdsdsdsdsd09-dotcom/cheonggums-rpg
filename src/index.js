import { DurableObject } from "cloudflare:workers";

const MAX_PLAYERS_PER_ROOM = 10;
const activeRooms = new Map();
const ROOM_LIST_TTL_MS = 2 * 60 * 1000;

function roomListResponse(request) {
  const origin = request.headers.get("Origin") || "*";
  const now = Date.now();

  for (const [code, room] of activeRooms) {
    if (
      !room ||
      room.players <= 0 ||
      now - room.lastSeen > ROOM_LIST_TTL_MS
    ) {
      activeRooms.delete(code);
    }
  }

  const rooms = [...activeRooms.values()]
    .sort(
      (a, b) =>
        b.players - a.players || a.code.localeCompare(b.code)
    )
    .slice(0, 50);

  return new Response(
    JSON.stringify({
      rooms,
      ts: now
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    }
  );
}

function updateActiveRoom(code, players, hostName = "") {
  if (!code) return;

  const prev = activeRooms.get(code) || {};
  const count = Math.max(
    0,
    Math.min(MAX_PLAYERS_PER_ROOM, Number(players) || 0)
  );

  if (!count) {
    activeRooms.delete(code);
    return;
  }

  activeRooms.set(code, {
    code: String(code).slice(0, 64),
    players: count,
    hostName: String(
      hostName || prev.hostName || ""
    ).slice(0, 16),
    lastSeen: Date.now()
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 서버 상태 확인
    if (url.pathname === "/health") {
      return new Response("청구 RPG 멀티 서버 정상 작동");
    }

    // 방 목록
    if (url.pathname === "/rooms") {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin":
              request.headers.get("Origin") || "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type"
          }
        });
      }

      if (request.method !== "GET") {
        return new Response("Method Not Allowed", {
          status: 405
        });
      }

      return roomListResponse(request);
    }

    // 방 접속
    const match = url.pathname.match(/^\/room\/([^/]+)$/);

    if (!match) {
      return new Response("청구 RPG 멀티 서버", {
        status: 200
      });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response(
        "WebSocket 연결이 필요합니다.",
        {
          status: 426
        }
      );
    }

    const roomId = decodeURIComponent(match[1]);

    const id = env.ROOMS.idFromName(roomId);
    return env.ROOMS.get(id).fetch(request);
  }
};

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

    // websocket -> connectionId
    this.clients = new Map();

    // 현재 방장
    this.hostId = "";

    // connectionId -> state
    this.states = new Map();

    // partyId -> party
    this.parties = new Map();

    // connectionId -> last message time
    this.lastMessageAt = new Map();

    this.roomCode = "";
  }

  broadcast(payload, except = null) {
    const data =
      typeof payload === "string"
        ? payload
        : JSON.stringify(payload);

    for (const [other] of this.clients) {
      if (other === except) continue;

      try {
        other.send(data);
      } catch {
        this.removeClient(other);
      }
    }
  }

  sendRoomSnapshot(server) {
    const players = [];

    for (const [ws, id] of this.clients) {
      const state = this.states.get(id);

      if (state) {
        players.push(state);
      }
    }

    const party = this.getPartyForPlayer(
      this.clients.get(server)
    );

    const partyMembers = party
      ? [...party.members]
      : [];

    try {
      server.send(
        JSON.stringify({
          type: "room_snapshot",
          hostId: this.hostId,
          players,

          partyId: party?.id || "",
          partyLeaderId:
            party?.leaderId || "",
          partyMembers,

          maxPartyMembers: 4
        })
      );
    } catch {}
  }

  getPartyForPlayer(playerId) {
    if (!playerId) return null;

    for (const [id, party] of this.parties) {
      if (party.members.has(playerId)) {
        return {
          id,
          ...party
        };
      }
    }

    return null;
  }

  broadcastParty(partyId) {
    const party = this.parties.get(partyId);

    if (!party) return;

    const payload = {
      type: "party_state",
      partyId,
      leaderId: party.leaderId,
      members: [...party.members],
      maxMembers: 4
    };

    for (const [ws, id] of this.clients) {
      if (!party.members.has(id)) continue;

      try {
        ws.send(JSON.stringify(payload));
      } catch {
        this.removeClient(ws);
      }
    }
  }

  leaveParty(playerId) {
    const party = this.getPartyForPlayer(playerId);

    if (!party) return;

    const set = this.parties.get(party.id);

    if (!set) return;

    set.members.delete(playerId);

    if (!set.members.size) {
      this.parties.delete(party.id);
    } else {
      if (set.leaderId === playerId) {
        set.leaderId =
          [...set.members][0];
      }

      this.broadcastParty(party.id);
    }
  }

  removeClient(server) {
    const id = this.clients.get(server);

    if (!id) return;

    this.leaveParty(id);

    this.states.delete(id);
    this.lastMessageAt.delete(id);

    const wasHost =
      id === this.hostId;

    this.clients.delete(server);

    if (wasHost) {
      const next =
        this.clients.values().next();

      this.hostId =
        next.done
          ? ""
          : next.value;
    }

    this.broadcast({
      type: "player_left",
      id,
      players: this.clients.size,
      maxPlayers: MAX_PLAYERS_PER_ROOM,
      hostId: this.hostId
    });

    const hostState =
      this.states.get(this.hostId);

    updateActiveRoom(
      this.roomCode,
      this.clients.size,
      hostState?.name || ""
    );
  }

  async fetch(request) {
    const requestUrl =
      new URL(request.url);

    const roomMatch =
      requestUrl.pathname.match(
        /^\/room\/([^/]+)$/
      );

    this.roomCode =
      roomMatch
        ? decodeURIComponent(roomMatch[1])
        : this.roomCode;

    if (
      request.headers.get("Upgrade") !==
      "websocket"
    ) {
      return new Response(
        "WebSocket only",
        {
          status: 426
        }
      );
    }

    if (
      this.clients.size >=
      MAX_PLAYERS_PER_ROOM
    ) {
      return new Response(
        "방이 가득 찼습니다. 최대 10명까지 입장할 수 있습니다.",
        {
          status: 409
        }
      );
    }

    const pair =
      new WebSocketPair();

    const [client, server] =
      Object.values(pair);

    const connectionId =
      crypto.randomUUID();

    server.accept();

    this.clients.set(
      server,
      connectionId
    );

    if (!this.hostId) {
      this.hostId =
        connectionId;
    }

    updateActiveRoom(
      this.roomCode,
      this.clients.size,
      ""
    );

    // 연결 성공
    server.send(
      JSON.stringify({
        type: "connected",
        players:
          this.clients.size,
        maxPlayers:
          MAX_PLAYERS_PER_ROOM,
        id: connectionId,
        hostId: this.hostId
      })
    );

    // 현재 방 상태 전송
    this.sendRoomSnapshot(server);

    // 다른 사람들에게 입장 알림
    this.broadcast(
      {
        type: "player_joined",
        id: connectionId,
        players:
          this.clients.size,
        maxPlayers:
          MAX_PLAYERS_PER_ROOM,
        hostId: this.hostId
      },
      server
    );

    server.addEventListener(
      "message",
      (event) => {
        const id =
          this.clients.get(server);

        if (!id) return;

        const now = Date.now();

        const last =
          this.lastMessageAt.get(id) ||
          0;

        // 기본적인 메시지 도배 방지
        if (now - last < 15) {
          return;
        }

        this.lastMessageAt.set(
          id,
          now
        );

        let msg;

        try {
          msg =
            JSON.parse(event.data);
        } catch {
          return;
        }

        if (
          !msg ||
          typeof msg !== "object"
        ) {
          return;
        }

        // 플레이어 상태
        if (msg.type === "state") {
          // 서버가 ID를 강제로 결정
          msg.id = id;
          msg.hostId =
            this.hostId;

          msg.name =
            String(
              msg.name ||
                "플레이어"
            ).slice(0, 16);

          msg.x =
            Number.isFinite(
              Number(msg.x)
            )
              ? Number(msg.x)
              : 0;

          msg.y =
            Number.isFinite(
              Number(msg.y)
            )
              ? Number(msg.y)
              : 0;

          msg.hp = Math.max(
            0,
            Math.min(
              100000000,
              Number(msg.hp) || 0
            )
          );

          msg.maxHp =
            Math.max(
              1,
              Math.min(
                100000000,
                Number(msg.maxHp) || 1
              )
            );

          this.states.set(
            id,
            msg
          );

          const hostState =
            this.states.get(
              this.hostId
            );

          updateActiveRoom(
            this.roomCode,
            this.clients.size,
            hostState?.name || ""
          );

          this.broadcast(
            msg,
            server
          );

          return;
        }

        // 채팅
        if (msg.type === "chat") {
          const text =
            String(
              msg.text || ""
            )
              .trim()
              .slice(0, 120);

          if (!text) return;

          const state =
            this.states.get(id);

          this.broadcast({
            type: "chat",
            id,
            name: String(
              state?.name ||
                "플레이어"
            ).slice(0, 16),
            text,
            ts: now
          });

          return;
        }

        // 파티 생성 / 참가
        if (
          msg.type ===
          "party_join"
        ) {
          let party =
            this.getPartyForPlayer(
              id
            );

          if (!party) {
            const partyId =
              `P-${crypto
                .randomUUID()
                .slice(
                  0,
                  8
                )
                .toUpperCase()}`;

            const record = {
              id: partyId,
              leaderId: id,
              members:
                new Set([id])
            };

            this.parties.set(
              partyId,
              record
            );

            party = {
              id: partyId,
              ...record
            };
          } else if (
            party.members.size < 4
          ) {
            const record =
              this.parties.get(
                party.id
              );

            record.members.add(id);

            party = {
              id: party.id,
              ...record
            };
          }

          this.broadcastParty(
            party.id
          );

          return;
        }

        // 파티 탈퇴
        if (
          msg.type ===
          "party_leave"
        ) {
          const party =
            this.getPartyForPlayer(
              id
            );

          if (party) {
            this.leaveParty(id);
          }

          return;
        }

        // 나머지 게임 메시지
        // 서버가 보낸 사람의 ID를 강제로 붙임
        msg.senderId = id;

        this.broadcast(
          msg,
          server
        );
      }
    );

    const remove = () =>
      this.removeClient(server);

    server.addEventListener(
      "close",
      remove
    );

    server.addEventListener(
      "error",
      remove
    );

    return new Response(
      null,
      {
        status: 101,
        webSocket: client
      }
    );
  }
}
