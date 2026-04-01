const express = require('express');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const { createClient } = require('@supabase/supabase-js');

// Use system ffmpeg (installed via nixpacks.toml)
// fluent-ffmpeg will auto-detect from PATH

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = Number(process.env.PORT || 3000);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

app.get('/health', (_req, res) => res.json({ success: true, ffmpegPath: 'system' }));

/** Escape text for FFmpeg drawtext filter */
function escapeDrawtext(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

const DEJAVU_FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

/**
 * Build a title card (black background + drawtext + silent audio).
 * Uses raw ffmpeg spawn to avoid fluent-ffmpeg filter escaping issues.
 */
async function buildTitleCard({ outPath, durationSec, lines }) {
  // lines: [{text, fontcolor, fontsize, y}]
  const { spawn } = require('child_process');

  // Build vf filter chain: start with color source, chain drawtext filters
  const drawtextFilters = lines.map(({ text, fontcolor, fontsize, y }) => {
    const escaped = escapeDrawtext(text);
    return `drawtext=fontfile='${DEJAVU_FONT}':text='${escaped}':fontcolor=${fontcolor}:fontsize=${fontsize}:x=(w-tw)/2:y=${y}`;
  });

  // Full filter_complex: generate black video + overlay text + mix silent audio
  const videoFilter = `color=black:size=1080x1920:duration=${durationSec}:rate=30[base];[base]${drawtextFilters.join(',')}[vout]`;

  const args = [
    '-f', 'lavfi', '-i', `color=black:size=1080x1920:duration=${durationSec}:rate=30`,
    '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo`,
    '-filter_complex', videoFilter,
    '-map', '[vout]',
    '-map', '1:a',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-t', String(durationSec),
    '-y',
    outPath,
  ];

  console.log('[titleCard] ffmpeg args:', args.join(' '));

  await new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('titleCard ffmpeg exit ' + code + ': ' + stderr.slice(-500)));
    });
  });

  return outPath;
}

// Build a 3-second intro card
async function buildIntroCard({ workDir, projectTitle, episodeNum, episodeTitle }) {
  const outPath = path.join(workDir, 'introcard.mp4');
  const title = projectTitle || 'ScriptFlow';
  const epLine = 'Episode ' + (episodeNum || 1) + (episodeTitle ? ' \u00b7 ' + episodeTitle : '');
  return buildTitleCard({
    outPath,
    durationSec: 3,
    lines: [
      { text: title,  fontcolor: 'white',   fontsize: 60, y: '(h-th)/2-60' },
      { text: epLine, fontcolor: '#D4A017', fontsize: 40, y: '(h-th)/2+20' },
    ],
  });
}

// Build a 5-second end card
async function buildEndCard({ workDir, projectTitle, episodeNum, episodeTitle }) {
  const outPath = path.join(workDir, 'endcard.mp4');
  const title = projectTitle || 'ScriptFlow';
  const epLine = 'Episode ' + (episodeNum || 1) + (episodeTitle ? ' \u00b7 ' + episodeTitle : '');
  return buildTitleCard({
    outPath,
    durationSec: 5,
    lines: [
      { text: title,           fontcolor: 'white', fontsize: 80, y: '(h-th)/2-140' },
      { text: epLine,          fontcolor: 'white', fontsize: 60, y: '(h-th)/2'     },
      { text: '@wolfemperorai', fontcolor: 'white', fontsize: 40, y: '(h-th)/2+100' },
    ],
  });
}

