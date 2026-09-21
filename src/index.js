import { DurableObject } from "cloudflare:workers";

const MAX_PLAYERS_PER_ROOM = 10;
const ROOM_LIST_TTL_MS = 2 * 60 * 1000;
const MAX_SAVE_BYTES = 900_000;
const MAX_BASE64_LENGTH = 1_300_000;
const SAVE_FORMAT = "cheonggu_rpg_web_save";
const SAVE_FORMAT_VERSION = 2;

// /rooms is an in-memory discovery list. Persistent player saves live in Durable Object storage.
const activeRooms = new Map();

function corsHeaders(request) {
  return {
    "Access-Control-Allow-Origin":
      request.headers.get("Origin") || "*",
    "Access-Control-Allow-Methods":
      "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type",
    "Cache-Control": "no-store",
  };
}

function jsonResponse(request, body, status = 200) {
  return new Response(
    JSON.stringify(body),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=utf-8",
        ...corsHeaders(request),
      },
    }
  );
}

function roomListResponse(request) {
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
        b.players - a.players ||
        a.code.localeCompare(b.code)
    )
    .slice(0, 50);

  return jsonResponse(request, {
    rooms,
    ts: now,
  });
}

function updateActiveRoom(
  code,
  players,
  hostName = ""
) {
  if (!code) return;

  const prev =
    activeRooms.get(code) || {};

  const count = Math.max(
    0,
    Math.min(
      MAX_PLAYERS_PER_ROOM,
      Number(players) || 0
    )
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
    lastSeen: Date.now(),
  });
}

function clampNumber(
  value,
  min,
  max,
  fallback = min
) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return fallback;
  }

  return Math.max(
    min,
    Math.min(max, n)
  );
}

function decodeBase64Utf8(base64) {
  if (
    typeof base64 !== "string" ||
    !base64 ||
    base64.length > MAX_BASE64_LENGTH
  ) {
    throw new Error(
      "invalid_base64_length"
    );
  }

  const raw = atob(base64);

  if (raw.length > MAX_SAVE_BYTES) {
    throw new Error(
      "save_too_large"
    );
  }

  const bytes =
    Uint8Array.from(
      raw,
      ch => ch.charCodeAt(0)
    );

  return new TextDecoder().decode(bytes);
}

async function sha256Hex(text) {
  const data =
    new TextEncoder().encode(
      String(text)
    );

  const digest =
    await crypto.subtle.digest(
      "SHA-256",
      data
    );

  return [
    ...new Uint8Array(digest),
  ]
    .map(v =>
      v.toString(16).padStart(2, "0")
    )
    .join("");
}

