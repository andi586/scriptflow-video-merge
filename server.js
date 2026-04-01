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

// Build a 3-second intro card video using FFmpeg drawtext
async function buildIntroCard({ workDir, fontPath, projectTitle, episodeNum, episodeTitle }) {
  const introCardPath = path.join(workDir, 'introcard.mp4');

  const titleText = escapeDrawtext(projectTitle || 'ScriptFlow');
  const episodeText = escapeDrawtext('Episode ' + (episodeNum || 1) + (episodeTitle ? ' \u00b7 ' + episodeTitle : ''));

  const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  const fontArg = ':fontfile=' + FONT;

  const vf = [
    "color=black:size=1080x1920:duration=3:rate=30[bg]",
    "[bg]drawtext=text='" + titleText + "'" + fontArg + ":fontcolor=white:fontsize=60:x=(w-tw)/2:y=(h-th)/2-60[t1]",
    "[t1]drawtext=text='" + episodeText + "'" + fontArg + ":fontcolor=#D4A017:fontsize=40:x=(w-tw)/2:y=(h-th)/2+20[out]"
  ].join(';');

  console.log('[introCard] vf filter:', vf);

  await new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .input('color=black:size=1080x1920:duration=3:rate=30')
      .inputOptions(['-f lavfi'])
      .input('anullsrc=r=48000:cl=stereo')
      .inputOptions(['-f lavfi'])
      .complexFilter(vf, 'out')
      .outputOptions([
        '-map', '[out]',
        '-map', '1:a',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-shortest',
      ]);
    cmd.on('start', (cmdLine) => console.log('[introCard] FFmpeg command:', cmdLine));
    cmd.on('error', reject).on('end', resolve).save(introCardPath);
  });

  return introCardPath;
}

// Build a 5-second end card video using FFmpeg drawtext
async function buildEndCard({ workDir, fontPath, projectTitle, episodeNum, episodeTitle }) {
  const endCardPath = path.join(workDir, 'endcard.mp4');

  const titleText = escapeDrawtext(projectTitle || 'ScriptFlow');
  const episodeText = escapeDrawtext('Episode ' + (episodeNum || 1) + (episodeTitle ? ' \u00b7 ' + episodeTitle : ''));
  const handleText = escapeDrawtext('@wolfemperorai');

  const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  const fontArg = ':fontfile=' + FONT;

  const vf = [
    "color=black:size=1080x1920:duration=5:rate=30[bg]",
    "[bg]drawtext=text='" + titleText + "'" + fontArg + ":fontcolor=white:fontsize=80:x=(w-tw)/2:y=(h-th)/2-140[t1]",
    "[t1]drawtext=text='" + episodeText + "'" + fontArg + ":fontcolor=white:fontsize=60:x=(w-tw)/2:y=(h-th)/2[t2]",
    "[t2]drawtext=text='" + handleText + "'" + fontArg + ":fontcolor=white:fontsize=40:x=(w-tw)/2:y=(h-th)/2+100[out]"
  ].join(';');

  console.log('[endCard] vf filter:', vf);

  await new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .input('color=black:size=1080x1920:duration=5:rate=30')
      .inputOptions(['-f lavfi'])
      .input('anullsrc=r=48000:cl=stereo')
      .inputOptions(['-f lavfi'])
      .complexFilter(vf, 'out')
      .outputOptions([
        '-map', '[out]',
        '-map', '1:a',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-shortest',
      ]);
    cmd.on('start', (cmdLine) => console.log('[endCard] FFmpeg command:', cmdLine));
    cmd.on('error', reject).on('end', resolve).save(endCardPath);
  });

  return endCardPath;
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
