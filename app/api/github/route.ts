import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { supabase } from '@/lib/supabase';

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  const repoName: string = body.repository.name;
  const repoFullName: string = body.repository.full_name;
  const branch = (body.ref as string).replace('refs/heads/', '');
  const commits: any[] = body.commits ?? [];

  // Show up to 5 most recent commits
  const shown = commits.slice(-5).reverse();
  const commitList = shown
    .map(
      (c: any) =>
        `[\`${(c.id as string).substring(0, 7)}\`](${c.url}) ${c.message.split('\n')[0].substring(0, 60)} — ${c.author.name}`
    )
    .join('\n');

  // Aggregate unique file changes across all commits
  const added = new Set<string>();
  const removed = new Set<string>();
  const modified = new Set<string>();
  for (const c of commits) {
    (c.added ?? []).forEach((f: string) => added.add(f));
    (c.removed ?? []).forEach((f: string) => removed.add(f));
    (c.modified ?? []).forEach((f: string) => modified.add(f));
  }

  const head = body.head_commit;
  const footerText =
    commits.length > 5
      ? `GitHub Push · showing 5 of ${commits.length} commits`
      : `GitHub Push · ${commits.length} commit${commits.length !== 1 ? 's' : ''}`;

  return {
    title: `📦 [${repoName}:${branch}] ${commits.length} commit${commits.length !== 1 ? 's' : ''}`,
    url: `${body.repository.html_url}/compare/${body.before}...${body.after}`,
    description: commitList || head?.message || '',
    color: 0x5865f2,
    author: {
      name: head?.author?.name ?? body.pusher?.name ?? 'Unknown',
      url: head?.author?.username ? `https://github.com/${head.author.username}` : undefined,
      icon_url: head?.author?.username
        ? `https://github.com/${head.author.username}.png`
        : undefined,
    },
    fields: [
      {
        name: 'Repository',
        value: `[\`${repoFullName}\`](${body.repository.html_url})`,
        inline: true,
      },
      {
        name: 'Branch',
        value: `[\`${branch}\`](${body.repository.html_url}/tree/${encodeURIComponent(branch)})`,
        inline: true,
      },
      {
        name: 'Changes',
        value: `➕ ${added.size} added · ➖ ${removed.size} removed · ✏️ ${modified.size} modified`,
        inline: false,
      },
    ],
    timestamp: head ? new Date(head.timestamp).toISOString() : new Date().toISOString(),
    footer: { text: footerText },
  };
}

function buildPullRequestEmbed(body: any): Record<string, unknown> {
  const pr = body.pull_request;
  const repoName: string = body.repository.name;
  const repoFullName: string = body.repository.full_name;
  const action: string = body.action;

  const actionLabel: Record<string, string> = {
    opened: 'opened',
    closed: pr.merged ? 'merged' : 'closed',
    reopened: 'reopened',
    synchronize: 'updated',
    ready_for_review: 'ready for review',
    review_requested: 'review requested',
  };

  const colorMap: Record<string, number> = {
    opened: 0x2ecc71,
    closed: pr.merged ? 0x9b59b6 : 0xe74c3c,
    reopened: 0xf39c12,
    synchronize: 0x3498db,
    ready_for_review: 0x2ecc71,
    review_requested: 0xf39c12,
  };

  const fields: Record<string, unknown>[] = [
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
  ];

  if (action === 'review_requested' && body.requested_reviewer) {
    fields.push({
      name: 'Reviewer',
      value: `[@${body.requested_reviewer.login}](${body.requested_reviewer.html_url})`,
      inline: true,
    });
  }

  return {
    title: `🔀 PR #${pr.number} ${actionLabel[action] ?? action}: ${pr.title}`,
    url: pr.html_url,
    description: pr.body ? pr.body.substring(0, 300) : '*No description*',
    color: colorMap[action] ?? 0x95a5a6,
    author: {
      name: pr.user.login,
      url: pr.user.html_url,
      icon_url: pr.user.avatar_url,
    },
    fields,
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
    labeled: 0x3498db,
  };

  const fields: Record<string, unknown>[] = [
    {
      name: 'Repository',
      value: `[\`${repoFullName}\`](${body.repository.html_url})`,
      inline: true,
    },
  ];

  if (action === 'labeled' && body.label) {
    fields.push({ name: 'Label', value: `\`${body.label.name}\``, inline: true });
  }

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
    fields,
    timestamp: new Date(issue.updated_at).toISOString(),
    footer: { text: `GitHub Issue · ${repoName}` },
  };
}

function buildCreateEmbed(body: any): Record<string, unknown> {
  const refType: string = body.ref_type; // 'branch' or 'tag'
  const ref: string = body.ref;
  const repoFullName: string = body.repository.full_name;
  const repoName: string = body.repository.name;

  const emoji = refType === 'tag' ? '🏷️' : '🌿';
  const url =
    refType === 'tag'
      ? `${body.repository.html_url}/releases/tag/${encodeURIComponent(ref)}`
      : `${body.repository.html_url}/tree/${encodeURIComponent(ref)}`;

  return {
    title: `${emoji} ${refType === 'tag' ? 'Tag' : 'Branch'} created: \`${ref}\``,
    url,
    color: 0x2ecc71,
    author: {
      name: body.sender.login,
      url: body.sender.html_url,
      icon_url: body.sender.avatar_url,
    },
    fields: [
      {
        name: 'Repository',
        value: `[\`${repoFullName}\`](${body.repository.html_url})`,
        inline: true,
      },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: `GitHub · ${repoName}` },
  };
}

