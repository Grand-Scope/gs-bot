import { InteractionType, InteractionResponseType, verifyKey } from 'discord-interactions';
import { supabase } from '@/lib/supabase';
import { waitUntil } from '@vercel/functions';

// Ephemeral flag value (Discord API)
const EPHEMERAL = 64;

/**
 * Returns a JSON response with the appropriate headers.
 */
function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
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
      if (res.status === 404) throw new Error(`Organization '${org}' not found on GitHub. Make sure you are using the organization's login name (slug) from its URL.`);
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

export async function POST(req: Request) {
  // ── Signature verification ─────────────────────────────────────────────────
  const signature = req.headers.get('x-signature-ed25519') ?? '';
  const timestamp = req.headers.get('x-signature-timestamp') ?? '';
  const body = await req.text();

  const isValid = verifyKey(
    body,
    signature,
    timestamp,
    process.env.DISCORD_PUBLIC_KEY!
  );

  if (!isValid) {
    console.error('[Interaction] Invalid signature');
    return new Response('Invalid request signature', { status: 401 });
  }

  const interaction = JSON.parse(body);

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

      // 1. Immediately acknowledge the interaction (avoid 3s timeout)
      const ackResponse = jsonResponse({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: EPHEMERAL },
      });

      // 2. Process in the background
      const backgroundTask = (async () => {
        const followUpUrl = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
        console.log(`[/track-org] Background URL: ${followUpUrl}`);
        
        try {
          console.log(`[/track-org] Starting fetch for org: ${orgName}`);
          const repos = await fetchAllOrgRepos(orgName);
          console.log(`[/track-org] Found ${repos.length} repos.`);

          if (repos.length === 0) {
            await fetch(followUpUrl, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: `⚠️ No repositories found in **${orgName}**.` }),
            });
            return;
          }

          const rows = repos.map((repoFullName) => ({
            org_name: orgName,
            repo_full_name: repoFullName,
            channel_id: targetChannelId,
          }));

          console.log(`[/track-org] Upserting ${rows.length} rows to Supabase...`);
          const { error } = await supabase
            .from('tracked_repos')
            .upsert(rows, { onConflict: 'repo_full_name,channel_id' });

          if (error) {
            console.error('[/track-org] Supabase error:', error);
            await fetch(followUpUrl, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: '❌ Failed to save tracking info. Please try again later.' }),
            });
            return;
          }

          const channelMention = channelOption ? `<#${targetChannelId}>` : 'this channel';
          console.log(`[/track-org] Sending success follow-up to Discord.`);
          const followUpRes = await fetch(followUpUrl, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: `✅ Now tracking **${repos.length}** repositor${repos.length !== 1 ? 'ies' : 'y'} from **${orgName}** in ${channelMention}.`,
            }),
          });
          
          if (!followUpRes.ok) {
            const errText = await followUpRes.text();
            console.error(`[/track-org] Discord follow-up failed (${followUpRes.status}):`, errText);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          console.error('[/track-org] Background error:', err);
          await fetch(followUpUrl, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: `❌ ${msg}` }),
          });
        }
      })();

      // Use waitUntil from @vercel/functions to ensure background task survives
      waitUntil(backgroundTask);

      return ackResponse;
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

  return new Response('Unsupported interaction type', { status: 400 });
}
