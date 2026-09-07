const applicationId = process.env.DISCORD_APPLICATION_ID;
const token = process.env.DISCORD_BOT_TOKEN;

if (!applicationId || !token) {
  console.error('Missing DISCORD_APPLICATION_ID or DISCORD_BOT_TOKEN.');
  console.error(
    'Example: DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... npm run register',
  );
  process.exit(1);
}

const command = {
  name: 'gifstar',
  description:
    'Turn a static image into a GIF you can save to Discord GIF Favorites.',
  type: 1,
  integration_types: [1],
  contexts: [0, 1, 2],
  options: [
    {
      type: 11,
      name: 'image',
      description: 'The image to turn into a GIF',
      required: true,
    },
  ],
};

const response = await fetch(
  `https://discord.com/api/v10/applications/${applicationId}/commands`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  },
);

const body = await response.text();

if (!response.ok) {
  console.error(`Discord returned ${response.status}: ${body}`);
  process.exit(1);
}

const registered = JSON.parse(body);
console.log(`Registered /${registered.name} (${registered.id}) globally.`);
