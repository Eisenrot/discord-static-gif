# GIFStar

GIFStar is a tiny user-installable Discord app that turns a static image attachment into a GIF, so you can add it to Discord's GIF Favorites instead of hunting down the original image again.

Use it anywhere your user-installed app commands are allowed:

```text
/gifstar image:<attachment>
```

The app has no database, no Gateway connection, and no persistent image storage. Discord sends an interaction to a Vercel Function, the function downloads the attachment, converts it in memory, and edits the deferred interaction response with the resulting `.gif`.

## How it works

```text
Discord /gifstar
      |
      | signed HTTP interaction
      v
Vercel /api/interactions
      |
      | verify Discord signature
      | acknowledge immediately
      | download attachment
      | Sharp -> GIF
      v
Discord interaction response
```

GIFStar uses Vercel `waitUntil()` so Discord gets its acknowledgement immediately while the conversion continues after the HTTP response is returned.

## Discord app setup

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Open **Installation** and enable **User Install**.
3. For the User Install default scopes, add `applications.commands`.
4. Copy the application's **Application ID** and **Public Key** from **General Information**.
5. Open **Bot**, reset/copy the bot token, and keep it private. It is only needed to register the command; the deployed converter does not use it.

Do not commit your bot token or any other Discord secret to this repository.

## Deploy to Vercel

Import this repository into Vercel and add one environment variable:

```text
DISCORD_PUBLIC_KEY=<your Discord application's public key>
```

Deploy the project. Then copy the production URL and set the Discord application's **Interactions Endpoint URL** to:

```text
https://YOUR-PROJECT.vercel.app/api/interactions
```

Discord will send a signed PING to verify the endpoint. A normal browser `GET` to that path returns a small health response, but Discord interactions are accepted only when their signatures are valid.

The project targets Node.js 24 on Vercel.

## Register `/gifstar`

The slash command is global and configured for **User Install**, with guild, bot-DM, DM and group-DM interaction contexts.

Install dependencies locally:

```bash
npm install
```

### PowerShell

```powershell
$env:DISCORD_APPLICATION_ID="YOUR_APPLICATION_ID"
$env:DISCORD_BOT_TOKEN="YOUR_BOT_TOKEN"
npm run register
```

### bash / zsh

```bash
DISCORD_APPLICATION_ID="YOUR_APPLICATION_ID" \
DISCORD_BOT_TOKEN="YOUR_BOT_TOKEN" \
npm run register
```

The registration script creates or updates the global `/gifstar` command through Discord's API.

After that, use the application's install link from the Developer Portal and choose **Add to my apps**.

## Usage

```text
/gifstar image:reaction.png
```

GIFStar will defer the command, convert the image, and replace the pending response with a GIF attachment. On Discord desktop/browser, use the star control on the GIF to add it to your GIF Favorites.

## Conversion behavior

- Accepts Discord image attachments that Sharp can decode.
- Processes images entirely in memory.
- Applies EXIF orientation automatically.
- Produces a palette-based GIF with up to 256 colors.
- Starts at the source resolution, capped at 4096 px on the longest edge.
- If the GIF exceeds the invoking interaction's Discord attachment-size limit, GIFStar progressively resizes it and reduces the palette.
- Source downloads are capped at 50 MiB and 100 million decoded pixels to avoid pathological image inputs.
- Uses Discord's `attachment_size_limit` from the interaction, so Nitro/server upload limits are respected when available.

GIF is an indexed 256-color format, so photographs and gradients can lose some color fidelity compared with PNG/JPEG/WebP. The intended use is reaction images, memes, screenshots and other images you want available from Discord's GIF Favorites.

## Environment variables

| Variable | Where | Purpose |
| --- | --- | --- |
| `DISCORD_PUBLIC_KEY` | Vercel | Verifies incoming Discord interactions |
| `DISCORD_APPLICATION_ID` | Local registration only | Selects the Discord application whose global command is registered |
| `DISCORD_BOT_TOKEN` | Local registration only | Authenticates the one-off command registration request |

Only `DISCORD_PUBLIC_KEY` is required by the deployed Vercel Function.

## Local checks

```bash
npm run check
```

## License

MIT
