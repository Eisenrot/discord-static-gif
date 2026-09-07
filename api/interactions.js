import { waitUntil } from '@vercel/functions';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import nacl from 'tweetnacl';
import ffmpegPath from 'ffmpeg-static';

const DISCORD_API = 'https://discord.com/api/v10';
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_INPUT_PIXELS = 100_000_000;
const MAX_IMAGE_DIMENSION = 4096;
const MAX_VIDEO_DIMENSION = 450;
const MIN_IMAGE_DIMENSION = 128;
const VIDEO_CONVERSION_TIMEOUT_MS = 25_000;
const VIDEO_ATTEMPTS = [
  { fps: 12, maxDimension: 450 },
  { fps: 10, maxDimension: 450 },
  { fps: 8, maxDimension: 400 },
  { fps: 7, maxDimension: 350 },
  { fps: 6, maxDimension: 350 },
  { fps: 5, maxDimension: 300 },
  { fps: 5, maxDimension: 250 },
];

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
  const option = interaction.data?.options?.find(
    (item) => item.name === 'media' || item.name === 'image',
  );
  const id = option?.value;
  return id ? interaction.data?.resolved?.attachments?.[id] : null;
}

function outputName(filename = 'media') {
  const base = filename
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return `${(base || 'media').slice(0, 80)}.gif`;
}

function detectAttachmentKind(attachment) {
  const contentType = attachment?.content_type?.toLowerCase() || '';
  const filename = attachment?.filename?.toLowerCase() || '';

  if (
    contentType.startsWith('image/') ||
    /\.(png|jpe?g|webp|bmp|tiff?|avif|heic|heif|gif)$/i.test(filename)
  ) {
    return 'image';
  }

  if (
    contentType.startsWith('video/') ||
    /\.(mp4|m4v|mov|webm|avi|mkv)$/i.test(filename)
  ) {
    return 'video';
  }

  return null;
}

async function downloadAttachment(attachment) {
  if (!attachment?.url) throw new Error('Discord did not provide an attachment URL.');

  const kind = detectAttachmentKind(attachment);
  if (!kind) {
    throw new Error('Please upload an image or a short video file.');
  }

  if (attachment.size > MAX_SOURCE_BYTES) {
    throw new Error('That file is over GIFStar’s 25 MiB source limit.');
  }

  const response = await fetch(attachment.url, {
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(`Could not download the file from Discord (${response.status}).`);
  }

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_SOURCE_BYTES) {
    throw new Error('That file is over GIFStar’s 25 MiB source limit.');
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_SOURCE_BYTES) {
    throw new Error('That file is over GIFStar’s 25 MiB source limit.');
  }

  return { buffer, kind };
}

async function renderImageGif(input, maxDimension, colours) {
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

async function convertImageToGif(input, uploadLimit) {
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
    MAX_IMAGE_DIMENSION,
  );
  let colours = 256;
  let lastBuffer;

  for (let attempt = 0; attempt < 7; attempt += 1) {
    lastBuffer = await renderImageGif(
      input,
      Math.max(MIN_IMAGE_DIMENSION, Math.round(maxDimension)),
      colours,
    );

    if (lastBuffer.length <= uploadLimit) return lastBuffer;

    const ratio = Math.sqrt(uploadLimit / lastBuffer.length) * 0.9;
    maxDimension = Math.max(
      MIN_IMAGE_DIMENSION,
      maxDimension * Math.min(0.9, ratio),
    );

    if (attempt >= 2) colours = Math.max(64, colours - 48);
  }

  if (lastBuffer?.length <= uploadLimit) return lastBuffer;

  throw new Error(
    'The converted GIF is still too large for Discord, even after resizing it.',
  );
}

function extnameOrDefault(filename = '') {
  const ext = path.extname(filename).toLowerCase();
  return ext || '.bin';
}

function runFfmpegToGif(inputPath, fps, maxDimension, maxOutputBytes) {
  if (!ffmpegPath) {
    throw new Error('Video conversion is unavailable right now.');
  }

  return new Promise((resolve, reject) => {
    const filter = [
      `[0:v]fps=${fps},scale=${maxDimension}:${maxDimension}:force_original_aspect_ratio=decrease:flags=lanczos,split[s0][s1]`,
      '[s0]palettegen=stats_mode=diff[p]',
      '[s1][p]paletteuse=dither=sierra2_4a[gif]',
    ].join(';');

    const args = [
      '-v',
      'error',
      '-i',
      inputPath,
      '-an',
      '-sn',
      '-dn',
      '-filter_complex',
      filter,
      '-map',
      '[gif]',
      '-loop',
      '0',
      '-f',
      'gif',
      'pipe:1',
    ];

    const child = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let settled = false;

    const finishError = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(message));
    };

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finishError('The video took too long to convert.');
    }, VIDEO_CONVERSION_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;

      if (stdoutBytes > maxOutputBytes) {
        child.kill('SIGKILL');
        const error = new Error('GIF output exceeds Discord’s upload limit.');
        error.code = 'OUTPUT_TOO_LARGE';
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        }
        return;
      }

      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      finishError(`Could not start FFmpeg: ${error.message}`);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      if (code === 0) {
        resolve(Buffer.concat(stdout));
        return;
      }

      const details = Buffer.concat(stderr).toString('utf8').trim();
      reject(
        new Error(
          details
            ? `FFmpeg failed: ${details.slice(0, 300)}`
            : `FFmpeg exited with code ${code}.`,
        ),
      );
    });
  });
}

async function convertVideoToGif(input, filename, uploadLimit) {
  const inputPath = path.join(
    os.tmpdir(),
    `gifstar-${randomUUID()}${extnameOrDefault(filename)}`,
  );

  await fs.writeFile(inputPath, input);

  try {
    let lastBuffer;

    for (const attempt of VIDEO_ATTEMPTS) {
      try {
        lastBuffer = await runFfmpegToGif(
          inputPath,
          attempt.fps,
          Math.min(MAX_VIDEO_DIMENSION, attempt.maxDimension),
          uploadLimit,
        );

        if (lastBuffer.length <= uploadLimit) {
          return lastBuffer;
        }
      } catch (error) {
        if (error?.code === 'OUTPUT_TOO_LARGE') continue;
        throw error;
      }
    }

    if (lastBuffer?.length <= uploadLimit) return lastBuffer;

    throw new Error(
      'The converted GIF is still too large for Discord, even after reducing the video.',
    );
  } finally {
    await fs.unlink(inputPath).catch(() => {});
  }
}

async function editOriginal(
  interaction,
  { content = '', file = null, filename = 'media.gif' },
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
    if (!attachment) throw new Error('No media attachment was provided.');

    const { buffer: source, kind } = await downloadAttachment(attachment);
    const uploadLimit =
      Number(interaction.attachment_size_limit) || 10 * 1024 * 1024;

    const gif =
      kind === 'video'
        ? await convertVideoToGif(source, attachment.filename, uploadLimit)
        : await convertImageToGif(source, uploadLimit);

    await editOriginal(interaction, {
      file: gif,
      filename: outputName(attachment.filename),
    });
  } catch (error) {
    console.error('GIFStar conversion failed:', error);

    try {
      await editOriginal(interaction, {
        content: `GIFStar couldn't convert that file: ${
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