function validateSaveEnvelope(
  envelope
) {
  if (
    !envelope ||
    typeof envelope !== "object"
  ) {
    return {
      ok: false,
      reason: "invalid_envelope",
    };
  }

  if (
    envelope.format !==
    SAVE_FORMAT
  ) {
    return {
      ok: false,
      reason: "invalid_format",
    };
  }

  if (
    Number(
      envelope.formatVersion
    ) !== SAVE_FORMAT_VERSION
  ) {
    return {
      ok: false,
      reason: "invalid_format_version",
    };
  }

  const gameSave =
    envelope.gameSave;

  if (
    !gameSave ||
    typeof gameSave !== "object" ||
    !gameSave.player ||
    typeof gameSave.player !==
      "object"
  ) {
    return {
      ok: false,
      reason: "invalid_game_save",
    };
  }

  const p = gameSave.player;

  const level = Math.floor(
    clampNumber(
      p.level,
      1,
      100,
      1
    )
  );

  const gold = Math.floor(
    clampNumber(
      p.gold,
      0,
      800000,
      0
    )
  );

  const maxHp =
    clampNumber(
      p.maxHp,
      1,
      100000000,
      100
    );

  const hp =
    clampNumber(
      p.hp,
      0,
      maxHp,
      0
    );

  const maxMp =
    clampNumber(
      p.maxMp,
      1,
      100000000,
      100
    );

  const mp =
    clampNumber(
      p.mp,
      0,
      maxMp,
      0
    );

  const maxSt =
    clampNumber(
      p.maxSt,
      100,
      1000,
      100
    );

  const st =
    clampNumber(
      p.st,
      0,
      maxSt,
      0
    );

  const hpPotions =
    Math.floor(
      clampNumber(
        p.hpPotions,
        0,
        10,
        0
      )
    );

  const mpPotions =
    Math.floor(
      clampNumber(
        p.mpPotions,
        0,
        10,
        0
      )
    );

  const dungeonFloor =
    Math.floor(
      clampNumber(
        gameSave.dungeonFloor,
        1,
        3,
        1
      )
    );

  if (
    level !== Number(p.level)
  ) {
    return {
      ok: false,
      reason: "invalid_level",
    };
  }

  if (
    gold !== Number(p.gold)
  ) {
    return {
      ok: false,
      reason: "invalid_gold",
    };
  }

  if (
    hp !== Number(p.hp) ||
    maxHp !== Number(p.maxHp)
  ) {
    return {
      ok: false,
      reason: "invalid_hp",
    };
  }

  if (
    mp !== Number(p.mp) ||
    maxMp !== Number(p.maxMp)
  ) {
    return {
      ok: false,
      reason: "invalid_mp",
    };
  }

  if (
    st !== Number(p.st) ||
    maxSt !== Number(p.maxSt)
  ) {
    return {
      ok: false,
      reason: "invalid_stamina",
    };
  }

  if (
    hpPotions !==
      Number(p.hpPotions) ||
    mpPotions !==
      Number(p.mpPotions)
  ) {
    return {
      ok: false,
      reason: "invalid_potions",
    };
  }

  if (
    dungeonFloor !==
      Number(gameSave.dungeonFloor)
  ) {
    return {
      ok: false,
      reason:
        "invalid_dungeon_floor",
    };
  }

  if (
    p.items !== undefined &&
    (
      typeof p.items !== "object" ||
      Array.isArray(p.items)
    )
  ) {
    return {
      ok: false,
      reason: "invalid_items",
    };
  }

  if (
    p.purchasedEquipmentQty !==
      undefined &&
    (
      typeof p.purchasedEquipmentQty !==
        "object" ||
      Array.isArray(
        p.purchasedEquipmentQty
      )
    )
  ) {
    return {
      ok: false,
      reason: "invalid_equipment",
    };
  }

  const validateQtyMap = (
    map,
    equipmentOnly = false
  ) => {
    if (!map) return true;

    for (
      const [key, value]
      of Object.entries(map)
    ) {
      if (
        typeof key !== "string" ||
        key.length > 120
      ) {
        return false;
      }

      const n = Number(value);

      if (
        !Number.isInteger(n) ||
        n < 0 ||
        n >
          (
            equipmentOnly
              ? 1
              : 1000000
          )
      ) {
        return false;
      }
    }

    return true;
  };

  if (
    !validateQtyMap(p.items)
  ) {
    return {
      ok: false,
      reason:
        "invalid_item_quantity",
    };
  }

  if (
    !validateQtyMap(
      p.purchasedEquipmentQty,
      true
    )
  ) {
    return {
      ok: false,
      reason:
        "invalid_equipment_quantity",
    };
  }

  return {
    ok: true,
    level,
    gold,
    maxHp,
    hp,
    maxMp,
    mp,
    maxSt,
    st,
  };
}

function extractComparableSave(
  saved
) {
  try {
    const envelope =
      JSON.parse(
        decodeBase64Utf8(
          saved.data
        )
      );

    return (
      envelope?.gameSave?.player ||
      null
    );
  } catch {
    return null;
  }
}

function basicProgressCheck(
  previousPlayer,
  nextPlayer
) {
  if (
    !previousPlayer ||
    !nextPlayer
  ) {
    return {
      ok: true,
    };
  }

  const prevLevel =
    Number(
      previousPlayer.level
    ) || 1;

  const nextLevel =
    Number(
      nextPlayer.level
    ) || 1;

  // A single client save cannot jump dozens of levels at once.
  if (
    nextLevel >
    prevLevel + 1
  ) {
    return {
      ok: false,
      reason: "level_jump",
    };
  }

  // Max stamina can only move through the known altar progression.
  const allowedMaxSt =
    new Set([
      100,
      500,
      700,
      850,
      1000,
    ]);

  if (
    !allowedMaxSt.has(
      Number(nextPlayer.maxSt)
    )
  ) {
    return {
      ok: false,
      reason:
        "invalid_max_stamina",
    };
  }

  // Equipment ownership is capped at one.
  for (
    const value of Object.values(
      nextPlayer
        .purchasedEquipmentQty ||
        {}
    )
  ) {
    if (
      Number(value) > 1
    ) {
      return {
        ok: false,
        reason:
          "equipment_overflow",
      };
    }
  }

  return {
    ok: true,
  };
}

