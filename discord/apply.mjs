#!/usr/bin/env node
/**
 * Apply discord/layout.json to a Discord guild.
 *
 * Idempotent: every object is matched by name, then created or patched. Safe to
 * re-run after editing the layout. Never deletes anything it did not find in
 * the layout -- removing a channel from the layout leaves it alone on the
 * server, so you delete by hand and stay in control.
 *
 * Usage:
 *   node discord/apply.mjs --guild <id> --token-file <path>            # dry run
 *   node discord/apply.mjs --guild <id> --token-file <path> --apply    # write
 *
 * The token may also come from $DISCORD_TOKEN. It is never logged.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const API = "https://discord.com/api/v10";
const ROOT = path.resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------- permissions

const PERMS = {
  CREATE_INSTANT_INVITE: 0n,
  KICK_MEMBERS: 1n,
  BAN_MEMBERS: 2n,
  ADMINISTRATOR: 3n,
  MANAGE_CHANNELS: 4n,
  MANAGE_GUILD: 5n,
  ADD_REACTIONS: 6n,
  VIEW_AUDIT_LOG: 7n,
  PRIORITY_SPEAKER: 8n,
  STREAM: 9n,
  VIEW_CHANNEL: 10n,
  SEND_MESSAGES: 11n,
  SEND_TTS_MESSAGES: 12n,
  MANAGE_MESSAGES: 13n,
  EMBED_LINKS: 14n,
  ATTACH_FILES: 15n,
  READ_MESSAGE_HISTORY: 16n,
  MENTION_EVERYONE: 17n,
  USE_EXTERNAL_EMOJIS: 18n,
  VIEW_GUILD_INSIGHTS: 19n,
  CONNECT: 20n,
  SPEAK: 21n,
  MUTE_MEMBERS: 22n,
  DEAFEN_MEMBERS: 23n,
  MOVE_MEMBERS: 24n,
  USE_VAD: 25n,
  CHANGE_NICKNAME: 26n,
  MANAGE_NICKNAMES: 27n,
  MANAGE_ROLES: 28n,
  MANAGE_WEBHOOKS: 29n,
  MANAGE_GUILD_EXPRESSIONS: 30n,
  USE_APPLICATION_COMMANDS: 31n,
  REQUEST_TO_SPEAK: 32n,
  MANAGE_EVENTS: 33n,
  MANAGE_THREADS: 34n,
  CREATE_PUBLIC_THREADS: 35n,
  CREATE_PRIVATE_THREADS: 36n,
  USE_EXTERNAL_STICKERS: 37n,
  SEND_MESSAGES_IN_THREADS: 38n,
  USE_EMBEDDED_ACTIVITIES: 39n,
  MODERATE_MEMBERS: 40n,
};

function bits(names = []) {
  let mask = 0n;
  for (const n of names) {
    const shift = PERMS[n];
    if (shift === undefined) throw new Error(`Unknown permission: ${n}`);
    mask |= 1n << shift;
  }
  return mask;
}

const CHANNEL_TYPES = { text: 0, voice: 2, category: 4, announcement: 5, stage: 13, forum: 15 };
const AUTOMOD_PRESETS = { PROFANITY: 1, SEXUAL_CONTENT: 2, SLURS: 3 };

// ------------------------------------------------------------------- CLI / IO

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const APPLY = argv.includes("--apply");
const GUILD = flag("guild") ?? process.env.DISCORD_GUILD_ID;

let TOKEN = process.env.DISCORD_TOKEN;
const tokenFile = flag("token-file");
if (tokenFile) TOKEN = (await readFile(tokenFile, "utf8")).trim();

if (!GUILD) fail("Missing --guild <id> (or $DISCORD_GUILD_ID).");
if (!TOKEN) fail("Missing --token-file <path> (or $DISCORD_TOKEN).");
if (!/^\d{17,20}$/.test(GUILD)) fail(`--guild must be a snowflake, got: ${GUILD}`);

function fail(msg) {
  console.error(`\n  error  ${msg}\n`);
  process.exit(1);
}

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  orange: (s) => `\x1b[38;5;208m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

let created = 0;
let patched = 0;
let skipped = 0;
const warnings = [];

const log = {
  step: (s) => console.log(`\n${C.orange("==")} ${C.bold(s)}`),
  create: (s) => {
    created++;
    console.log(`   ${C.green("+")} ${s}`);
  },
  patch: (s) => {
    patched++;
    console.log(`   ${C.yellow("~")} ${s}`);
  },
  same: (s) => {
    skipped++;
    console.log(`   ${C.dim("=")} ${C.dim(s)}`);
  },
  warn: (s) => {
    warnings.push(s);
    console.log(`   ${C.red("!")} ${s}`);
  },
  info: (s) => console.log(`   ${C.dim(s)}`),
};

// --------------------------------------------------------------- HTTP wrapper

async function api(method, route, body, { retries = 5 } = {}) {
  if (!APPLY && method !== "GET") {
    return { __dryRun: true, id: `dry-${Math.random().toString(36).slice(2, 10)}` };
  }
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${route}`, {
      method,
      headers: {
        Authorization: `Bot ${TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "DiscordBot (brokenfront-layout, 1.0)",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.status === 429 && attempt < retries) {
      const info = await res.json().catch(() => ({}));
      const wait = Math.ceil((info.retry_after ?? 1) * 1000) + 250;
      log.info(`rate limited, waiting ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (res.status >= 500 && attempt < retries) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new Error(`${method} ${route} -> ${res.status} ${text.slice(0, 500)}`);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : await res.json();
  }
}

// ------------------------------------------------------------------ preflight

const layout = JSON.parse(await readFile(path.join(ROOT, "discord/layout.json"), "utf8"));

console.log(
  `\n${C.bold("BrokenFront server layout")}  ${C.dim(
    APPLY ? "mode: APPLY (writing)" : "mode: dry run (no writes)",
  )}`,
);

const me = await api("GET", "/users/@me");
const guild = await api("GET", `/guilds/${GUILD}?with_counts=true`);
log.info(`bot ${me.username} -> guild "${guild.name}" (${guild.approximate_member_count ?? "?"} members)`);

const botMember = await api("GET", `/guilds/${GUILD}/members/${me.id}`);
let existingRoles = await api("GET", `/guilds/${GUILD}/roles`);

const botTopPosition = Math.max(
  0,
  ...existingRoles.filter((r) => botMember.roles.includes(r.id)).map((r) => r.position),
);

const managedRoles = layout.roles.length;

// POST /roles creates every new role at position 1 and does NOT push existing
// roles up, so they all end up tied at 1 and ordered by id. Sorting them into
// 1..N afterwards needs the bot's own role to sit strictly above all of them,
// and a bot cannot raise its own role -- only a human can drag it up.
if (botTopPosition <= managedRoles) {
  log.warn(
    `${me.username}'s highest role is at position ${botTopPosition}, but ordering ${managedRoles} roles ` +
      `beneath it needs position ${managedRoles + 1} or higher. Drag "${me.username}" to the top of ` +
      `Server Settings -> Roles, then re-run: roles will still be created, but left unordered.`,
  );
}

const hasCommunity = (guild.features ?? []).includes("COMMUNITY");
if (!hasCommunity) {
  log.warn(
    "Community is not enabled on this guild. Forum channels, announcement channels, Onboarding and " +
      "the AutoMod preset filter will be skipped. Enable it in Server Settings -> Community.",
  );
}

// ---------------------------------------------------------------------- roles

log.step("Roles");

const roleIds = new Map(); // layout name -> id
roleIds.set("@everyone", GUILD);

for (const spec of layout.roles) {
  const wanted = {
    name: spec.name,
    permissions: bits(spec.divider ? [] : spec.permissions).toString(),
    color: spec.color ? parseInt(spec.color.slice(1), 16) : 0,
    hoist: spec.divider ? true : Boolean(spec.hoist),
    mentionable: spec.divider ? false : Boolean(spec.mentionable),
  };

  const found = existingRoles.find((r) => r.name === spec.name && !r.managed);
  if (!found) {
    const made = await api("POST", `/guilds/${GUILD}/roles`, wanted);
    roleIds.set(spec.name, made.id);
    log.create(`role ${spec.name}`);
    continue;
  }

  roleIds.set(spec.name, found.id);
  const drifted =
    found.permissions !== wanted.permissions ||
    found.color !== wanted.color ||
    found.hoist !== wanted.hoist ||
    found.mentionable !== wanted.mentionable;

  if (drifted) {
    await api("PATCH", `/guilds/${GUILD}/roles/${found.id}`, wanted);
    log.patch(`role ${spec.name}`);
  } else {
    log.same(`role ${spec.name}`);
  }
}

// @everyone: allow-list wins, anything in deny is simply absent from the mask.
{
  const everyoneMask = bits(layout.everyone.allow) & ~bits(layout.everyone.deny);
  const current = existingRoles.find((r) => r.id === GUILD);
  if (!current || current.permissions !== everyoneMask.toString()) {
    await api("PATCH", `/guilds/${GUILD}/roles/${GUILD}`, { permissions: everyoneMask.toString() });
    log.patch("role @everyone (base permissions)");
  } else {
    log.same("role @everyone");
  }
}

// Order top-to-bottom as written in the layout, all beneath the bot's own role.
// Re-read positions first: creating the roles above shifted everything.
if (APPLY) {
  const afterCreate = await api("GET", `/guilds/${GUILD}/roles`);
  const botTop = Math.max(
    0,
    ...afterCreate.filter((r) => botMember.roles.includes(r.id)).map((r) => r.position),
  );

  if (botTop > managedRoles) {
    const positions = layout.roles.map((spec, i) => ({
      id: roleIds.get(spec.name),
      position: botTop - 1 - i,
    }));
    await api("PATCH", `/guilds/${GUILD}/roles`, positions);
    log.info(`ordered ${positions.length} roles beneath ${me.username} (position ${botTop})`);
  } else {
    log.warn(
      `could not order roles: ${me.username} sits at position ${botTop}, which leaves no room for ` +
        `${managedRoles} roles beneath it. Roles exist but their order will look wrong.`,
    );
  }
}

existingRoles = await api("GET", `/guilds/${GUILD}/roles`);

// ----------------------------------------------------------------- overwrites

const STAFF = ["Founder", "Admin", "Moderator"];

function overwritesFor(preset) {
  if (!preset) return [];
  const ow = [];
  const add = (roleName, allow, deny) => {
    const id = roleIds.get(roleName);
    if (!id) return;
    ow.push({ id, type: 0, allow: bits(allow).toString(), deny: bits(deny).toString() });
  };

  if (preset === "readonly") {
    add(
      "@everyone",
      ["VIEW_CHANNEL", "READ_MESSAGE_HISTORY", "ADD_REACTIONS"],
      ["SEND_MESSAGES", "CREATE_PUBLIC_THREADS", "SEND_MESSAGES_IN_THREADS"],
    );
    for (const r of STAFF) add(r, ["VIEW_CHANNEL", "SEND_MESSAGES", "READ_MESSAGE_HISTORY"], []);
  } else if (preset === "staff-only") {
    add("@everyone", [], ["VIEW_CHANNEL"]);
    for (const r of STAFF) {
      add(r, ["VIEW_CHANNEL", "SEND_MESSAGES", "READ_MESSAGE_HISTORY", "ATTACH_FILES", "EMBED_LINKS"], []);
    }
  } else if (preset === "staff-readonly") {
    add("@everyone", [], ["VIEW_CHANNEL"]);
    for (const r of STAFF) add(r, ["VIEW_CHANNEL", "READ_MESSAGE_HISTORY"], ["SEND_MESSAGES"]);
  } else {
    throw new Error(`Unknown preset: ${preset}`);
  }
  return ow;
}

function sameOverwrites(a = [], b = []) {
  const key = (o) => `${o.id}:${o.type}:${o.allow}:${o.deny}`;
  const norm = (list) =>
    list
      .filter((o) => o.allow !== "0" || o.deny !== "0")
      .map(key)
      .sort()
      .join("|");
  return norm(a) === norm(b);
}

// ------------------------------------------------------------------- channels

log.step("Categories and channels");

let existingChannels = await api("GET", `/guilds/${GUILD}/channels`);
const channelIds = new Map(); // layout key -> id
const categoryIds = []; // in layout order, for the final reorder pass

let categoryPosition = 0;
for (const cat of layout.categories) {
  const catOverwrites = overwritesFor(cat.preset);
  let catId;
  const foundCat = existingChannels.find((c) => c.type === 4 && c.name === cat.name);

  if (!foundCat) {
    const made = await api("POST", `/guilds/${GUILD}/channels`, {
      name: cat.name,
      type: 4,
      position: categoryPosition,
      permission_overwrites: catOverwrites,
    });
    catId = made.id;
    log.create(`category ${cat.name}`);
  } else {
    catId = foundCat.id;
    if (!sameOverwrites(foundCat.permission_overwrites, catOverwrites)) {
      await api("PATCH", `/channels/${catId}`, { permission_overwrites: catOverwrites });
      log.patch(`category ${cat.name} (permissions)`);
    } else {
      log.same(`category ${cat.name}`);
    }
  }
  categoryPosition++;
  categoryIds.push(catId);

  let childPosition = 0;
  for (const ch of cat.channels) {
    const type = CHANNEL_TYPES[ch.type];
    if (type === undefined) throw new Error(`Unknown channel type: ${ch.type}`);

    // Forum, announcement and stage channels all require a Community guild.
    if (!hasCommunity && (type === 15 || type === 5 || type === 13)) {
      log.warn(`skipped ${ch.name} (${ch.type} channels need Community enabled)`);
      continue;
    }

    // No preset means no own overwrites, so the channel inherits its category's.
    const ow = ch.preset ? overwritesFor(ch.preset) : [];

    const body = {
      name: ch.name,
      type,
      parent_id: catId,
      position: childPosition++,
    };
    if (ch.topic && type !== 2 && type !== 13) body.topic = ch.topic;
    if (ch.slowmode) body.rate_limit_per_user = ch.slowmode;
    if (ow.length) body.permission_overwrites = ow;
    if (type === 15 && ch.tags) {
      body.available_tags = ch.tags.map((name) => ({ name, moderated: false }));
    }

    const found = existingChannels.find((c) => c.name === ch.name && c.type === type);
    if (!found) {
      const made = await api("POST", `/guilds/${GUILD}/channels`, body);
      channelIds.set(ch.key, made.id);
      log.create(`${ch.type === "voice" || ch.type === "stage" ? "" : "#"}${ch.name}`);
    } else {
      channelIds.set(ch.key, found.id);
      const patch = {};
      if (found.parent_id !== catId) patch.parent_id = catId;
      if (body.topic !== undefined && found.topic !== body.topic) patch.topic = body.topic;
      if (body.rate_limit_per_user !== undefined && found.rate_limit_per_user !== body.rate_limit_per_user) {
        patch.rate_limit_per_user = body.rate_limit_per_user;
      }
      if (ow.length && !sameOverwrites(found.permission_overwrites, ow)) {
        patch.permission_overwrites = ow;
      }
      if (Object.keys(patch).length) {
        await api("PATCH", `/channels/${found.id}`, patch);
        log.patch(`#${ch.name} (${Object.keys(patch).join(", ")})`);
      } else {
        log.same(`#${ch.name}`);
      }
    }
  }
}

// Pre-existing categories hold positions 0..n, so freshly created ones land
// interleaved with them. One bulk reorder puts the layout's categories in the
// order they are written, which is what makes the sidebar look deliberate.
if (APPLY && categoryIds.length) {
  await api(
    "PATCH",
    `/guilds/${GUILD}/channels`,
    categoryIds.map((id, i) => ({ id, position: i })),
  );
  log.info(`ordered ${categoryIds.length} categories`);
}

existingChannels = await api("GET", `/guilds/${GUILD}/channels`);
const resolveChannel = (key) => channelIds.get(key);

// --------------------------------------------------------------- guild config

log.step("Server identity");

{
  const patch = {};
  if (layout.guild.description && guild.description !== layout.guild.description) {
    patch.description = layout.guild.description;
  }

  const iconPng = path.join(ROOT, "discord/brand/icon-512.png");
  if (!guild.icon) {
    if (existsSync(iconPng)) {
      const b64 = (await readFile(iconPng)).toString("base64");
      patch.icon = `data:image/png;base64,${b64}`;
    } else {
      log.warn("no server icon set, and discord/brand/icon-512.png is missing (run rasterize.mjs first)");
    }
  }

  for (const [field, key] of [
    ["system_channel_id", layout.guild.systemChannel],
    ["rules_channel_id", layout.guild.rulesChannel],
    ["public_updates_channel_id", layout.guild.publicUpdatesChannel],
  ]) {
    const id = resolveChannel(key);
    // rules_channel_id and public_updates_channel_id only apply to Community guilds.
    if (!id) continue;
    if (!hasCommunity && field !== "system_channel_id") continue;
    if (guild[field] !== id) patch[field] = id;
  }

  if (Object.keys(patch).length) {
    await api("PATCH", `/guilds/${GUILD}`, patch);
    log.patch(`guild (${Object.keys(patch).join(", ")})`);
  } else {
    log.same("guild identity");
  }
}

// -------------------------------------------------------------------- automod

log.step("AutoMod");

{
  const existing = hasCommunity ? await api("GET", `/guilds/${GUILD}/auto-moderation/rules`) : [];

  for (const rule of layout.automod) {
    if (!hasCommunity) {
      log.warn(`skipped AutoMod "${rule.name}" (needs Community)`);
      continue;
    }
    if (existing.some((r) => r.name === rule.name)) {
      log.same(`automod ${rule.name}`);
      continue;
    }

    let trigger_type;
    let trigger_metadata = {};
    if (rule.trigger === "keyword") {
      trigger_type = 1;
      trigger_metadata = { keyword_filter: rule.patterns, regex_patterns: [], allow_list: [] };
    } else if (rule.trigger === "spam") {
      trigger_type = 3;
    } else if (rule.trigger === "preset") {
      trigger_type = 4;
      trigger_metadata = { presets: rule.presets.map((p) => AUTOMOD_PRESETS[p]), allow_list: [] };
    } else if (rule.trigger === "mention_spam") {
      trigger_type = 5;
      trigger_metadata = { mention_total_limit: rule.mentionLimit };
    } else {
      throw new Error(`Unknown automod trigger: ${rule.trigger}`);
    }

    const actions = [{ type: 1, metadata: {} }];
    const logChannel = resolveChannel(rule.logTo);
    if (logChannel) actions.push({ type: 2, metadata: { channel_id: logChannel } });

    try {
      await api("POST", `/guilds/${GUILD}/auto-moderation/rules`, {
        name: rule.name,
        event_type: 1,
        trigger_type,
        trigger_metadata,
        actions,
        enabled: true,
        exempt_roles: (rule.exemptRoles ?? []).map((n) => roleIds.get(n)).filter(Boolean),
        exempt_channels: [],
      });
      log.create(`automod ${rule.name}`);
    } catch (e) {
      log.warn(`automod "${rule.name}" failed: ${e.message}`);
    }
  }
}

// ----------------------------------------------------------------- onboarding

log.step("Onboarding");

if (!hasCommunity) {
  log.warn("skipped Onboarding (needs Community)");
} else {
  let nextId = 1;
  const prompts = layout.onboarding.prompts.map((p) => ({
    id: String(nextId++),
    type: 0,
    title: p.title,
    single_select: !p.multiple,
    required: false,
    in_onboarding: true,
    options: p.options.map((o) => ({
      id: String(nextId++),
      title: o.label,
      description: o.description ?? null,
      role_ids: (o.roles ?? []).map((n) => roleIds.get(n)).filter(Boolean),
      channel_ids: (o.channels ?? []).map(resolveChannel).filter(Boolean),
    })),
  }));

  const defaults = layout.onboarding.defaultChannels.map(resolveChannel).filter(Boolean);
  try {
    await api("PUT", `/guilds/${GUILD}/onboarding`, {
      prompts,
      default_channel_ids: defaults,
      enabled: true,
      mode: 0,
    });
    log.create(`onboarding (${prompts.length} prompts, ${defaults.length} default channels)`);
  } catch (e) {
    log.warn(
      `onboarding failed: ${e.message}. Discord requires at least 7 default channels, ` +
        `5 of which @everyone can post in.`,
    );
  }
}

// ------------------------------------------------------------------- webhooks

log.step("Webhooks");

{
  const wanted = layout.categories
    .flatMap((c) => c.channels)
    .filter((ch) => ch.webhook && resolveChannel(ch.key));

  for (const ch of wanted) {
    const id = resolveChannel(ch.key);
    // GET is always real, even in a dry run, so this reports accurately.
    const existing = id.startsWith("dry-") ? [] : await api("GET", `/channels/${id}/webhooks`);
    if (existing.some((w) => w.name === ch.webhook)) {
      log.same(`webhook ${ch.webhook} in #${ch.name}`);
      continue;
    }
    const made = await api("POST", `/channels/${id}/webhooks`, { name: ch.webhook });
    log.create(`webhook ${ch.webhook} in #${ch.name}`);
    if (made?.url) {
      console.log(`      ${C.dim("url (treat as a secret, not printed again):")} ${made.url}`);
    }
  }
}

// --------------------------------------------------------------------- report

console.log(
  `\n${C.bold("Done.")} ${C.green(`${created} created`)}  ${C.yellow(`${patched} updated`)}  ${C.dim(
    `${skipped} already correct`,
  )}`,
);
if (warnings.length) {
  console.log(`\n${C.red(`${warnings.length} warning(s):`)}`);
  for (const w of warnings) console.log(`  - ${w}`);
}
if (!APPLY) {
  console.log(`\n${C.dim("This was a dry run. Re-run with --apply to write these changes.")}`);
}
console.log();
