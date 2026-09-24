import http from 'node:http';
import {
  AttachmentBuilder,
  type ButtonInteraction,
  type Client,
  type Interaction,
} from 'discord.js';
import {
  canModerate,
  moderationCustomId,
  overrideResultLine,
  parseModerationCustomId,
  type OverrideResponse,
} from './moderationNotice.js';

/**
 * Nagi AppView のモデレーション通知を、解除ボタン付きで投稿する。
 *
 * 通常の Webhook は components を受け付けないので、AppView は Webhook より先にここへ
 * 同じ multipart（payload_json + files[n]）を送ってくる。ここが落ちていれば AppView は
 * Webhook（ボタン無し）へフォールバックする。
 *
 * 内部 HTTP は 127.0.0.1 にだけ束縛し、それを認可とする（AppView の /internal と同じ）。
 */

// index.ts と同じく、discord.js の型解決の不具合（TS2460）を避けるため値を手で持つ。
const COMPONENT_ACTION_ROW = 1;
const COMPONENT_BUTTON = 2;
const BUTTON_STYLE_SUCCESS = 3;
const PERMISSION_MANAGE_GUILD = 1n << 5n;

/** Web API の型は lib 設定の都合で解決できないので、使う形だけを書く。 */
type FormFields = { get(name: string): unknown };
type JsonResponse = { ok: boolean; status: number; json(): Promise<unknown> };

const MAX_BODY_BYTES = 25 * 1024 * 1024;
const APPVIEW_TIMEOUT_MS = 60_000;

export type ModerationConfig = {
  channelId: string;
  moderatorRoleId?: string;
  port: number;
  appviewOverrideUrl: string;
};

function releaseRow(customId: string, disabled = false) {
  return {
    type: COMPONENT_ACTION_ROW,
    components: [
      {
        type: COMPONENT_BUTTON,
        style: BUTTON_STYLE_SUCCESS,
        custom_id: customId,
        label: '解除（表示を戻す）',
        disabled,
      },
    ],
  };
}

async function relayNotice(
  client: Client,
  config: ModerationConfig,
  form: FormFields,
): Promise<void> {
  const payload = JSON.parse(String(form.get('payload_json') ?? '{}'));
  const files: AttachmentBuilder[] = [];
  for (let index = 0; ; index++) {
    const file = form.get(`files[${index}]`) as
      | { name: string; arrayBuffer(): Promise<ArrayBuffer> }
      | null;
    if (!file || typeof file !== 'object' || !('arrayBuffer' in file)) break;
    files.push(
      new AttachmentBuilder(Buffer.from(await file.arrayBuffer()), {
        name: file.name,
      }),
    );
  }

  let content: string = payload.content ?? '';
  const uri = form.get('moderation_uri');
  const components: Array<ReturnType<typeof releaseRow>> = [];
  if (typeof uri === 'string' && uri) {
    const customId = moderationCustomId('allow', uri);
    if (customId) components.push(releaseRow(customId));
    else content += '\n⚠️ URI が長すぎるため解除ボタンを付けられません。';
  }

  const channel = await client.channels.fetch(config.channelId);
  if (!channel?.isSendable())
    throw new Error(`moderation channel ${config.channelId} is not sendable`);
  await channel.send({
    content: content.slice(0, 2_000),
    embeds: payload.embeds ?? [],
    files,
    components: components as any,
    allowedMentions: { parse: [] },
  });
}

export function startModerationNoticeServer(
  client: Client,
  config: ModerationConfig,
): http.Server {
  const server = http.createServer(async (req, res) => {
    const reply = (status: number, body: string) => {
      res.writeHead(status, { 'content-type': 'text/plain' });
      res.end(body);
    };
    if (req.method !== 'POST' || req.url !== '/moderation/notices')
      return reply(404, 'not found');
    // AppView はこの 503 を見て Webhook へフォールバックする。
    if (!client.isReady()) return reply(503, 'discord client is not ready');
    const declared = Number(req.headers['content-length'] ?? '0');
    if (declared > MAX_BODY_BYTES) return reply(413, 'too large');
    try {
      const request = new Request('http://127.0.0.1/moderation/notices', {
        method: 'POST',
        headers: req.headers as Record<string, string>,
        body: req as unknown as ReadableStream,
        duplex: 'half',
      } as RequestInit);
      const form = (await request.formData()) as unknown as FormFields;
      await relayNotice(client, config, form);
      reply(204, '');
    } catch (err) {
      console.error('[ERROR][DISCORD_MODERATION] Failed to relay notice:', err);
      if (!res.headersSent) reply(502, 'relay failed');
    }
  });
  server.listen(config.port, '127.0.0.1', () =>
    console.log(
      `✔ [DISCORD] Moderation notice API listening on 127.0.0.1:${config.port}`,
    ),
  );
  return server;
}

async function handleRelease(
  interaction: ButtonInteraction,
  config: ModerationConfig,
  target: { action: 'allow'; uri: string },
): Promise<void> {
  const member = interaction.member;
  const roleIds =
    member && 'cache' in member.roles
      ? member.roles.cache.keys()
      : ((member?.roles as string[] | undefined) ?? []);
  const allowed = canModerate(
    {
      roleIds,
      manageGuild:
        interaction.memberPermissions?.has(PERMISSION_MANAGE_GUILD) ??
        false,
    },
    config.moderatorRoleId,
  );
  if (!allowed) {
    await interaction.reply({
      content: '❌ 解除できるのはモデレーターだけです。',
      ephemeral: true,
    });
    return;
  }

  // AppView は PDS からの取り直しを挟むので、3秒の応答期限を先に確保する。
  await interaction.deferUpdate();
  const actor = `${interaction.user.tag} (${interaction.user.id})`;
  try {
    const response = (await fetch(config.appviewOverrideUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uri: target.uri, action: target.action, actor }),
      signal: AbortSignal.timeout(APPVIEW_TIMEOUT_MS),
    })) as unknown as JsonResponse;
    if (!response.ok && response.status !== 404)
      throw new Error(`AppView returned HTTP ${response.status}`);
    const result = (await response.json()) as OverrideResponse;
    const line = overrideResultLine(result, interaction.user.tag);
    await interaction.editReply({
      content: `${interaction.message.content}\n\n${line}`.slice(0, 2_000),
      components: [releaseRow(interaction.customId, true)] as any,
    });
    console.log(
      `[INFO][DISCORD_MODERATION] ${actor} released ${target.uri}: ${result.status}`,
    );
  } catch (err) {
    console.error(
      `[ERROR][DISCORD_MODERATION] Release failed for ${target.uri}:`,
      err,
    );
    await interaction.followUp({
      content: `❌ 解除に失敗しました: ${String(err).slice(0, 300)}`,
      ephemeral: true,
    });
  }
}

export function registerModerationInteractions(
  client: Client,
  config: ModerationConfig,
): void {
  client.on('interactionCreate', async (interaction: Interaction) => {
    if (!interaction.isButton()) return;
    const target = parseModerationCustomId(interaction.customId);
    if (!target) return;
    try {
      await handleRelease(interaction, config, target);
    } catch (err) {
      console.error('[ERROR][DISCORD_MODERATION] Interaction failed:', err);
    }
  });
}
