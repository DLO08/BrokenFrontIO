#!/usr/bin/env node
/**
 * Fill in everything apply.mjs cannot express as structure:
 *   - the bot's avatar and application profile
 *   - the server Welcome Screen (the card shown on the invite)
 *   - the posts in #welcome
 *
 * The #welcome posts are rewritten rather than appended: the script deletes the
 * bot's own messages in that channel and posts fresh. Nobody else can post
 * there (it is a readonly preset), so there is nothing of anyone else's to lose.
 *
 * Usage:
 *   node discord/content.mjs --guild <id> --token-file <path>            # dry run
 *   node discord/content.mjs --guild <id> --token-file <path> --apply    # write
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

const API = "https://discord.com/api/v10";
const ROOT = path.resolve(import.meta.dirname, "..");
const BRAND = 0xe5602a;

const argv = process.argv.slice(2);
const flag = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? undefined : argv[i + 1];
};
const APPLY = argv.includes("--apply");
const GUILD = flag("guild") ?? process.env.DISCORD_GUILD_ID;
let TOKEN = process.env.DISCORD_TOKEN;
if (flag("token-file")) TOKEN = (await readFile(flag("token-file"), "utf8")).trim();
if (!GUILD || !TOKEN) {
  console.error("Need --guild <id> and --token-file <path>.");
  process.exit(1);
}

const H = { Authorization: `Bot ${TOKEN}`, "User-Agent": "DiscordBot (brokenfront-layout, 1.0)" };

async function api(method, route, body, { raw } = {}) {
  if (!APPLY && method !== "GET") {
    console.log(`   would ${method} ${route}`);
    return { id: "dry" };
  }
  for (let attempt = 0; ; attempt++) {
    const init = { method, headers: { ...H } };
    if (raw) {
      init.body = raw;
    } else if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${API}${route}`, init);
    if (res.status === 429 && attempt < 5) {
      const j = await res.json().catch(() => ({}));
      await new Promise((r) => setTimeout(r, Math.ceil((j.retry_after ?? 1) * 1000) + 250));
      continue;
    }
    if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${(await res.text()).slice(0, 400)}`);
    return res.status === 204 ? null : res.json();
  }
}

const ok = (s) => console.log(`   \x1b[32m+\x1b[0m ${s}`);
const step = (s) => console.log(`\n\x1b[38;5;208m==\x1b[0m \x1b[1m${s}\x1b[0m`);

console.log(`\n\x1b[1mBrokenFront content\x1b[0m  \x1b[2m${APPLY ? "mode: APPLY" : "mode: dry run"}\x1b[0m`);

const me = await api("GET", "/users/@me");
const channels = await api("GET", `/guilds/${GUILD}/channels`);
const roles = await api("GET", `/guilds/${GUILD}/roles`);
const ch = (name) => channels.find((c) => c.name === name);
const mention = (name) => (ch(name) ? `<#${ch(name).id}>` : `#${name}`);
const roleMention = (name) => {
  const r = roles.find((x) => x.name === name);
  return r ? `<@&${r.id}>` : `@${name}`;
};

// ------------------------------------------------------------- bot identity

step("Bot identity");
{
  const png = await readFile(path.join(ROOT, "discord/brand/icon-512.png"));
  const dataUri = `data:image/png;base64,${png.toString("base64")}`;

  if (!me.avatar) {
    await api("PATCH", "/users/@me", { avatar: dataUri });
    ok("bot avatar set");
  } else {
    console.log("   \x1b[2m= bot avatar already set\x1b[0m");
  }

  await api("PATCH", "/applications/@me", {
    description:
      "Keeps the BrokenFront server in shape: roles, channels, onboarding and release notes. " +
      "Configuration lives in the game repo, not in a dashboard.",
    icon: dataUri,
  });
  ok("application profile updated");
}

// ------------------------------------------------------------ welcome screen

step("Welcome screen");
{
  const pick = [
    ["welcome", "Rules and how this place works", "📜"],
    ["looking-for-game", "Find people to play with", "⚔️"],
    ["bug-reports", "Something broken? Tell us here", "🐛"],
    ["suggestions", "Ideas for the game", "💡"],
    ["dev-chat", "Engine, client and server talk", "🔧"],
  ]
    .filter(([n]) => ch(n))
    .map(([n, description, emoji_name]) => ({ channel_id: ch(n).id, description, emoji_name }));

  await api("PATCH", `/guilds/${GUILD}/welcome-screen`, {
    enabled: true,
    description: "Real-time multiplayer territorial strategy. Claim ground, hold it, lose it badly.",
    welcome_channels: pick,
  });
  ok(`welcome screen enabled with ${pick.length} channels`);
}

// -------------------------------------------------------------- #welcome posts

step("#welcome posts");

const welcome = ch("welcome");
if (!welcome) {
  console.error("   no #welcome channel found -- run apply.mjs first");
  process.exit(1);
}

// Clear the bot's own previous posts so re-running does not stack duplicates.
{
  const existing = await api("GET", `/channels/${welcome.id}/messages?limit=100`);
  const mine = existing.filter((m) => m.author.id === me.id);
  for (const m of mine) {
    await api("DELETE", `/channels/${welcome.id}/messages/${m.id}`);
  }
  if (mine.length) ok(`cleared ${mine.length} previous post(s)`);
}

const rulesEmbed = {
  color: BRAND,
  title: "Server rules",
  description: "Short list. Staff read intent, not loopholes.",
  fields: [
    {
      name: "1 — Be decent",
      value:
        "No harassment, hate speech, slurs, or personal attacks. Argue about strategy as much as you like; keep it about the game.",
    },
    {
      name: "2 — Keep it safe for work",
      value: "No NSFW, gore, or shock content — in messages, avatars, or nicknames.",
    },
    {
      name: "3 — No spam or advertising",
      value:
        "Including unsolicited DMs to members. Sharing your own project is fine in the channel it belongs in; ask staff if you are unsure.",
    },
    {
      name: "4 — Play fair",
      value: `Do not share or promote cheats, scripts, or exploits. Found something broken? Report it in ${mention("bug-reports")} instead of using it.`,
    },
    {
      name: "5 — Use the right channel",
      value: `Topics have homes. ${mention("bug-reports")} and ${mention("suggestions")} are forums — one thread per issue, and search before posting.`,
    },
    {
      name: "6 — English in main channels",
      value: "So moderation can actually work. Other languages are welcome in voice and DMs.",
    },
    {
      name: "7 — Staff decisions stand",
      value: `Disagree in ${mention("appeals")}, not in public. Arguing with moderation in channel is its own problem.`,
    },
    {
      name: "8 — Follow Discord's rules",
      value:
        "[Terms of Service](https://discord.com/terms) and [Community Guidelines](https://discord.com/guidelines) apply, including being 13 or older.",
    },
  ],
  footer: { text: "Enforcement scales with severity: warning → timeout → kick → ban." },
};

const guideEmbed = {
  color: BRAND,
  title: "Where to go",
  fields: [
    {
      name: "Pick up your roles",
      value:
        "Open **Channels & Roles** at the top of the channel list to choose what you get pinged for and set your region. " +
        `Region roles (${roleMention("NA")}, ${roleMention("EU")}, ${roleMention("APAC")}, ${roleMention("LATAM")}) are how people find games at sensible hours.`,
    },
    {
      name: "Play",
      value: `${mention("looking-for-game")} to find opponents · ${mention("tournaments")} for brackets · ${mention("clan-recruitment")} to find a team`,
    },
    {
      name: "Talk",
      value: `${mention("general")} for anything on-topic · ${mention("strategy")} for openings and build orders · ${mention("clips-and-screenshots")} for your best and worst moments`,
    },
    {
      name: "Help build it",
      value: `${mention("bug-reports")} · ${mention("suggestions")} · ${mention("map-showcase")} for maps · ${mention("dev-chat")} for engine and client work · ${mention("translations")} to localise`,
    },
    {
      name: "Need a human?",
      value: `Ping ${roleMention("Moderator")}, or open ${mention("reports")} if it is about another member.`,
    },
  ],
};

// First post carries the key art, so it needs multipart.
{
  const art = await readFile(path.join(ROOT, "resources/images/BrokenFrontKeyArt.png"));
  const welcomeEmbed = {
    color: BRAND,
    title: "Welcome to BrokenFront",
    description:
      "Real-time multiplayer territorial strategy. Claim ground, build an economy, hold a border, " +
      "and find out how quickly an alliance stops being one.\n\n" +
      "This server is where the game gets played, argued about, and built. Read the rules below, " +
      "pick your roles, and jump in.",
    image: { url: "attachment://keyart.png" },
  };

  if (APPLY) {
    const form = new FormData();
    form.append("payload_json", JSON.stringify({ embeds: [welcomeEmbed] }));
    form.append("files[0]", new Blob([art], { type: "image/png" }), "keyart.png");
    await api("POST", `/channels/${welcome.id}/messages`, undefined, { raw: form });
  }
  ok("posted welcome + key art");
}

await api("POST", `/channels/${welcome.id}/messages`, { embeds: [rulesEmbed] });
ok("posted rules");

await api("POST", `/channels/${welcome.id}/messages`, { embeds: [guideEmbed] });
ok("posted channel guide");

console.log(`\n\x1b[1mDone.\x1b[0m${APPLY ? "" : "  \x1b[2m(dry run — re-run with --apply)\x1b[0m"}\n`);
