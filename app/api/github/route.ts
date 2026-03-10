import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { supabase } from '@/lib/supabase';

// ── Helpers ──────────────────────────────────────────────────────────────────

function verifyGitHubSignature(payload: string, signature: string | null): boolean {
  if (!signature) return false;
  const secret = process.env.GITHUB_WEBHOOK_SECRET!;
  const hmac = crypto.createHmac('sha256', secret);
  const digest = `sha256=${hmac.update(payload).digest('hex')}`;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(digest, 'utf8'),
      Buffer.from(signature, 'utf8')
    );
  } catch {
    return false;
  }
}

async function postDiscordEmbed(channelId: string, embed: Record<string, unknown>) {
  const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: process.env.DISCORD_BOT_TOKEN!,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ embeds: [embed] }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`[github] Discord POST failed for channel ${channelId} (${res.status}): ${text}`);
  }
}

// ── Event builders ────────────────────────────────────────────────────────────

function buildPushEmbed(body: any): Record<string, unknown> {
  const commit = body.head_commit;
  const repo = body.repository.full_name;
  const branch = (body.ref as string).replace('refs/heads/', '');

  return {
    title: `📦 New push to \`${repo}\``,
    description: commit.message,
    url: commit.url,
    color: 0x5865f2,
    author: {
      name: commit.author.name,
      url: `https://github.com/${commit.author.username}`,
      icon_url: `https://github.com/${commit.author.username}.png`,
    },
    fields: [
      {
        name: 'Branch',
        value: `[\`${branch}\`](${body.repository.html_url}/tree/${branch})`,
        inline: true,
      },
      {
        name: 'Commit',
        value: `[\`${(commit.id as string).substring(0, 7)}\`](${commit.url})`,
        inline: true,
      },
      {
        name: 'Changes',
        value: [
          `➕ ${commit.added?.length ?? 0} added`,
          `➖ ${commit.removed?.length ?? 0} removed`,
          `✏️ ${commit.modified?.length ?? 0} modified`,
        ].join(' · '),
        inline: false,
      },
    ],
    timestamp: new Date(commit.timestamp).toISOString(),
    footer: { text: 'GitHub Push' },
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const signature = req.headers.get('x-hub-signature-256');
  const event = req.headers.get('x-github-event');
  const payload = await req.text();

  // Verify secret
  if (!verifyGitHubSignature(payload, signature)) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  // Only handle push events (extend here for pull_request, issues, etc.)
  if (event !== 'push') {
    return new NextResponse('Event ignored', { status: 200 });
  }

  const body = JSON.parse(payload);

  // Ignore branch deletions (head_commit is null on delete pushes)
  if (!body.head_commit) {
    return new NextResponse('Branch deletion ignored', { status: 200 });
  }

  const repoName: string = body.repository.full_name;

  // Find subscribed channels
  const { data: rows, error } = await supabase
    .from('tracked_repos')
    .select('channel_id')
    .eq('repo_name', repoName);

  if (error) {
    console.error('[github] Supabase error:', error);
    return new NextResponse('Internal server error', { status: 500 });
  }

  if (!rows || rows.length === 0) {
    return new NextResponse('No subscribers', { status: 200 });
  }

  const embed = buildPushEmbed(body);

  // Fan out to all subscribed Discord channels in parallel
  await Promise.all(rows.map((row) => postDiscordEmbed(row.channel_id, embed)));

  return new NextResponse('OK', { status: 200 });
}