export default {
  async fetch(request, env) {
    const url =
      new URL(request.url);

    if (
      request.method ===
        "OPTIONS" &&
      (
        url.pathname ===
          "/rooms" ||
        url.pathname.startsWith(
          "/save/"
        )
      )
    ) {
      return new Response(
        null,
        {
          status: 204,
          headers:
            corsHeaders(request),
        }
      );
    }

    if (
      url.pathname ===
      "/health"
    ) {
      return new Response(
        "청구 RPG 멀티 서버 정상 작동",
        {
          status: 200,
        }
      );
    }

    if (
      url.pathname ===
      "/rooms"
    ) {
      if (
        request.method !==
        "GET"
      ) {
        return new Response(
          "Method Not Allowed",
          {
            status: 405,
          }
        );
      }

      return roomListResponse(
        request
      );
    }

    const saveMatch =
      url.pathname.match(
        /^\/save\/([^/]+)$/
      );

    if (saveMatch) {
      const saveId =
        decodeURIComponent(
          saveMatch[1]
        ).slice(0, 128);

      if (
        !/^[A-Za-z0-9_-]{12,128}$/.test(
          saveId
        )
      ) {
        return jsonResponse(
          request,
          {
            error:
              "invalid_save_id",
          },
          400
        );
      }

      const id =
        env.ROOMS.idFromName(
          `save:${saveId}`
        );

      return env.ROOMS
        .get(id)
        .fetch(request);
    }

    const match =
      url.pathname.match(
        /^\/room\/([^/]+)$/
      );

    if (!match) {
      return new Response(
        "청구 RPG 멀티 서버",
        {
          status: 200,
        }
      );
    }

    if (
      request.headers.get(
        "Upgrade"
      ) !== "websocket"
    ) {
      return new Response(
        "WebSocket 연결이 필요합니다.",
        {
          status: 426,
        }
      );
    }

    const roomId =
      decodeURIComponent(
        match[1]
      );

    const id =
      env.ROOMS.idFromName(
        roomId
      );

    return env.ROOMS
      .get(id)
      .fetch(request);
  },
};

