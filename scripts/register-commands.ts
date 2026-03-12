import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';

// Load env from .env.local when running locally with ts-node
import { config } from 'dotenv';
config({ path: '.env.local' });
config({ path: '.env', override: false });

const APPLICATION_ID = process.env.DISCORD_APPLICATION_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

if (!APPLICATION_ID || !BOT_TOKEN) {
  console.error(
    '❌ Missing DISCORD_APPLICATION_ID or DISCORD_BOT_TOKEN in environment.'
  );
  process.exit(1);
}

// Strip the "Bot " prefix if it exists; REST library adds it automatically
const token = BOT_TOKEN.replace(/^Bot\s+/i, '');

const commands = [
  {
    name: 'track-org',
    description: 'Auto-discover and track all repos in a GitHub org',
    type: 1, // CHAT_INPUT
    options: [
      {
        name: 'org',
        description: 'GitHub organization login name (e.g. vercel)',
        type: 3, // STRING
        required: true,
      },
      {
        name: 'channel',
        description: 'Channel to send notifications to (defaults to current channel)',
        type: 7, // CHANNEL
        required: false,
      },
    ],
  },
  {
    name: 'untrack-org',
    description: 'Stop tracking all repos from a GitHub org in this channel',
    type: 1,
    options: [
      {
        name: 'org',
        description: 'GitHub organization login name (e.g. vercel)',
        type: 3, // STRING
        required: true,
      },
    ],
  },
  {
    name: 'list-repos',
    description: 'List all tracked repositories in this channel, grouped by org',
    type: 1,
  },
  {
    name: 'add-repo',
    description: 'Manually track a single GitHub repository in this channel',
    type: 1,
    options: [
      {
        name: 'repo',
        description: 'Repository in owner/repo format (e.g. vercel/next.js)',
        type: 3, // STRING
        required: true,
      },
      {
        name: 'channel',
        description: 'Channel to send notifications to (defaults to current channel)',
        type: 7, // CHANNEL
        required: false,
      },
    ],
  },
  {
    name: 'remove-repo',
    description: 'Stop tracking a single GitHub repository in this channel',
    type: 1,
    options: [
      {
        name: 'repo',
        description: 'Repository in owner/repo format (e.g. vercel/next.js)',
        type: 3, // STRING
        required: true,
      },
    ],
  },
];

(async () => {
  const rest = new REST({ version: '10' }).setToken(token);

  try {
    console.log(`⏳ Registering ${commands.length} global slash command(s)…`);

    const result = (await rest.put(
      Routes.applicationCommands(APPLICATION_ID),
      { body: commands }
    )) as any[];

    console.log(`✅ Successfully registered ${result.length} command(s):`);
    result.forEach((cmd) => console.log(`   • /${cmd.name}`));
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
    process.exit(1);
  }
})();