function buildDeleteEmbed(body: any): Record<string, unknown> {
  const refType: string = body.ref_type;
  const ref: string = body.ref;
  const repoFullName: string = body.repository.full_name;
  const repoName: string = body.repository.name;

  const emoji = refType === 'tag' ? '🏷️' : '🌿';

  return {
    title: `${emoji} ${refType === 'tag' ? 'Tag' : 'Branch'} deleted: \`${ref}\``,
    color: 0xe74c3c,
    author: {
      name: body.sender.login,
      url: body.sender.html_url,
      icon_url: body.sender.avatar_url,
    },
    fields: [
      {
        name: 'Repository',
        value: `[\`${repoFullName}\`](${body.repository.html_url})`,
        inline: true,
      },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: `GitHub · ${repoName}` },
  };
}

function buildPRReviewEmbed(body: any): Record<string, unknown> {
  const pr = body.pull_request;
  const review = body.review;
  const repoFullName: string = body.repository.full_name;
  const repoName: string = body.repository.name;

  const state: string = review.state.toLowerCase();

  const stateLabel: Record<string, string> = {
    approved: '✅ Approved',
    changes_requested: '🔴 Changes requested',
    commented: '💬 Commented',
  };

  const colorMap: Record<string, number> = {
    approved: 0x2ecc71,
    changes_requested: 0xe74c3c,
    commented: 0x95a5a6,
  };

  return {
    title: `${stateLabel[state] ?? review.state}: PR #${pr.number} — ${pr.title}`,
    url: review.html_url,
    description: review.body ? review.body.substring(0, 300) : undefined,
    color: colorMap[state] ?? 0x95a5a6,
    author: {
      name: review.user.login,
      url: review.user.html_url,
      icon_url: review.user.avatar_url,
    },
    fields: [
      {
        name: 'Repository',
        value: `[\`${repoFullName}\`](${body.repository.html_url})`,
        inline: true,
      },
      {
        name: 'PR',
        value: `[#${pr.number}](${pr.html_url})`,
        inline: true,
      },
    ],
    timestamp: new Date(review.submitted_at).toISOString(),
    footer: { text: `GitHub PR Review · ${repoName}` },
  };
}

function buildReleaseEmbed(body: any): Record<string, unknown> {
  const release = body.release;
  const repoFullName: string = body.repository.full_name;
  const repoName: string = body.repository.name;

  return {
    title: `🚀 Release published: ${release.name || release.tag_name}`,
    url: release.html_url,
    description: release.body ? release.body.substring(0, 400) : '*No release notes*',
    color: 0x9b59b6,
    author: {
      name: release.author.login,
      url: release.author.html_url,
      icon_url: release.author.avatar_url,
    },
    fields: [
      {
        name: 'Repository',
        value: `[\`${repoFullName}\`](${body.repository.html_url})`,
        inline: true,
      },
      {
        name: 'Tag',
        value: `[\`${release.tag_name}\`](${release.html_url})`,
        inline: true,
      },
      {
        name: 'Pre-release',
        value: release.prerelease ? 'Yes' : 'No',
        inline: true,
      },
    ],
    timestamp: new Date(release.published_at).toISOString(),
    footer: { text: `GitHub Release · ${repoName}` },
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const signature = req.headers.get('x-hub-signature-256');
  const event = req.headers.get('x-github-event');
  const payload = await req.text();

  if (!verifyGitHubSignature(payload, signature)) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const body = JSON.parse(payload);
  const repoFullName: string | undefined = body.repository?.full_name;

  if (!repoFullName) {
    return new NextResponse('No repository found in payload', { status: 200 });
  }

  let embed: Record<string, unknown> | null = null;

  if (event === 'push') {
    // Ignore branch deletions (head_commit is null on delete pushes)
    if (!body.head_commit) {
      return new NextResponse('Branch deletion ignored', { status: 200 });
    }
    embed = buildPushEmbed(body);
  } else if (
    event === 'pull_request' &&
    ['opened', 'closed', 'reopened', 'synchronize', 'ready_for_review', 'review_requested'].includes(body.action)
  ) {
    embed = buildPullRequestEmbed(body);
  } else if (
    event === 'issues' &&
    ['opened', 'closed', 'reopened', 'labeled'].includes(body.action)
  ) {
    embed = buildIssueEmbed(body);
  } else if (event === 'create') {
    embed = buildCreateEmbed(body);
  } else if (event === 'delete') {
    embed = buildDeleteEmbed(body);
  } else if (event === 'pull_request_review' && body.action === 'submitted') {
    embed = buildPRReviewEmbed(body);
  } else if (event === 'release' && body.action === 'published') {
    embed = buildReleaseEmbed(body);
  } else {
    return new NextResponse('Event ignored', { status: 200 });
  }

  // Look up subscribed channels by repo full name
  const { data: rows, error } = await supabase
    .from('tracked_repos')
    .select('channel_id')
    .eq('repo_full_name', repoFullName);

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
