import { Client, Events, Guild, GuildMember } from 'discord.js';
import { BskyAgent } from '@atproto/api';

// TS2460エラー（discord.jsのモジュール解決のバグ）を回避するため、インテントフラグを手動で定義します。
const GatewayIntentBits = {
  Guilds: 1 << 0,
  GuildMembers: 1 << 1,
  GuildMessages: 1 << 9,
  MessageContent: 1 << 15,
} as const;
import { db, subscribers, initializeDatabases } from '@bsky-affirmative-bot/database';
import { botLabelerManager, MemoryService } from '@bsky-affirmative-bot/clients';
import { eq } from 'drizzle-orm';
import { BADGE_DEF } from '@bsky-affirmative-bot/shared-configs';
import { assertExternalAccountAccessAllowed } from '@bsky-affirmative-bot/shared-configs/externalAccountAccess';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from project root
dotenv.config({ path: path.join(__dirname, '../../../.env') });
assertExternalAccountAccessAllowed('Discord bot', 'ALLOW_DEV_DISCORD_BOT', {
  NODE_ENV: process.env.NODE_ENV,
  ALLOW_DEV_DISCORD_BOT: process.env.ALLOW_DEV_DISCORD_BOT,
});

const DISCORD_TOKEN = process.env.DISCORD_TOKEN as string;
const GUILD_ID = process.env.DISCORD_GUILD_ID as string;
const ROLE_ID = process.env.DISCORD_ROLE_ID as string;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID as string;

if (!DISCORD_TOKEN || !GUILD_ID || !ROLE_ID || !CHANNEL_ID) {
  console.error("❌ [CRITICAL] Missing required Discord environment variables in .env!");
  console.error(`DISCORD_TOKEN: ${DISCORD_TOKEN ? 'Loaded' : 'Missing'}`);
  console.error(`DISCORD_GUILD_ID: ${GUILD_ID ? 'Loaded' : 'Missing'}`);
  console.error(`DISCORD_ROLE_ID: ${ROLE_ID ? 'Loaded' : 'Missing'}`);
  console.error(`DISCORD_CHANNEL_ID: ${CHANNEL_ID ? 'Loaded' : 'Missing'}`);
  process.exit(1);
}

// Checks if a member has the subscriber role and upgrades their status to 'active'.
// [WORKAROUND] Fanboxサブスクが先にROLEを付与された後に初回紐づけする場合、
// GuildMemberUpdateはもう発火しない。INSERTはdiscord_onlyで行うが、
// 直後にROLE保持を確認してactiveに昇格させる。
// 通常のstatus管理はGuildMemberUpdateが担う。
async function applyRoleStatusIfNeeded(member: GuildMember, did: string) {
  if (member.roles.cache.has(ROLE_ID)) {
    await db.update(subscribers)
      .set({ status: 'active', updated_at: new Date() })
      .where(eq(subscribers.did, did));
    console.log(`[INFO][DISCORD] Upgraded ${did} to active (has subscriber role)`);
  }
}

// Compares DB discord_id list with current guild members and deactivates missing members.
// Compensates for guildMemberRemove events missed while the bot was offline.
async function reconcileMembers(guild: Guild) {
  try {
    console.log("[INFO][DISCORD] Running member reconciliation...");
    const dbDiscordIds = await MemoryService.getDiscordLinkedSubscriberIds();
    if (dbDiscordIds.length === 0) return;

    const guildMembers = await guild.members.fetch();
    const guildMemberIds = new Set(guildMembers.keys());

    const missing = dbDiscordIds.filter(id => !guildMemberIds.has(id));
    if (missing.length === 0) {
      console.log("[INFO][DISCORD] Reconciliation: no missing members found.");
      return;
    }

    console.log(`[INFO][DISCORD] Reconciliation: ${missing.length} member(s) not in guild, deactivating...`);
    for (const discordId of missing) {
      const existing = await db.select().from(subscribers).where(eq(subscribers.discord_id, discordId)).limit(1);
      await db.update(subscribers)
        .set({ status: 'inactive', updated_at: new Date() })
        .where(eq(subscribers.discord_id, discordId));
      if (existing.length > 0 && existing[0].did) {
        try {
          await botLabelerManager.applyLabel(existing[0].did, BADGE_DEF.teamAffirmation, true);
        } catch (labelErr) {
          console.error(`[ERROR][DISCORD] Failed to negate label for ${existing[0].did}:`, labelErr);
        }
      }
      console.log(`[INFO][DISCORD] Reconciliation: deactivated Discord ID ${discordId}`);
    }
  } catch (err) {
    console.error("❌ [DISCORD] Error during member reconciliation:", err);
  }
}

