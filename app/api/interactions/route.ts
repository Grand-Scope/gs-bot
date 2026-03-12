export const runtime = 'edge';

import { NextRequest, NextResponse } from 'next/server';
import { InteractionType, InteractionResponseType } from 'discord-interactions';
import { supabase } from '@/lib/supabase';

// Ephemeral flag value (Discord API)
const EPHEMERAL = 64;

function hexToUint8Array(hex: string): ArrayBuffer {
  const bytes = hex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16));
  return new Uint8Array(bytes).buffer as ArrayBuffer;
}

async function verifyDiscordSignature(
  publicKey: string,
  signature: string,
  timestamp: string,
  body: string
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      hexToUint8Array(publicKey),
      { name: 'Ed25519', namedCurve: 'Ed25519' },
      false,
      ['verify']
    );
    return await crypto.subtle.verify(
      'Ed25519',
      key,
      hexToUint8Array(signature),
      new TextEncoder().encode(timestamp + body)
    );
  } catch {
    return false;
  }
}

function jsonResponse(data: unknown, status = 200) {
  return new NextResponse(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── GitHub API ────────────────────────────────────────────────────────────────

async function fetchAllOrgRepos(org: string): Promise<string[]> {
  const token = process.env.GITHUB_TOKEN;
  const repos: string[] = [];

  for (let page = 1; page <= 3; page++) {
    const res = await fetch(
      `https://api.github.com/orgs/${org}/repos?type=all&per_page=100&page=${page}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      }
    );

    if (!res.ok) {
      if (res.status === 404) throw new Error(`Organization '${org}' not found on GitHub.`);
      throw new Error(`GitHub API error: ${res.status}`);
    }

    const data: { full_name: string }[] = await res.json();
    if (data.length === 0) break;
    repos.push(...data.map((r) => r.full_name));
    if (data.length < 100) break;
  }

  return repos;
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // ── Signature verification ─────────────────────────────────────────────────
  const signature = req.headers.get('x-signature-ed25519') ?? '';
  const timestamp = req.headers.get('x-signature-timestamp') ?? '';
  const rawBody = await req.text();

  const isValid = await verifyDiscordSignature(
    process.env.DISCORD_PUBLIC_KEY!,
    signature,
    timestamp,
    rawBody
  );
  if (!isValid) {
    return new NextResponse('Invalid request signature', { status: 401 });
  }

  const interaction = JSON.parse(rawBody);

  // ── Ping (type 1) ──────────────────────────────────────────────────────────
  if (interaction.type === InteractionType.PING) {
    return jsonResponse({ type: InteractionResponseType.PONG });
  }

  // ── Slash commands (type 2) ────────────────────────────────────────────────
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    const commandName: string = interaction.data.name;
    const channelId: string = interaction.channel_id;
    const options: { name: string; value: string }[] = interaction.data.options ?? [];

    // ── /track-org <org> [#channel] ──────────────────────────────────────────
    if (commandName === 'track-org') {
      const orgName = options.find((o) => o.name === 'org')?.value;
      const channelOption = options.find((o) => o.name === 'channel');
      const targetChannelId = channelOption?.value ?? channelId;

      if (!orgName) {
        return jsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: '❌ Please provide a GitHub organization name.', flags: EPHEMERAL },
        });
      }

      let repos: string[];
      try {
        repos = await fetchAllOrgRepos(orgName);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        return jsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `❌ ${msg}`, flags: EPHEMERAL },
        });
      }

      if (repos.length === 0) {
        return jsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `⚠️ No repositories found in **${orgName}**.`, flags: EPHEMERAL },
        });
      }

      const rows = repos.map((repoFullName) => ({
        org_name: orgName,
        repo_full_name: repoFullName,
        channel_id: targetChannelId,
      }));

      const { error } = await supabase
        .from('tracked_repos')
        .upsert(rows, { onConflict: 'repo_full_name,channel_id' });

      if (error) {
        console.error('[/track-org] Supabase error:', error);
        return jsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: '❌ Failed to save tracking info. Please try again later.', flags: EPHEMERAL },
        });
      }

      const channelMention = channelOption ? `<#${targetChannelId}>` : 'this channel';
      return jsonResponse({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `✅ Now tracking **${repos.length}** repositor${repos.length !== 1 ? 'ies' : 'y'} from **${orgName}** in ${channelMention}.`,
        },
      });
    }

    // ── /untrack-org <org> ───────────────────────────────────────────────────
    if (commandName === 'untrack-org') {
      const orgName = options.find((o) => o.name === 'org')?.value;

      if (!orgName) {
        return jsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: '❌ Please provide a GitHub organization name.', flags: EPHEMERAL },
        });
      }

      const { error, count } = await supabase
        .from('tracked_repos')
        .delete({ count: 'exact' })
        .eq('org_name', orgName)
        .eq('channel_id', channelId);

      if (error) {
        console.error('[/untrack-org] Supabase error:', error);
        return jsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: '❌ Failed to remove tracking info. Please try again later.', flags: EPHEMERAL },
        });
      }

      if (count === 0) {
        return jsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `⚠️ **${orgName}** was not being tracked in this channel.`, flags: EPHEMERAL },
        });
      }

      return jsonResponse({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `✅ Stopped tracking **${count}** repositor${count !== 1 ? 'ies' : 'y'} from **${orgName}** in this channel.`,
        },
      });
    }

    // ── /list-repos ──────────────────────────────────────────────────────────
    if (commandName === 'list-repos') {
      const { data, error } = await supabase
        .from('tracked_repos')
        .select('org_name, repo_full_name')
        .eq('channel_id', channelId)
        .order('org_name', { ascending: true })
        .order('repo_full_name', { ascending: true });

      if (error) {
        console.error('[/list-repos] Supabase error:', error);
        return jsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: '❌ Could not fetch tracked repositories.', flags: EPHEMERAL },
        });
      }

      if (!data || data.length === 0) {
        return jsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: '*No repositories are being tracked in this channel yet.*' },
        });
      }

      // Group by org
      const byOrg: Record<string, string[]> = {};
      for (const row of data) {
        if (!byOrg[row.org_name]) byOrg[row.org_name] = [];
        byOrg[row.org_name].push(row.repo_full_name);
      }

      const lines = Object.entries(byOrg).map(([org, repos]) => {
        const repoList = repos.map((r) => `  • \`${r}\``).join('\n');
        return `**${org}** (${repos.length})\n${repoList}`;
      });

      return jsonResponse({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `📦 **Tracked repositories in this channel:**\n\n${lines.join('\n\n')}`,
        },
      });
    }

    // ── /add-repo <owner/repo> [#channel] ────────────────────────────────────
    if (commandName === 'add-repo') {
      const repoFullName = options.find((o) => o.name === 'repo')?.value;
      const channelOption = options.find((o) => o.name === 'channel');
      const targetChannelId = channelOption?.value ?? channelId;

      if (!repoFullName || !repoFullName.includes('/')) {
        return jsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: '❌ Please provide a repository in `owner/repo` format (e.g. `vercel/next.js`).', flags: EPHEMERAL },
        });
      }

      const orgName = repoFullName.split('/')[0];

      const { error } = await supabase
        .from('tracked_repos')
        .upsert(
          { org_name: orgName, repo_full_name: repoFullName, channel_id: targetChannelId },
          { onConflict: 'repo_full_name,channel_id' }
        );

      if (error) {
        console.error('[/add-repo] Supabase error:', error);
        return jsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: '❌ Failed to add repository. Please try again later.', flags: EPHEMERAL },
        });
      }

      const channelMention = channelOption ? `<#${targetChannelId}>` : 'this channel';
      return jsonResponse({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `✅ Now tracking \`${repoFullName}\` in ${channelMention}.` },
      });
    }

    // ── /remove-repo <owner/repo> ────────────────────────────────────────────
    if (commandName === 'remove-repo') {
      const repoFullName = options.find((o) => o.name === 'repo')?.value;

      if (!repoFullName) {
        return jsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: '❌ Please provide a repository in `owner/repo` format.', flags: EPHEMERAL },
        });
      }

      const { error, count } = await supabase
        .from('tracked_repos')
        .delete({ count: 'exact' })
        .eq('repo_full_name', repoFullName)
        .eq('channel_id', channelId);

      if (error) {
        console.error('[/remove-repo] Supabase error:', error);
        return jsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: '❌ Failed to remove repository. Please try again later.', flags: EPHEMERAL },
        });
      }

      if (count === 0) {
        return jsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `⚠️ \`${repoFullName}\` was not being tracked in this channel.`, flags: EPHEMERAL },
        });
      }

      return jsonResponse({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `✅ Stopped tracking \`${repoFullName}\` in this channel.` },
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
