#!/usr/bin/env node
/**
 * Keep BrokenBot showing as online.
 *
 * A bot is "online" only while it holds an open WebSocket to Discord's gateway.
 * There is no API call or dashboard toggle for it -- the green dot IS the
 * connection. So this is a long-running process: the bot appears online when it
 * starts and goes offline within ~45s of it stopping.
 *
 * It requests zero intents, so it receives no message content and no member
 * data. It exists purely to hold the socket open and publish a presence.
 *
 * Usage:
 *   node discord/presence.mjs --token-file <path>
 *   node discord/presence.mjs --token-file <path> --status idle --activity "the front lines" --type watching
 *
 * Run it under a supervisor (systemd, pm2, Docker restart policy) if you want
 * the dot to stay green. See README.
 */

import { readFile } from "node:fs/promises";

const argv = process.argv.slice(2);
const flag = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? undefined : argv[i + 1];
};

let TOKEN = process.env.DISCORD_TOKEN;
if (flag("token-file")) TOKEN = (await readFile(flag("token-file"), "utf8")).trim();
if (!TOKEN) {
  console.error("Need --token-file <path> or $DISCORD_TOKEN.");
  process.exit(1);
}

const ACTIVITY_TYPES = { playing: 0, streaming: 1, listening: 2, watching: 3, competing: 5 };
const STATUS = flag("status") ?? "online"; // online | idle | dnd | invisible
const ACTIVITY_NAME = flag("activity") ?? "BrokenFront";
const ACTIVITY_TYPE = ACTIVITY_TYPES[(flag("type") ?? "playing").toLowerCase()] ?? 0;

const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
};

const presence = () => ({
  since: null,
  activities: [{ name: ACTIVITY_NAME, type: ACTIVITY_TYPE }],
  status: STATUS,
  afk: false,
});

let ws = null;
let heartbeatTimer = null;
let sequence = null;
let sessionId = null;
let resumeUrl = null;
let acked = true;
let backoff = 1000;
let stopping = false;

const log = (s) => console.log(`[${new Date().toISOString()}] ${s}`);

function clearHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function send(op, d) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ op, d }));
}

function connect() {
  if (stopping) return;
  const url = resumeUrl ?? "wss://gateway.discord.gg";
  ws = new WebSocket(`${url}/?v=10&encoding=json`);

  ws.addEventListener("open", () => log(`socket open (${resumeUrl ? "resuming" : "fresh"})`));

  ws.addEventListener("message", (event) => {
    const { op, d, s, t } = JSON.parse(event.data);
    if (s !== null && s !== undefined) sequence = s;

    if (op === OP.HELLO) {
      clearHeartbeat();
      acked = true;
      const interval = d.heartbeat_interval;

      // First beat is jittered, per the gateway docs, to avoid thundering herds.
      setTimeout(() => {
        send(OP.HEARTBEAT, sequence);
        heartbeatTimer = setInterval(() => {
          if (!acked) {
            log("no heartbeat ack -- zombie connection, reconnecting");
            ws.close(4000);
            return;
          }
          acked = false;
          send(OP.HEARTBEAT, sequence);
        }, interval);
      }, interval * Math.random());

      if (sessionId && resumeUrl) {
        send(OP.RESUME, { token: TOKEN, session_id: sessionId, seq: sequence });
      } else {
        send(OP.IDENTIFY, {
          token: TOKEN,
          intents: 0,
          properties: { os: process.platform, browser: "brokenfront-presence", device: "brokenfront-presence" },
          presence: presence(),
        });
      }
    } else if (op === OP.HEARTBEAT) {
      send(OP.HEARTBEAT, sequence);
    } else if (op === OP.HEARTBEAT_ACK) {
      acked = true;
    } else if (op === OP.RECONNECT) {
      log("gateway asked us to reconnect");
      ws.close(4000);
    } else if (op === OP.INVALID_SESSION) {
      log(`session invalid (resumable: ${d})`);
      if (!d) {
        sessionId = null;
        resumeUrl = null;
      }
      ws.close(4000);
    } else if (op === OP.DISPATCH) {
      if (t === "READY") {
        sessionId = d.session_id;
        resumeUrl = d.resume_gateway_url;
        backoff = 1000;
        const verb = Object.entries(ACTIVITY_TYPES).find(([, v]) => v === ACTIVITY_TYPE)?.[0];
        log(`online as ${d.user.username} -- ${verb} "${ACTIVITY_NAME}" (${STATUS})`);
      } else if (t === "RESUMED") {
        backoff = 1000;
        log("resumed");
      }
    }
  });

  ws.addEventListener("error", (e) => log(`socket error: ${e.message ?? "unknown"}`));

  ws.addEventListener("close", (e) => {
    clearHeartbeat();
    log(`socket closed (${e.code})`);

    // These mean the problem is us, not the network. Retrying will not help.
    const fatal = { 4004: "bad token", 4010: "bad shard", 4011: "sharding required", 4012: "bad api version", 4013: "bad intents", 4014: "disallowed intents" };
    if (fatal[e.code]) {
      log(`fatal: ${fatal[e.code]}`);
      process.exit(1);
    }
    if (stopping) return;

    // 4007/4009 mean the resume was rejected; start clean.
    if (e.code === 4007 || e.code === 4009) {
      sessionId = null;
      resumeUrl = null;
    }

    const wait = Math.min(backoff, 60000);
    log(`reconnecting in ${wait}ms`);
    setTimeout(connect, wait);
    backoff = Math.min(backoff * 2, 60000);
  });
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopping = true;
    clearHeartbeat();
    log("shutting down -- bot will show offline shortly");
    if (ws) ws.close(1000);
    process.exit(0);
  });
}

connect();
