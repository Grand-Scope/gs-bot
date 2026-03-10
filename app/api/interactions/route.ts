import { NextRequest, NextResponse } from 'next/server';
import {
  verifyKey,
  InteractionType,
  InteractionResponseType,
} from 'discord-interactions';
import { supabase } from '@/lib/supabase';

// Ephemeral flag value (Discord API)
const EPHEMERAL = 64;

function jsonResponse(data: unknown, status = 200) {
  return new NextResponse(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function POST(req: NextRequest) {
  // ── Signature verification ──────────────────────────────────────────────
  const signature = req.headers.get('x-signature-ed25519') ?? '';
  const timestamp = req.headers.get('x-signature-timestamp') ?? '';
  const rawBody = await req.text();

  const isValid = verifyKey(
    rawBody,
    signature,
    timestamp,
    process.env.DISCORD_PUBLIC_KEY!
  );
  if (!isValid) {
    return new NextResponse('Invalid request signature', { status: 401 });
  }

  const interaction = JSON.parse(rawBody);

  // ── Ping (type 1) ───────────────────────────────────────────────────────
  if (interaction.type === InteractionType.PING) {
    return jsonResponse({ type: InteractionResponseType.PONG });
  }

  // ── Slash commands (type 2) ─────────────────────────────────────────────
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    const commandName: string = interaction.data.name;
    const channelId: string = interaction.channel_id;

    // /track <repo>
    if (commandName === 'track') {
      const repoName: string | undefined =
        interaction.data.options?.[0]?.value;

      if (!repoName) {
        return jsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: '❌ Please provide a repository name (e.g. `owner/repo`).',
            flags: EPHEMERAL,
          },
        });
      }

      const { error } = await supabase
        .from('tracked_repos')
        .upsert({ repo_name: repoName, channel_id: channelId });

      if (error) {
        console.error('[/track] Supabase error:', error);
        return jsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: '❌ Failed to save tracking info. Please try again later.',
            flags: EPHEMERAL,
          },
        });
      }

      return jsonResponse({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `✅ Now tracking **${repoName}** in this channel. You'll receive push notifications here.`,
        },
      });
    }

    // /tracked
    if (commandName === 'tracked') {
      const { data, error } = await supabase
        .from('tracked_repos')
        .select('repo_name')
        .eq('channel_id', channelId)
        .order('created_at', { ascending: true });

      if (error) {
        console.error('[/tracked] Supabase error:', error);
        return jsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: '❌ Could not fetch tracked repositories.',
            flags: EPHEMERAL,
          },
        });
      }

      const list =
        data && data.length > 0
          ? data.map((r) => `• \`${r.repo_name}\``).join('\n')
          : '*No repositories are being tracked in this channel yet.*';

      return jsonResponse({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `📚 **Tracked repositories in this channel:**\n${list}`,
        },
      });
    }

    // Unknown command
    return jsonResponse({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '❓ Unknown command.', flags: EPHEMERAL },
    });
  }

  return new NextResponse('Unsupported interaction type', { status: 400 });
}