async function startBot() {
  // 1. Initialize Database
  try {
    await initializeDatabases();
    console.log("✔ [DATABASE] Connected to PostgreSQL successfully.");
  } catch (err) {
    console.error("❌ [DATABASE] Failed to connect to database:", err);
    process.exit(1);
  }

  // 2. Initialize Discord Client
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  });

  // 3. Ready Event
  client.once(Events.ClientReady, (c) => {
    console.log(`✔ [DISCORD] Ready! Logged in as ${c.user.tag}`);
  });

  // 4. Role Sync on Member Update (guildMemberUpdate)
  // Status changes are managed here. Badge changes follow status changes.
  client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    if (newMember.guild.id !== GUILD_ID) return;

    const hadRole = oldMember.roles.cache.has(ROLE_ID);
    const hasRole = newMember.roles.cache.has(ROLE_ID);

    if (hadRole === hasRole) return;

    const discordId = newMember.user.id;
    const username = newMember.user.tag;

    try {
      if (hasRole) {
        // --- Role Added ---
        console.log(`[INFO][DISCORD] Subscriber role added to ${username} (${discordId})`);

        const existing = await db.select().from(subscribers).where(eq(subscribers.discord_id, discordId)).limit(1);
        if (existing.length === 0) {
          // No record yet — wait for the user to link their handle in the channel
          console.log(`[INFO][DISCORD] No linked record for ${username}. Waiting for channel registration.`);
          return;
        }

        await db.update(subscribers)
          .set({ status: 'active', updated_at: new Date() })
          .where(eq(subscribers.discord_id, discordId));
        console.log(`✔ [DISCORD] Set status=active for ${username}`);

        if (existing[0].did) {
          try {
            const activeDids = await botLabelerManager.getActiveLabels(BADGE_DEF.teamAffirmation);
            if (!activeDids.includes(existing[0].did)) {
              await botLabelerManager.applyLabel(existing[0].did, BADGE_DEF.teamAffirmation, false);
              console.log(`[INFO][DISCORD] Applied team-affirmation label to ${existing[0].did}`);
            }
          } catch (labelErr) {
            console.error(`[ERROR][DISCORD] Failed to apply label to ${existing[0].did}:`, labelErr);
          }
        }
      } else {
        // --- Role Removed ---
        console.log(`[INFO][DISCORD] Subscriber role removed from ${username} (${discordId})`);

        const existing = await db.select().from(subscribers).where(eq(subscribers.discord_id, discordId)).limit(1);
        await db.update(subscribers)
          .set({ status: 'inactive', updated_at: new Date() })
          .where(eq(subscribers.discord_id, discordId));
        console.log(`✔ [DISCORD] Set status=inactive for ${username}`);

        if (existing.length > 0 && existing[0].did) {
          try {
            await botLabelerManager.applyLabel(existing[0].did, BADGE_DEF.teamAffirmation, true);
            console.log(`[INFO][DISCORD] Negated team-affirmation label for ${existing[0].did}`);
          } catch (labelErr) {
            console.error(`[ERROR][DISCORD] Failed to negate label for ${existing[0].did}:`, labelErr);
          }
        }
      }
    } catch (err) {
      console.error(`❌ [DISCORD] Error processing role update for ${username}:`, err);
    }
  });

  // 5. Handle Linking on Message (messageCreate)
  // discord_id/did registration only. Status is managed by GuildMemberUpdate.
  client.on(Events.MessageCreate, async (message) => {
    try {
      if (message.channelId !== CHANNEL_ID || message.author.bot || message.system || !message.mentions.has(client.user!.id)) return;

      const member = message.member;
      if (!member) return;

      const discordId = message.author.id;
      const username = message.author.tag;

      // Parse handle from message content
      const rawText = message.content.replace(/<@!?\d+>/g, '').trim();
      const withoutUrls = rawText.replace(/https?:\/\/\S+/g, '').trim();
      const handleCandidate = withoutUrls.replace(/^@/, '').trim();
      const handleRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]*(\.[a-zA-Z0-9][a-zA-Z0-9-]*)+$/;

      if (!handleRegex.test(handleCandidate)) {
        await message.reply("❌ Please provide a valid Bluesky handle (e.g., `yourname.bsky.social`).");
        return;
      }

      const handle = handleCandidate.toLowerCase();
      console.log(`[INFO][DISCORD] Link request from ${username} for handle: ${handle}`);

      // Resolve Bluesky handle to DID
      const agent = new BskyAgent({ service: 'https://bsky.social' });
      let did: string;
      try {
        const response = await agent.resolveHandle({ handle });
        did = response.data.did;
        console.log(`✔ [DISCORD] Resolved handle ${handle} to DID: ${did}`);
      } catch (err: any) {
        console.error(`❌ [DISCORD] Failed to resolve handle @${handle}:`, err.message || err);
        await message.reply(`❌ Failed to resolve Bluesky account \`@${handle}\`. Please verify that your handle is spelled correctly.`);
        return;
      }

      try {
        const existingByDid = await db.select().from(subscribers).where(eq(subscribers.did, did)).limit(1);

        if (existingByDid.length > 0) {
          const record = existingByDid[0];

          if (record.status === 'active') {
            // Already active — just link discord_id
            await db.update(subscribers)
              .set({ discord_id: discordId, updated_at: new Date() })
              .where(eq(subscribers.did, did));
            console.log(`✔ [DISCORD] Linked discord_id to existing active record: ${did}`);
          } else {
            // inactive or discord_only — update discord_id and restore to discord_only
            // (GuildMemberUpdate will upgrade to active if they have the role)
            await db.update(subscribers)
              .set({ discord_id: discordId, status: 'discord_only', updated_at: new Date() })
              .where(eq(subscribers.did, did));
            console.log(`✔ [DISCORD] Re-linked ${did}, status restored to discord_only`);
          }
        } else {
          // DID not found — check if this Discord user already has a record (account migration)
          const existingByDiscord = await db.select().from(subscribers).where(eq(subscribers.discord_id, discordId)).limit(1);

          if (existingByDiscord.length > 0) {
            // Different Bluesky account — migrate
            const oldDid = existingByDiscord[0].did;
            await db.update(subscribers)
              .set({ did, updated_at: new Date() })
              .where(eq(subscribers.discord_id, discordId));
            console.log(`✔ [DISCORD] Migrated DID for ${username}: ${oldDid} → ${did}`);

            if (oldDid) {
              try {
                await botLabelerManager.applyLabel(oldDid, BADGE_DEF.teamAffirmation, true);
              } catch (labelErr) {
                console.error(`[ERROR][DISCORD] Failed to negate old label for ${oldDid}:`, labelErr);
              }
            }
          } else {
            // Completely new record
            await db.insert(subscribers).values({
              discord_id: discordId,
              did,
              status: 'discord_only',
              updated_at: new Date()
            });
            console.log(`✔ [DISCORD] Created new record: Discord ${discordId} ↔ DID ${did}`);

            // [WORKAROUND] 新規INSERTのみroleチェック。詳細は applyRoleStatusIfNeeded を参照。
            await applyRoleStatusIfNeeded(member, did);
          }
        }

        // Apply label instantly
        try {
          const activeDids = await botLabelerManager.getActiveLabels(BADGE_DEF.teamAffirmation);
          if (!activeDids.includes(did)) {
            await botLabelerManager.applyLabel(did, BADGE_DEF.teamAffirmation, false);
            console.log(`[INFO][DISCORD] Applied team-affirmation label to ${did}`);
          }
        } catch (labelErr) {
          console.error(`[ERROR][DISCORD] Failed to apply label to ${did}:`, labelErr);
        }

        await message.reply(`🎉 **Your Bluesky account has been successfully registered to the Bot-tan server!**\n\n*   **Registered Account**: \`@${handle}\`\n*   **DID**: \`${did}\`\n\n※ Your team-affirmation badge has been applied to your Bluesky profile instantly! Enjoy!`);

      } catch (err: any) {
        console.error(`❌ [DISCORD] Database error for handle @${handle}, user ${username}:`, err.message || err);
        if (err.code === '23505' || (err.message && err.message.includes('unique constraint'))) {
          await message.reply(`❌ The Bluesky account \`@${handle}\` is already registered under another record. If you believe this is an error, please contact an administrator.`);
        } else {
          await message.reply(`❌ An internal database/server error occurred while registering your account. Please try again later or contact an administrator.`);
        }
      }
    } catch (globalErr) {
      console.error("❌ [DISCORD] Error processing messageCreate event:", globalErr);
    }
  });

  // 6. Deactivate on Guild Leave (guildMemberRemove)
  client.on(Events.GuildMemberRemove, async (member) => {
    if (member.guild.id !== GUILD_ID) return;

    const discordId = member.user.id;
    const username = member.user.tag;

    try {
      const existing = await db.select().from(subscribers).where(eq(subscribers.discord_id, discordId)).limit(1);
      if (existing.length === 0) return;

      await db.update(subscribers)
        .set({ status: 'inactive', updated_at: new Date() })
        .where(eq(subscribers.discord_id, discordId));
      console.log(`✔ [DISCORD] Set status=inactive for ${username} (left guild)`);

      if (existing[0].did) {
        try {
          await botLabelerManager.applyLabel(existing[0].did, BADGE_DEF.teamAffirmation, true);
          console.log(`[INFO][DISCORD] Negated team-affirmation label for ${existing[0].did}`);
        } catch (labelErr) {
          console.error(`[ERROR][DISCORD] Failed to negate label for ${existing[0].did}:`, labelErr);
        }
      }
    } catch (err) {
      console.error(`❌ [DISCORD] Error processing guildMemberRemove for ${username}:`, err);
    }
  });

  // 7. Reconcile on Guild Join (guildMemberAdd)
  // Compensates for missed guildMemberRemove events while the bot was offline.
  client.on(Events.GuildMemberAdd, async (member) => {
    if (member.guild.id !== GUILD_ID) return;
    await reconcileMembers(member.guild);
  });

  // 8. Connect/Login to Discord
  client.login(DISCORD_TOKEN);
}

startBot().catch(err => {
  console.error("❌ [CRITICAL] Discord Bot crashed on startup:", err);
});