app.post('/merge', async (req, res) => {
  const requestId = crypto.randomUUID();
  let workDir = null;
  try {
    const { projectId, videoUrls, audioUrls, srtContent, projectTitle, episodeNum, episodeTitle, bgmUrl } = req.body || {};
    if (!projectId || !videoUrls?.length) {
      return res.status(400).json({ success: false, error: 'Missing required fields: projectId and videoUrls are required' });
    }

    workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'merge-'));
    console.log('[' + requestId + '] workDir: ' + workDir);

    const videoPaths = [];
    for (let i = 0; i < videoUrls.length; i++) {
      const out = path.join(workDir, 'v' + String(i).padStart(3,'0') + '.mp4');
      await download(videoUrls[i], out);
      videoPaths.push(out);
    }

    const concatVideo = path.join(workDir, 'cv.mp4');
    await concatMedia(videoPaths, path.join(workDir, 'vlist.txt'), concatVideo);

    const mergedPath = path.join(workDir, 'merged.mp4');
    const hasAudio = Array.isArray(audioUrls) && audioUrls.length > 0;
    const hasSrt = typeof srtContent === 'string' && srtContent.trim().length > 0;
    const hasBgm = typeof bgmUrl === 'string' && bgmUrl.trim().length > 0;

    if (hasAudio || hasSrt || hasBgm) {
      // Full merge: video + dialogue audio + optional BGM + optional subtitles
      const audioPaths = [];
      if (hasAudio) {
        for (let i = 0; i < audioUrls.length; i++) {
          const out = path.join(workDir, 'a' + String(i).padStart(3,'0') + '.mp3');
          await download(audioUrls[i], out);
          audioPaths.push(out);
        }
      }

      let concatAudio = null;
      if (audioPaths.length > 0) {
        concatAudio = path.join(workDir, 'ca.mp3');
        await concatMedia(audioPaths, path.join(workDir, 'alist.txt'), concatAudio);
      }

      // Download BGM if provided
      let bgmPath = null;
      if (hasBgm) {
        try {
          bgmPath = path.join(workDir, 'bgm.mp3');
          await download(bgmUrl, bgmPath);
          const bgmStat = await fsp.stat(bgmPath);
          console.log('[' + requestId + '] BGM downloaded:', bgmPath, 'size:', bgmStat.size, 'bytes');
        } catch (bgmErr) {
          console.warn('[' + requestId + '] BGM download failed (skipping): ' + bgmErr.message);
          bgmPath = null;
        }
      }

      let srtPath = null;
      if (hasSrt) {
        srtPath = path.join(workDir, 'sub.srt');
        await fsp.writeFile(srtPath, srtContent, 'utf8');
      }

      const srtEscaped = srtPath
        ? path.resolve(srtPath).replace(/\\/g,'/').replace(/:/g,'\\:').replace(/'/g,"\\'")
        : null;

      await new Promise((resolve, reject) => {
        const cmd = ffmpeg().input(concatVideo);
        if (concatAudio) cmd.input(concatAudio);
        if (bgmPath) cmd.input(bgmPath);

        const outputOptions = ['-c:v libx264', '-preset veryfast', '-crf 23'];

        console.log('[merge] concatAudio:', !!concatAudio, 'bgmPath:', bgmPath);

        const subtitleStyle = req.body.subtitleStyle || "FontSize=8,Alignment=2,MarginV=20";

        if (concatAudio && bgmPath) {
          // Three-track mix: video (input 0) + dialogue audio (input 1) + BGM (input 2, looped)
          // BGM at 15% volume, looped to match video duration
          const filterComplex = '[1:a]volume=1.0[dialogue];[2:a]volume=0.28,aloop=loop=-1:size=2147483647[bgm];[dialogue][bgm]amix=inputs=2:duration=first[aout]';
          outputOptions.push('-filter_complex', filterComplex);
          outputOptions.push('-map', '0:v', '-map', '[aout]', '-c:a', 'aac', '-b:a', '192k', '-shortest');
          if (srtEscaped) outputOptions.push("-vf subtitles='" + srtEscaped + "':force_style='" + subtitleStyle + "'");
        } else if (concatAudio) {
          outputOptions.push('-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-b:a', '192k', '-shortest');
          if (srtEscaped) outputOptions.push("-vf subtitles='" + srtEscaped + "':force_style='" + subtitleStyle + "'");
        } else if (bgmPath) {
          // BGM only (no dialogue audio)
          outputOptions.push('-filter_complex', '[1:a]volume=0.4,aloop=loop=-1:size=2147483647[aout]');
          outputOptions.push('-map', '0:v:0', '-map', '[aout]', '-c:a', 'aac', '-b:a', '192k', '-shortest');
        } else {
          outputOptions.push('-c:a', 'copy');
          if (srtEscaped) outputOptions.push("-vf subtitles='" + srtEscaped + "':force_style='" + subtitleStyle + "'");
        }

        cmd.on('start', (cmdLine) => console.log('[merge] FFmpeg command:', cmdLine))
          .outputOptions(outputOptions)
          .on('error', err => reject(err))
          .on('end', resolve)
          .save(mergedPath);
      });
    } else {
      // Video-only merge: just copy streams
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(concatVideo)
          .outputOptions(['-c copy'])
          .on('error', err => reject(err))
          .on('end', resolve)
          .save(mergedPath);
      });
    }

    // Build intro card and end card
    const fontPath = path.join(__dirname, 'assets', 'fonts', 'Inter-Regular.ttf');

    let introCardPath = null;
    try {
      introCardPath = await buildIntroCard({ workDir, fontPath, projectTitle, episodeNum, episodeTitle });
      console.log('[' + requestId + '] Intro card built: ' + introCardPath);
    } catch (icErr) {
      console.warn('[' + requestId + '] Intro card build failed (skipping): ' + icErr.message);
    }

    let endCardPath = null;
    try {
      endCardPath = await buildEndCard({ workDir, fontPath, projectTitle, episodeNum, episodeTitle });
      console.log('[' + requestId + '] End card built: ' + endCardPath);
    } catch (ecErr) {
      console.warn('[' + requestId + '] End card build failed (skipping): ' + ecErr.message);
    }

    // Assemble: [intro card] + merged + [end card]
    const finalPath = path.join(workDir, 'final.mp4');
    const partsToConcat = [];
    if (introCardPath) partsToConcat.push(introCardPath);
    partsToConcat.push(mergedPath);
    if (endCardPath) partsToConcat.push(endCardPath);

    if (partsToConcat.length > 1) {
      await concatMedia(partsToConcat, path.join(workDir, 'flist.txt'), finalPath);
    } else {
      await fsp.rename(mergedPath, finalPath);
    }

    const buf = await fsp.readFile(finalPath);
    const storagePath = projectId + '/final-' + Date.now() + '.mp4';
    const { error } = await supabase.storage.from('generated-videos').upload(storagePath, buf, { contentType: 'video/mp4', upsert: true });
    if (error) throw new Error('Upload failed: ' + error.message);

    const { data } = supabase.storage.from('generated-videos').getPublicUrl(storagePath);
    console.log('[' + requestId + '] Done: ' + data.publicUrl);
    res.json({ success: true, finalVideoUrl: data.publicUrl });
  } catch (err) {
    console.error('[' + requestId + '] ERROR:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (workDir) await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

async function download(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Download failed: ' + url);
  await fsp.writeFile(outPath, Buffer.from(await res.arrayBuffer()));
}

async function concatMedia(paths, listFile, outPath) {
  const content = paths.map(p => "file '" + path.resolve(p).replace(/'/g,"'\\''") + "'").join('\n');
  await fsp.writeFile(listFile, content, 'utf8');
  await new Promise((resolve, reject) => {
    ffmpeg().input(listFile).inputOptions(['-f concat','-safe 0']).outputOptions(['-c copy'])
      .on('error', reject).on('end', resolve).save(outPath);
  });
}

app.listen(PORT, () => {
  console.log('[boot] Service on port ' + PORT);
  console.log('[boot] ffmpeg: system (via nixpacks)');

  // Font file detection for Railway environment
  const fs = require('fs');
  const fontPaths = [
    '/app/assets/fonts/Inter-Regular.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
  ];
  fontPaths.forEach(p => {
    console.log('[font-check] ' + p + ': ' + (fs.existsSync(p) ? 'EXISTS' : 'NOT FOUND'));
  });
});
