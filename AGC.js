// Imports nécessaires
const { Client, GatewayIntentBits, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, PermissionsBitField } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Configuration du client Discord
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Configuration
const config = {
    token: '',
    prefix: '!',
    twitchClientId: '',
    twitchClientSecret: '',
  refreshInterval: 5 * 60 * 1000, // 5 minutes
  autoPostInterval: 5 * 60 * 1000,
  statusChannelId: '1358178129801379850',
  dataFile: path.join(__dirname, 'streamers.json'),
  configFile: path.join(__dirname, 'config.json')
};

let twitchAccessToken = '';
let streamers = [];
let lastInfoMessage = null;
let liveNotifications = {}; // Pour suivre les messages de notification en cours

function loadData() {
  try {
    if (fs.existsSync(config.dataFile)) {
      streamers = JSON.parse(fs.readFileSync(config.dataFile, 'utf8'));
    } else {
      streamers = [];
      saveData();
    }
  } catch (err) {
    console.error('Erreur chargement données:', err);
    streamers = [];
  }
}

function saveData() {
  fs.writeFileSync(config.dataFile, JSON.stringify(streamers, null, 2), 'utf8');
}

function loadConfig() {
  try {
    if (fs.existsSync(config.configFile)) {
      const loadedConfig = JSON.parse(fs.readFileSync(config.configFile, 'utf8'));
      Object.assign(config, loadedConfig);
    }
  } catch (err) {
    console.error('Erreur chargement config:', err);
  }
}

function saveConfig() {
  const { statusChannelId, refreshInterval, autoPostInterval } = config;
  fs.writeFileSync(config.configFile, JSON.stringify({ statusChannelId, refreshInterval, autoPostInterval }, null, 2), 'utf8');
}

async function getTwitchAccessToken() {
  try {
    const res = await axios.post(`https://id.twitch.tv/oauth2/token?client_id=${config.twitchClientId}&client_secret=${config.twitchClientSecret}&grant_type=client_credentials`);
    twitchAccessToken = res.data.access_token;
    return twitchAccessToken;
  } catch (err) {
    console.error('Erreur token Twitch:', err);
    return null;
  }
}

async function checkStreamersStatus() {
  if (!twitchAccessToken) await getTwitchAccessToken();
  if (streamers.length === 0) return;

  const chunks = [];
  for (let i = 0; i < streamers.length; i += 100) {
    chunks.push(streamers.slice(i, i + 100));
  }

  for (const chunk of chunks) {
    try {
      const twitchUsernames = chunk.map(s => s.twitchUsername);
      const userRes = await axios.get('https://api.twitch.tv/helix/users', {
        headers: {
          'Client-ID': config.twitchClientId,
          'Authorization': `Bearer ${twitchAccessToken}`
        },
        params: { login: twitchUsernames }
      });

      const userIds = userRes.data.data.map(u => u.id);

      const streamRes = await axios.get('https://api.twitch.tv/helix/streams', {
        headers: {
          'Client-ID': config.twitchClientId,
          'Authorization': `Bearer ${twitchAccessToken}`
        },
        params: { user_id: userIds }
      });

      for (const streamer of chunk) {
        const user = userRes.data.data.find(u => u.login.toLowerCase() === streamer.twitchUsername.toLowerCase());
        if (!user) continue;

        const liveData = streamRes.data.data.find(s => s.user_id === user.id);
        const wasLive = streamer.isLive;
        streamer.isLive = !!liveData;

        if (liveData) {
          streamer.title = liveData.title;
          streamer.viewerCount = liveData.viewer_count;
          streamer.gameName = liveData.game_name;

          if (!wasLive) {
            const guild = client.guilds.cache.first();
            const channel = guild.channels.cache.get(config.statusChannelId);
            const msg = await channel.send(`${streamer.discordUsername} est en stream : ${streamer.twitchUrl}`);
            liveNotifications[streamer.discordUsername] = msg.id;
          }
        } else {
          if (wasLive && liveNotifications[streamer.discordUsername]) {
            const guild = client.guilds.cache.first();
            const channel = guild.channels.cache.get(config.statusChannelId);
            try {
              const msg = await channel.messages.fetch(liveNotifications[streamer.discordUsername]);
              await msg.delete();
            } catch (e) {}
            delete liveNotifications[streamer.discordUsername];
          }

          streamer.title = '';
          streamer.viewerCount = 0;
          streamer.gameName = '';
        }
      }
    } catch (err) {
      console.error('Erreur vérification:', err);
      if (err.response?.status === 401) await getTwitchAccessToken();
    }
  }
  saveData();
}

