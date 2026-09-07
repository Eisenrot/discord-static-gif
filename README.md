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
/gifstar media:reaction.png
/gifstar media:clip.mp4
```

GIFStar will defer the command, convert the image or short video, and replace the pending response with a GIF attachment. On Discord desktop/browser, use the star control on the GIF to add it to your GIF Favorites.

## Supported input

- Static images such as PNG, JPEG, WebP, BMP, TIFF, AVIF, HEIC and GIF-style image attachments.
- Short video files such as MP4, M4V, MOV, WEBM, AVI and MKV, provided they are within the configured source-size limit.

## Conversion behavior

- Accepts Discord attachments that Sharp or FFmpeg can decode.
- Processes files entirely in memory, except for a temporary local file created only while FFmpeg converts video.
- Applies EXIF orientation automatically for image inputs.
- Produces a palette-based GIF with up to 256 colors.
- Respects Discord's `attachment_size_limit` from the interaction when deciding whether the output is small enough to upload.

### Source limits

- Source image/video download limit: **25 MiB**.
- Source downloads are capped at 100 million decoded pixels for image inputs to avoid pathological files.

### Image conversion

- Starts from the source resolution, capped at 4096 px on the longest edge.
- If the GIF exceeds Discord's upload limit, GIFStar progressively resizes the image and reduces the palette.

### Video conversion

- Converts video clips to GIF with no audio.
- Starts at a longest edge of **450 px**.
- Uses a descending quality ladder to fit under Discord's upload limit, lowering FPS and resolution as needed.
- Initial video conversion targets **12 FPS**, then progressively drops toward **5 FPS** and smaller dimensions if required to make the GIF uploadable.
- There is no explicit hard duration limit, but unusually long clips may still fail if conversion takes too long, exhaust the function time budget, or if the resulting GIF cannot be reduced enough to fit Discord's upload limit.

GIF is an indexed 256-color format, so photographs, gradients and longer video clips can lose quality compared with PNG/JPEG/WebP/MP4. The intended use is reaction images, memes, screenshots and short clips you want available from Discord's GIF Favorites.

## Legal pages

The live legal pages used for Discord verification are:

- Terms of Service: `https://discord-static-gif.vercel.app/terms`
- Privacy Policy: `https://discord-static-gif.vercel.app/privacy`

If you materially change GIFStar's functionality or data handling, update those pages so they stay accurate.

## Environment variables

| Variable | Where | Purpose |
| --- | --- | --- |
| `DISCORD_PUBLIC_KEY` | Vercel | Verifies incoming Discord interactions |
| `DISCORD_APPLICATION_ID` | Local registration only | Selects the Discord application whose global command is registered |
| `DISCORD_BOT_TOKEN` | Local registration only | Authenticates the one-off command registration request |

Only `DISCORD_PUBLIC_KEY` is required by the deployed Vercel Function.
