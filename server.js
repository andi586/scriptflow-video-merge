const express = require('express');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const { createClient } = require('@supabase/supabase-js');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = Number(process.env.PORT || 3000);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

app.get('/health', (_req, res) => res.json({ success: true, ffmpegPath: ffmpegInstaller.path }));

// Build a 5-second end card video using FFmpeg drawtext
async function buildEndCard({ workDir, fontPath, projectTitle, episodeNum, episodeTitle }) {
  const endCardPath = path.join(workDir, 'endcard.mp4');
  const hasFontFile = await fsp.access(fontPath).then(() => true).catch(() => false);

  const escapeTxt = (s) => (s || '').replace(/'/g, "\u2019").replace(/:/g, '\\:').replace(/\\/g, '/');

  const titleText = escapeTxt(projectTitle || 'ScriptFlow');
  const episodeText = escapeTxt('Episode ' + (episodeNum || 1) + (episodeTitle ? ' \u00b7 ' + episodeTitle : ''));
  const handleText = '@wolfemperorai';

  const fontArg = hasFontFile ? (':fontfile=' + fontPath.replace(/\\/g, '/').replace(/:/g, '\\:')) : '';

  const vf = [
    "color=black:size=1080x1920:duration=5:rate=30[bg]",
    "[bg]drawtext=text='" + titleText + "'" + fontArg + ":fontcolor=white:fontsize=80:x=(w-text_w)/2:y=(h/2)-120[t1]",
    "[t1]drawtext=text='" + episodeText + "'" + fontArg + ":fontcolor=white:fontsize=60:x=(w-text_w)/2:y=(h/2)[t2]",
    "[t2]drawtext=text='" + handleText + "'" + fontArg + ":fontcolor=white:fontsize=40:x=(w-text_w)/2:y=(h/2)+100[out]"
  ].join(';');

  await new Promise((resolve, reject) => {
    ffmpeg()
      .input('color=black:size=1080x1920:duration=5:rate=30')
      .inputOptions(['-f lavfi'])
      .complexFilter(vf, 'out')
      .outputOptions(['-c:v libx264', '-preset veryfast', '-crf 23', '-pix_fmt yuv420p', '-an'])
      .on('error', reject)
      .on('end', resolve)
      .save(endCardPath);
  });

  return endCardPath;
}

app.post('/merge', async (req, res) => {
  const requestId = crypto.randomUUID();
  let workDir = null;
  try {
    const { projectId, videoUrls, audioUrls, srtContent, projectTitle, episodeNum, episodeTitle } = req.body || {};
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

    if (hasAudio || hasSrt) {
      // Full merge: video + audio + optional subtitles
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
        const outputOptions = ['-c:v libx264','-preset veryfast','-crf 23'];
        if (concatAudio) {
          outputOptions.push('-map 0:v:0','-map 1:a:0','-c:a aac','-b:a 192k','-shortest');
        } else {
          outputOptions.push('-c:a copy');
        }
        const subtitleStyle = req.body.subtitleStyle || "FontSize=8,Alignment=2,MarginV=20";
        if (srtEscaped) outputOptions.push("-vf subtitles='" + srtEscaped + "':force_style='" + subtitleStyle + "'");
        cmd.outputOptions(outputOptions)
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

    // Build end card and append to merged video
    const fontPath = path.join(__dirname, 'assets', 'fonts', 'Inter-Regular.ttf');
    let endCardPath = null;
    try {
      endCardPath = await buildEndCard({ workDir, fontPath, projectTitle, episodeNum, episodeTitle });
      console.log('[' + requestId + '] End card built: ' + endCardPath);
    } catch (ecErr) {
      console.warn('[' + requestId + '] End card build failed (skipping): ' + ecErr.message);
    }

    const finalPath = path.join(workDir, 'final.mp4');
    if (endCardPath) {
      await concatMedia([mergedPath, endCardPath], path.join(workDir, 'flist.txt'), finalPath);
    } else {
      // No end card — just rename merged as final
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
  console.log('[boot] ffmpeg: ' + ffmpegInstaller.path);
});