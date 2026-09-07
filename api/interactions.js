import { waitUntil } from '@vercel/functions';
import sharp from 'sharp';
import nacl from 'tweetnacl';

const DISCORD_API = 'https://discord.com/api/v10';
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_INPUT_PIXELS = 100_000_000;
const MAX_DIMENSION = 4096;
const MIN_DIMENSION = 128;

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function verifyDiscordRequest(rawBody, signature, timestamp) {
  const publicKey = process.env.DISCORD_PUBLIC_KEY;
  if (!publicKey || !signature || !timestamp) return false;

  try {
    return nacl.sign.detached.verify(
      Buffer.from(timestamp + rawBody),
      Buffer.from(signature, 'hex'),
      Buffer.from(publicKey, 'hex'),
    );
  } catch {
    return false;
  }
}

function getAttachment(interaction) {
  const option = interaction.data?.options?.find((item) => item.name === 'image');
  const id = option?.value;
  return id ? interaction.data?.resolved?.attachments?.[id] : null;
}

function outputName(filename = 'image') {
  const base = filename
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return `${(base || 'image').slice(0, 80)}.gif`;
}

async function downloadAttachment(attachment) {
  if (!attachment?.url) throw new Error('Discord did not provide an attachment URL.');

  if (attachment.size > MAX_SOURCE_BYTES) {
    throw new Error('That image is over GIFStar’s 50 MiB source limit.');
  }

  if (attachment.content_type && !attachment.content_type.startsWith('image/')) {
    throw new Error('Please upload an image file.');
  }

  const response = await fetch(attachment.url, {
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(`Could not download the image from Discord (${response.status}).`);
  }

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_SOURCE_BYTES) {
    throw new Error('That image is over GIFStar’s 50 MiB source limit.');
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_SOURCE_BYTES) {
    throw new Error('That image is over GIFStar’s 50 MiB source limit.');
  }

  return buffer;
}

async function renderGif(input, maxDimension, colours) {
  return sharp(input, {
    animated: false,
    failOn: 'error',
    limitInputPixels: MAX_INPUT_PIXELS,
  })
    .rotate()
    .resize({
      width: maxDimension,
      height: maxDimension,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .gif({
      colours,
      effort: 7,
      dither: 1,
    })
    .toBuffer();
}

async function convertToGif(input, uploadLimit) {
  const metadata = await sharp(input, {
    animated: false,
    failOn: 'error',
    limitInputPixels: MAX_INPUT_PIXELS,
  }).metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error('Could not read that image.');
  }

  let maxDimension = Math.min(
    Math.max(metadata.width, metadata.height),
    MAX_DIMENSION,
  );
  let colours = 256;
  let lastBuffer;

  for (let attempt = 0; attempt < 7; attempt += 1) {
    lastBuffer = await renderGif(
      input,
      Math.max(MIN_DIMENSION, Math.round(maxDimension)),
      colours,
    );

    if (lastBuffer.length <= uploadLimit) return lastBuffer;

    const ratio = Math.sqrt(uploadLimit / lastBuffer.length) * 0.9;
    maxDimension = Math.max(
      MIN_DIMENSION,
      maxDimension * Math.min(0.9, ratio),
    );

    if (attempt >= 2) colours = Math.max(64, colours - 48);
  }

  if (lastBuffer?.length <= uploadLimit) return lastBuffer;

  throw new Error(
    'The converted GIF is still too large for Discord, even after resizing it.',
  );
}

async function editOriginal(
  interaction,
  { content = '', file = null, filename = 'image.gif' },
) {
  const url = `${DISCORD_API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;

  let response;

  if (file) {
    const form = new FormData();
    form.append(
      'payload_json',
      JSON.stringify({
        content,
        allowed_mentions: { parse: [] },
        attachments: [{ id: 0, filename }],
      }),
    );
    form.append(
      'files[0]',
      new Blob([file], { type: 'image/gif' }),
      filename,
    );

    response = await fetch(url, {
      method: 'PATCH',
      body: form,
    });
  } else {
    response = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        allowed_mentions: { parse: [] },
      }),
    });
  }

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new Error(
      `Discord rejected the response (${response.status})${
        details ? `: ${details.slice(0, 300)}` : ''
      }`,
    );
  }
}

async function processGif(interaction) {
  try {
    const attachment = getAttachment(interaction);
    if (!attachment) throw new Error('No image attachment was provided.');

    const source = await downloadAttachment(attachment);
    const uploadLimit =
      Number(interaction.attachment_size_limit) || 10 * 1024 * 1024;
    const gif = await convertToGif(source, uploadLimit);

    await editOriginal(interaction, {
      file: gif,
      filename: outputName(attachment.filename),
    });
  } catch (error) {
    console.error('GIFStar conversion failed:', error);

    try {
      await editOriginal(interaction, {
        content: `GIFStar couldn't convert that image: ${
          error instanceof Error ? error.message : 'Unknown error.'
        }`,
      });
    } catch (followupError) {
      console.error('GIFStar could not send the error response:', followupError);
    }
  }
}

export default {
  async fetch(request) {
    if (request.method === 'GET') {
      return json({ ok: true, app: 'GIFStar' });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { Allow: 'GET, POST' },
      });
    }

    const rawBody = await request.text();
    const signature = request.headers.get('x-signature-ed25519');
    const timestamp = request.headers.get('x-signature-timestamp');

    if (!verifyDiscordRequest(rawBody, signature, timestamp)) {
      return new Response('invalid request signature', { status: 401 });
    }

    let interaction;
    try {
      interaction = JSON.parse(rawBody);
    } catch {
      return new Response('invalid JSON', { status: 400 });
    }

    if (interaction.type === 1) {
      return json({ type: 1 });
    }

    if (interaction.type !== 2 || interaction.data?.name !== 'gifstar') {
      return json({
        type: 4,
        data: {
          content: 'GIFStar received an unsupported interaction.',
          flags: 64,
        },
      });
    }

    waitUntil(processGif(interaction));
    return json({ type: 5 });
  },
};
