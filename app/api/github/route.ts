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
  const repoName: string = body.repository.name;
  const repoFullName: string = body.repository.full_name;
  const branch = (body.ref as string).replace('refs/heads/', '');

  return {
    title: `📦 Push to \`${repoName}\``,
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
        name: 'Repository',
        value: `[\`${repoFullName}\`](${body.repository.html_url})`,
        inline: true,
      },
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

function buildPullRequestEmbed(body: any): Record<string, unknown> {
  const pr = body.pull_request;
  const repoName: string = body.repository.name;
  const repoFullName: string = body.repository.full_name;
  const action: string = body.action;

  const colorMap: Record<string, number> = {
    opened: 0x2ecc71,
    closed: pr.merged ? 0x9b59b6 : 0xe74c3c,
    reopened: 0xf39c12,
  };

  return {
    title: `🔀 PR #${pr.number} ${action}: ${pr.title}`,
    url: pr.html_url,
    description: pr.body ? pr.body.substring(0, 300) : '*No description*',
    color: colorMap[action] ?? 0x95a5a6,
    author: {
      name: pr.user.login,
      url: pr.user.html_url,
      icon_url: pr.user.avatar_url,
    },
    fields: [
      {
        name: 'Repository',
        value: `[\`${repoFullName}\`](${body.repository.html_url})`,
        inline: true,
      },
      {
        name: 'Base ← Head',
        value: `\`${pr.base.ref}\` ← \`${pr.head.ref}\``,
        inline: true,
      },
    ],
    timestamp: new Date(pr.updated_at).toISOString(),
    footer: { text: `GitHub Pull Request · ${repoName}` },
  };
}

function buildIssueEmbed(body: any): Record<string, unknown> {
  const issue = body.issue;
  const repoName: string = body.repository.name;
  const repoFullName: string = body.repository.full_name;
  const action: string = body.action;

  const colorMap: Record<string, number> = {
    opened: 0xe74c3c,
    closed: 0x2ecc71,
    reopened: 0xf39c12,
  };

  return {
    title: `🐛 Issue #${issue.number} ${action}: ${issue.title}`,
    url: issue.html_url,
    description: issue.body ? issue.body.substring(0, 300) : '*No description*',
    color: colorMap[action] ?? 0x95a5a6,
    author: {
      name: issue.user.login,
      url: issue.user.html_url,
      icon_url: issue.user.avatar_url,
    },
    fields: [
      {
        name: 'Repository',
        value: `[\`${repoFullName}\`](${body.repository.html_url})`,
        inline: true,
      },
    ],
    timestamp: new Date(issue.updated_at).toISOString(),
    footer: { text: `GitHub Issue · ${repoName}` },
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

  const body = JSON.parse(payload);

  // Extract org login — gracefully handle payloads without an organization object
  const orgName: string | undefined =
    body.organization?.login ?? body.repository?.owner?.login;

  if (!orgName) {
    return new NextResponse('No organization found in payload', { status: 200 });
  }

  // Build the embed for the event type
  let embed: Record<string, unknown> | null = null;

  if (event === 'push') {
    // Ignore branch deletions (head_commit is null on delete pushes)
    if (!body.head_commit) {
      return new NextResponse('Branch deletion ignored', { status: 200 });
    }
    embed = buildPushEmbed(body);
  } else if (event === 'pull_request' && ['opened', 'closed', 'reopened'].includes(body.action)) {
    embed = buildPullRequestEmbed(body);
  } else if (event === 'issues' && ['opened', 'closed', 'reopened'].includes(body.action)) {
    embed = buildIssueEmbed(body);
  } else {
    return new NextResponse('Event ignored', { status: 200 });
  }

  // Find subscribed channels for this org
  const { data: rows, error } = await supabase
    .from('tracked_orgs')
    .select('channel_id')
    .eq('org_name', orgName);

  if (error) {
    console.error('[github] Supabase error:', error);
    return new NextResponse('Internal server error', { status: 500 });
  }

  if (!rows || rows.length === 0) {
    return new NextResponse('No subscribers', { status: 200 });
  }

  // Fan out to all subscribed Discord channels in parallel
  await Promise.all(rows.map((row) => postDiscordEmbed(row.channel_id, embed!)));

  return new NextResponse('OK', { status: 200 });
}