function formatInfoPanel() {
  const now = new Date();
  const timestamp = now.toLocaleTimeString();
  let message = '**Information Panel**\n\n';

  for (const s of streamers) {
    const status = s.isLive ? `est en stream sur **${s.title}**\n${s.twitchUrl}` : `n'est pas en stream actuellement`;
    message += `${s.discordUsername} : ${status}\n\n`;
  }

  message += `\nRafraîchi toutes les ${config.refreshInterval / 60000} minutes | Généré à ${timestamp}`;
  return message;
}

async function showInfoPanel(channel) {
  await checkStreamersStatus();

  const embed = new EmbedBuilder()
    .setColor(0x6441a5)
    .setTitle('Statut des Streamers')
    .setDescription(formatInfoPanel())
    .setTimestamp()
    .setFooter({ text: 'Stream Tracker Bot' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('refresh').setLabel('Rafraîchir').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('addStreamer').setLabel('Ajouter un streamer').setStyle(ButtonStyle.Success)
  );

  return { embeds: [embed], components: [row] };
}

async function updateInfoPanelInChannel() {
  for (const guild of client.guilds.cache.values()) {
    const channel = guild.channels.cache.get(config.statusChannelId);
    if (!channel) continue;

    const panel = await showInfoPanel(channel);

    try {
      if (lastInfoMessage && lastInfoMessage.channelId === channel.id) {
        const oldMsg = await channel.messages.fetch(lastInfoMessage.id).catch(() => null);
        if (oldMsg) await oldMsg.edit(panel);
        else lastInfoMessage = await channel.send(panel);
      } else {
        lastInfoMessage = await channel.send(panel);
      }
    } catch (err) {
      console.error('Erreur envoi panneau:', err);
    }
  }
}

client.once('ready', async () => {
  console.log(`Connecté en tant que ${client.user.tag}`);
  loadConfig();
  loadData();
  await getTwitchAccessToken();
  await updateInfoPanelInChannel();
  setInterval(checkStreamersStatus, config.refreshInterval);
  setInterval(updateInfoPanelInChannel, config.autoPostInterval);
});

client.on('messageCreate', async message => {
  if (message.author.bot || !message.content.startsWith(config.prefix)) return;

  const args = message.content.slice(config.prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    return message.reply('Seuls les administrateurs peuvent utiliser cette commande.');
  }

  if (command === 'addstreamer') {
    if (args.length < 2) return message.reply('Utilisation: !addstreamer <pseudo_discord> <lien_twitch>');

    const discordUsername = args[0];
    let twitchUrl = args[1];

    if (!twitchUrl.includes('twitch.tv/')) return message.reply('URL Twitch invalide.');

    const twitchUsername = twitchUrl.split('twitch.tv/')[1].split('/')[0].split('?')[0];
    twitchUrl = `https://twitch.tv/${twitchUsername}`;

    const exists = streamers.find(s =>
      s.twitchUsername.toLowerCase() === twitchUsername.toLowerCase() ||
      s.discordUsername.toLowerCase() === discordUsername.toLowerCase()
    );

    if (exists) return message.reply('Ce streamer est déjà dans la liste.');

    streamers.push({
      discordUsername,
      twitchUsername,
      twitchUrl,
      isLive: false,
      title: '',
      viewerCount: 0,
      gameName: ''
    });

    saveData();
    await checkStreamersStatus();
    await updateInfoPanelInChannel();

    return message.reply(`Streamer ${discordUsername} ajouté !`);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  if (interaction.customId === 'refresh') {
    await interaction.deferUpdate();
    await checkStreamersStatus();
    const panel = await showInfoPanel(interaction.channel);
    await interaction.editReply(panel);
  } else if (interaction.customId === 'addStreamer') {
    await interaction.reply({
      content: 'Pour ajouter un streamer, utilisez la commande:\n!addstreamer <pseudo_discord> <lien_twitch>',
      ephemeral: true
    });
  }
});

client.login(config.token);