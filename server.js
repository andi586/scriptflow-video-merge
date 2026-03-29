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

app.post('/merge', async (req, res) => {
  const requestId = crypto.randomUUID();
  let workDir = null;
  try {
    const { projectId, videoUrls, audioUrls, srtContent } = req.body || {};
    if (!projectId || !videoUrls?.length || !audioUrls?.length || !srtContent) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'merge-'));
    console.log('[' + requestId + '] workDir: ' + workDir);

    const videoPaths = [];
    for (let i = 0; i < videoUrls.length; i++) {
      const out = path.join(workDir, 'v' + String(i).padStart(3,'0') + '.mp4');
      await download(videoUrls[i], out);
      videoPaths.push(out);
    }

    const audioPaths = [];
    for (let i = 0; i < audioUrls.length; i++) {
      const out = path.join(workDir, 'a' + String(i).padStart(3,'0') + '.mp3');
      await download(audioUrls[i], out);
      audioPaths.push(out);
    }

    const srtPath = path.join(workDir, 'sub.srt');
    await fsp.writeFile(srtPath, srtContent, 'utf8');

    const concatVideo = path.join(workDir, 'cv.mp4');
    await concatMedia(videoPaths, path.join(workDir, 'vlist.txt'), concatVideo);

    const concatAudio = path.join(workDir, 'ca.mp3');
    await concatMedia(audioPaths, path.join(workDir, 'alist.txt'), concatAudio);

    const finalPath = path.join(workDir, 'final.mp4');
    const srtEscaped = path.resolve(srtPath).replace(/\\/g,'/').replace(/:/g,'\\:').replace(/'/g,"\\'");

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatVideo)
        .input(concatAudio)
        .outputOptions(['-map 0:v:0','-map 1:a:0','-c:v libx264','-preset veryfast','-crf 23','-c:a aac','-b:a 192k','-shortest',"-vf subtitles='" + srtEscaped + "'"])
        .on('error', err => reject(err))
        .on('end', resolve)
        .save(finalPath);
    });

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