export class GameRoom
  extends DurableObject {

  constructor(ctx, env) {
    super(ctx, env);

    this.clients =
      new Map();

    this.hostId = "";

    this.states =
      new Map();

    this.parties =
      new Map();

    this.lastMessageAt =
      new Map();

    this.roomCode = "";
  }

  async handleSaveRequest(
    request
  ) {
    const existing =
      await this.ctx.storage.get(
        "playerSave"
      );

    if (
      request.method ===
      "GET"
    ) {
      if (!existing) {
        return jsonResponse(
          request,
          {
            exists: false,
          },
          404
        );
      }

      return jsonResponse(
        request,
        {
          exists: true,
          data: existing.data,
          hash: existing.hash,
          revision:
            existing.revision,
          savedAt:
            existing.savedAt,
        }
      );
    }

    if (
      request.method !==
      "POST"
    ) {
      return jsonResponse(
        request,
        {
          error:
            "method_not_allowed",
        },
        405
      );
    }

    let body;

    try {
      if (
        (
          Number(
            request.headers.get(
              "content-length"
            )
          ) || 0
        ) > 1500000
      ) {
        throw new Error(
          "request_too_large"
        );
      }

      body =
        await request.json();
    } catch {
      return jsonResponse(
        request,
        {
          error:
            "invalid_request",
        },
        400
      );
    }

    const data =
      String(
        body?.data || ""
      );

    const suppliedHash =
      String(
        body?.hash || ""
      ).toLowerCase();

    const revision =
      Math.max(
        0,
        Math.floor(
          Number(
            body?.revision
          ) || 0
        )
      );

    const previousHash =
      String(
        body?.previousHash ||
          ""
      ).toLowerCase();

    if (
      !data ||
      data.length >
        MAX_BASE64_LENGTH ||
      !/^[A-Za-z0-9+/=]+$/.test(
        data
      )
    ) {
      return jsonResponse(
        request,
        {
          error:
            "invalid_data",
        },
        400
      );
    }

    if (
      !/^[a-f0-9]{64}$/.test(
        suppliedHash
      )
    ) {
      return jsonResponse(
        request,
        {
          error:
            "invalid_hash",
        },
        400
      );
    }

    let envelope;
    let decodedText;

    try {
      decodedText =
        decodeBase64Utf8(
          data
        );

      envelope =
        JSON.parse(
          decodedText
        );
    } catch {
      return jsonResponse(
        request,
        {
          error:
            "invalid_save_payload",
        },
        400
      );
    }

    const actualHash =
      await sha256Hex(data);

    if (
      actualHash !==
      suppliedHash
    ) {
      return jsonResponse(
        request,
        {
          error:
            "hash_mismatch",
        },
        400
      );
    }

    const validation =
      validateSaveEnvelope(
        envelope
      );

    if (!validation.ok) {
      return jsonResponse(
        request,
        {
          error:
            validation.reason,
        },
        422
      );
    }

    if (existing) {
      if (
        revision !==
          Number(
            existing.revision
          ) ||
        previousHash !==
          String(
            existing.hash || ""
          ).toLowerCase()
      ) {
        return jsonResponse(
          request,
          {
            error:
              "save_conflict",
            exists: true,
            data:
              existing.data,
            hash:
              existing.hash,
            revision:
              existing.revision,
            savedAt:
              existing.savedAt,
          },
          409
        );
      }

      const previousPlayer =
        extractComparableSave(
          existing
        );

      const progress =
        basicProgressCheck(
          previousPlayer,
          envelope
            .gameSave
            .player
        );

      if (!progress.ok) {
        return jsonResponse(
          request,
          {
            error:
              progress.reason,
            exists: true,
            data:
              existing.data,
            hash:
              existing.hash,
            revision:
              existing.revision,
            savedAt:
              existing.savedAt,
          },
          422
        );
      }
    } else if (
      revision !== 0 ||
      previousHash
    ) {
      return jsonResponse(
        request,
        {
          error:
            "invalid_initial_revision",
        },
        409
      );
    }

    const next = {
      data,
      hash:
        actualHash,
      revision:
        existing
          ? Number(
              existing.revision
            ) + 1
          : 1,
      savedAt:
        new Date().toISOString(),
      format:
        SAVE_FORMAT,
      formatVersion:
        SAVE_FORMAT_VERSION,
    };

    await this.ctx.storage.put(
      "playerSave",
      next
    );

    return jsonResponse(
      request,
      {
        ok: true,
        exists: true,
        data: next.data,
        hash: next.hash,
        revision:
          next.revision,
        savedAt:
          next.savedAt,
      }
    );
  }

  broadcast(
    payload,
    except = null
  ) {
    const data =
      typeof payload ===
      "string"
        ? payload
        : JSON.stringify(
            payload
          );

    for (
      const [other] of
        this.clients
    ) {
      if (
        other === except
      ) {
        continue;
      }

      try {
        other.send(data);
      } catch {
        this.removeClient(
          other
        );
      }
    }
  }

  sendRoomSnapshot(
    server
  ) {
    const players = [];

    for (
      const [ws, id] of
        this.clients
    ) {
      const state =
        this.states.get(id);

      if (state) {
        players.push(state);
      }
    }

    const party =
      this.getPartyForPlayer(
        this.clients.get(
          server
        )
      );

    const partyMembers =
      party
        ? [
            ...party.members,
          ]
        : [];

    try {
      server.send(
        JSON.stringify({
          type:
            "room_snapshot",
          hostId:
            this.hostId,
          players,
          partyId:
            party?.id ||
            "",
          partyLeaderId:
            party?.leaderId ||
            "",
          partyMembers,
          maxPartyMembers: 4,
        })
      );
    } catch {}
  }

  getPartyForPlayer(
    playerId
  ) {
    if (!playerId) {
      return null;
    }

    for (
      const [id, party] of
        this.parties
    ) {
      if (
        party.members.has(
          playerId
        )
      ) {
        return {
          id,
          ...party,
        };
      }
    }

    return null;
  }

  broadcastParty(
    partyId
  ) {
    const party =
      this.parties.get(
        partyId
      );

    if (!party) {
      return;
    }

    const payload = {
      type:
        "party_state",
      partyId,
      leaderId:
        party.leaderId,
      members: [
        ...party.members,
      ],
      maxMembers: 4,
    };

    for (
      const [ws, id] of
        this.clients
    ) {
      if (
        party.members.has(id)
      ) {
        try {
          ws.send(
            JSON.stringify(
              payload
            )
          );
        } catch {
          this.removeClient(
            ws
          );
        }
      }
    }
  }

  leaveParty(
    playerId
  ) {
    const party =
      this.getPartyForPlayer(
        playerId
      );

    if (!party) {
      return;
    }

    const set =
      this.parties.get(
        party.id
      );

    if (!set) {
      return;
    }

    set.members.delete(
      playerId
    );

    if (
      !set.members.size
    ) {
      this.parties.delete(
        party.id
      );
    } else {
      if (
        set.leaderId ===
        playerId
      ) {
        set.leaderId =
          [...set.members][0];
      }

      this.broadcastParty(
        party.id
      );
    }
  }

  removeClient(
    server
  ) {
    const id =
      this.clients.get(
        server
      );

    if (!id) {
      return;
    }

    this.leaveParty(id);

    this.states.delete(id);

    this.lastMessageAt.delete(
      id
    );

    const wasHost =
      id === this.hostId;

    this.clients.delete(
      server
    );

    if (wasHost) {
      const next =
        this.clients
          .values()
          .next();

      this.hostId =
        next.done
          ? ""
          : next.value;
    }

    this.broadcast({
      type:
        "player_left",
      id,
      players:
        this.clients.size,
      maxPlayers:
        MAX_PLAYERS_PER_ROOM,
      hostId:
        this.hostId,
    });

    const hostState =
      this.states.get(
        this.hostId
      );

    updateActiveRoom(
      this.roomCode,
      this.clients.size,
      hostState?.name ||
        ""
    );
  }

  async fetch(
    request
  ) {
    const requestUrl =
      new URL(
        request.url
      );

    const saveMatch =
      requestUrl.pathname.match(
        /^\/save\/([^/]+)$/
      );

    if (saveMatch) {
      return this.handleSaveRequest(
        request
      );
    }

    const roomMatch =
      requestUrl.pathname.match(
        /^\/room\/([^/]+)$/
      );

    this.roomCode =
      roomMatch
        ? decodeURIComponent(
            roomMatch[1]
          )
        : this.roomCode;

    if (
      request.headers.get(
        "Upgrade"
      ) !== "websocket"
    ) {
      return new Response(
        "WebSocket only",
        {
          status: 426,
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
          status: 409,
        }
      );
    }

    const pair =
      new WebSocketPair();

    const [
      client,
      server,
    ] =
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

    server.send(
      JSON.stringify({
        type:
          "connected",
        players:
          this.clients.size,
        maxPlayers:
          MAX_PLAYERS_PER_ROOM,
        id:
          connectionId,
        hostId:
          this.hostId,
      })
    );

    this.sendRoomSnapshot(
      server
    );

    this.broadcast(
      {
        type:
          "player_joined",
        id:
          connectionId,
        players:
          this.clients.size,
        maxPlayers:
          MAX_PLAYERS_PER_ROOM,
        hostId:
          this.hostId,
      },
      server
    );

    server.addEventListener(
      "message",
      event => {
        const id =
          this.clients.get(
            server
          );

        if (!id) {
          return;
        }

        const now =
          Date.now();

        const last =
          this.lastMessageAt.get(
            id
          ) || 0;

        if (
          now - last <
          15
        ) {
          return;
        }

        this.lastMessageAt.set(
          id,
          now
        );

        let msg;

        try {
          msg =
            JSON.parse(
              event.data
            );
        } catch {
          return;
        }

        if (
          !msg ||
          typeof msg !==
            "object"
        ) {
          return;
        }

        if (
          msg.type ===
          "state"
        ) {
          msg.id =
            id;

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

          msg.hp =
            Math.max(
              0,
              Math.min(
                100000000,
                Number(
                  msg.hp
                ) || 0
              )
            );

          msg.maxHp =
            Math.max(
              1,
              Math.min(
                100000000,
                Number(
                  msg.maxHp
                ) || 1
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
            hostState?.name ||
              ""
          );

          this.broadcast(
            msg,
            server
          );

          return;
        }

        if (
          msg.type ===
          "chat"
        ) {
          const text =
            String(
              msg.text ||
                ""
            )
              .trim()
              .slice(
                0,
                120
              );

          if (!text) {
            return;
          }

          const state =
            this.states.get(
              id
            );

          this.broadcast({
            type:
              "chat",
            id,
            name:
              String(
                state?.name ||
                  "플레이어"
              ).slice(
                0,
                16
              ),
            text,
            ts:
              now,
          });

          return;
        }

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
              id:
                partyId,
              leaderId:
                id,
              members:
                new Set([id]),
            };

            this.parties.set(
              partyId,
              record
            );

            party = {
              id:
                partyId,
              ...record,
            };
          } else if (
            party.members.size <
            4
          ) {
            const record =
              this.parties.get(
                party.id
              );

            record.members.add(
              id
            );

            party = {
              id:
                party.id,
              ...record,
            };
          }

          this.broadcastParty(
            party.id
          );

          return;
        }

        if (
          msg.type ===
          "party_leave"
        ) {
          const party =
            this.getPartyForPlayer(
              id
            );

          if (party) {
            this.leaveParty(
              id
            );
          }

          return;
        }

        msg.senderId =
          id;

        this.broadcast(
          msg,
          server
        );
      }
    );

    const remove =
      () =>
        this.removeClient(
          server
        );

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
        webSocket:
          client,
      }
    );
  }
}
