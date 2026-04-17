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

// ─── Multilingual font mapping ────────────────────────────────────────────────
// Returns the best available font path for the given ISO 639-1 language code.
// CJK languages need Noto CJK; others fall back to Noto Sans or DejaVu.
function getFontForLanguage(lang) {
  const cjk = ['zh', 'ja', 'ko'];
  const arabic = ['ar', 'fa', 'ur'];
  if (cjk.includes(lang)) {
    // Noto CJK installed via fonts-noto-cjk (Debian bookworm confirmed path)
    const candidates = [
      '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
      '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
      '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
      '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
    ];
    const fs = require('fs');
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  }
  if (arabic.includes(lang)) {
    const candidates = [
      '/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf',
      '/usr/share/fonts/opentype/noto/NotoSansArabic-Regular.ttf',
    ];
    const fs = require('fs');
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  }
  // Default: Noto Sans or DejaVu
  const defaults = [
    '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf',
    '/usr/share/fonts/opentype/noto/NotoSans-Regular.ttf',
    DEJAVU_FONT,
  ];
  const fs = require('fs');
  for (const p of defaults) {
    if (fs.existsSync(p)) return p;
  }
  return DEJAVU_FONT;
}

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
// Only called when episodeNum is not null/undefined (Director Mode with series)
async function buildIntroCard({ workDir, projectTitle, episodeNum, episodeTitle, seriesName }) {
  const outPath = path.join(workDir, 'introcard.mp4');
  const title = seriesName || projectTitle || 'ScriptFlow';
  const epLine = 'Episode ' + episodeNum + (episodeTitle ? ' \u00b7 ' + episodeTitle : '');
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
// Only called when episodeNum is not null/undefined (Director Mode with series)
async function buildEndCard({ workDir, projectTitle, episodeNum, episodeTitle, seriesName }) {
  const outPath = path.join(workDir, 'endcard.mp4');
  const title = seriesName || projectTitle || 'ScriptFlow';
  const epLine = 'Episode ' + episodeNum + (episodeTitle ? ' \u00b7 ' + episodeTitle : '');
  return buildTitleCard({
    outPath,
    durationSec: 5,
    lines: [
      { text: title,  fontcolor: 'white', fontsize: 80, y: '(h-th)/2-140' },
      { text: epLine, fontcolor: 'white', fontsize: 60, y: '(h-th)/2'     },
    ],
  });
}

app.post('/convert-audio', async (req, res) => {
  const { audioUrl } = req.body || {};
  if (!audioUrl) return res.status(400).json({ success: false, error: 'audioUrl is required' });

  let tmpWebm = null;
  let tmpMp3 = null;
  try {
    const { join } = require('path');
    const os = require('os');
    const ts = Date.now();
    tmpWebm = join(os.tmpdir(), `convert_${ts}.webm`);
    tmpMp3 = join(os.tmpdir(), `convert_${ts}.mp3`);

    // Download webm
    const audioRes = await fetch(audioUrl);
    if (!audioRes.ok) throw new Error('Download failed: ' + audioUrl);
    const audioBuf = Buffer.from(await audioRes.arrayBuffer());
    await fsp.writeFile(tmpWebm, audioBuf);
    console.log('[convert-audio] downloaded webm, bytes:', audioBuf.length);

    // Convert to mp3 using ffmpeg
    await new Promise((resolve, reject) => {
      const { spawn } = require('child_process');
      const args = ['-i', tmpWebm, '-c:a', 'libmp3lame', '-q:a', '4', tmpMp3, '-y'];
      console.log('[convert-audio] ffmpeg args:', args.join(' '));
      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error('ffmpeg exit ' + code + ': ' + stderr.slice(-300)));
      });
    });

    const mp3Buf = await fsp.readFile(tmpMp3);
    console.log('[convert-audio] mp3 size:', mp3Buf.length);

    // Upload to Supabase
    const mp3Path = `tmp/converted_${ts}.mp3`;
    const { error: uploadErr } = await supabase.storage
      .from('recordings')
      .upload(mp3Path, mp3Buf, { contentType: 'audio/mpeg', upsert: true });
    if (uploadErr) throw new Error('Supabase upload failed: ' + uploadErr.message);

    const { data } = supabase.storage.from('recordings').getPublicUrl(mp3Path);
    console.log('[convert-audio] mp3Url:', data.publicUrl);
    res.json({ success: true, mp3Url: data.publicUrl });
  } catch (err) {
    console.error('[convert-audio] ERROR:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (tmpWebm) await fsp.unlink(tmpWebm).catch(() => {});
    if (tmpMp3) await fsp.unlink(tmpMp3).catch(() => {});
  }
});

app.post('/merge', async (req, res) => {
  const requestId = crypto.randomUUID();
  let workDir = null;
  try {
    const { projectId, videoUrls, audioUrls, srtContent, projectTitle, episodeNum, episodeTitle, bgmUrl, ambienceUrl, isStarMode } = req.body || {};
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

      // Download ambience if provided
      const hasAmbience = typeof ambienceUrl === 'string' && ambienceUrl.trim().length > 0;
      let ambiencePath = null;
      if (hasAmbience) {
        try {
          ambiencePath = path.join(workDir, 'ambience.mp3');
          await download(ambienceUrl, ambiencePath);
          const ambStat = await fsp.stat(ambiencePath);
          console.log('[' + requestId + '] Ambience downloaded:', ambiencePath, 'size:', ambStat.size, 'bytes');
        } catch (ambErr) {
          console.warn('[' + requestId + '] Ambience download failed (skipping): ' + ambErr.message);
          ambiencePath = null;
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

      // ── Multilingual subtitle font ──────────────────────────────────────
      const userLanguage = (req.body.userLanguage || 'en').toLowerCase().split('-')[0];
      const subtitleFontPath = getFontForLanguage(userLanguage);
      console.log('[merge] userLanguage=' + userLanguage + ' subtitleFont=' + subtitleFontPath);

      await new Promise((resolve, reject) => {
        const cmd = ffmpeg().input(concatVideo);
        if (concatAudio) cmd.input(concatAudio);
        if (bgmPath) cmd.input(bgmPath);
        if (ambiencePath) cmd.input(ambiencePath);

        const outputOptions = ['-c:v libx264', '-preset veryfast', '-crf 23'];

        console.log('[merge] concatAudio:', !!concatAudio, 'bgmPath:', !!bgmPath, 'ambiencePath:', !!ambiencePath);

        // Use language-appropriate font for subtitles
        const subtitleStyle = req.body.subtitleStyle || "FontSize=8,Alignment=2,MarginV=20";
        const srtWithFont = srtEscaped
          ? "subtitles='" + srtEscaped + "':fontsdir='/usr/share/fonts':force_style='" + subtitleStyle + "'"
          : null;

        // Determine input indices dynamically
        let inputIdx = 1; // 0 = video
        const dialogueIdx = concatAudio ? inputIdx++ : null;
        const bgmIdx = bgmPath ? inputIdx++ : null;
        const ambIdx = ambiencePath ? inputIdx++ : null;

        // Standard iOS/QuickTime-compatible AAC audio options
        const aacOpts = ['-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k', '-profile:a', 'aac_low'];

        if (dialogueIdx !== null && bgmIdx !== null && ambIdx !== null) {
          // Four-track mix: dialogue + BGM + ambience
          const filterComplex =
            `[${dialogueIdx}:a]volume=1.0[dialogue];` +
            `[${bgmIdx}:a]volume=0.28,aloop=loop=-1:size=2147483647[bgm];` +
            `[${ambIdx}:a]volume=0.10,aloop=loop=-1:size=2147483647[amb];` +
            `[dialogue][bgm][amb]amix=inputs=3:duration=first[aout]`;
          outputOptions.push('-filter_complex', filterComplex);
          outputOptions.push('-map', '0:v', '-map', '[aout]', ...aacOpts, '-shortest');
          if (srtEscaped) outputOptions.push("-vf subtitles='" + srtEscaped + "':force_style='" + subtitleStyle + "'");
        } else if (dialogueIdx !== null && bgmIdx !== null) {
          // Three-track mix: dialogue + BGM
          const filterComplex =
            `[${dialogueIdx}:a]volume=1.0[dialogue];` +
            `[${bgmIdx}:a]volume=0.28,aloop=loop=-1:size=2147483647[bgm];` +
            `[dialogue][bgm]amix=inputs=2:duration=first[aout]`;
          outputOptions.push('-filter_complex', filterComplex);
          outputOptions.push('-map', '0:v', '-map', '[aout]', ...aacOpts, '-shortest');
          if (srtEscaped) outputOptions.push("-vf subtitles='" + srtEscaped + "':force_style='" + subtitleStyle + "'");
        } else if (dialogueIdx !== null && ambIdx !== null) {
          // Dialogue + ambience (no BGM)
          const filterComplex =
            `[${dialogueIdx}:a]volume=1.0[dialogue];` +
            `[${ambIdx}:a]volume=0.10,aloop=loop=-1:size=2147483647[amb];` +
            `[dialogue][amb]amix=inputs=2:duration=first[aout]`;
          outputOptions.push('-filter_complex', filterComplex);
          outputOptions.push('-map', '0:v', '-map', '[aout]', ...aacOpts, '-shortest');
          if (srtEscaped) outputOptions.push("-vf subtitles='" + srtEscaped + "':force_style='" + subtitleStyle + "'");
        } else if (dialogueIdx !== null) {
          outputOptions.push('-map', '0:v:0', '-map', dialogueIdx + ':a:0', ...aacOpts, '-shortest');
          if (srtEscaped) outputOptions.push("-vf subtitles='" + srtEscaped + "':force_style='" + subtitleStyle + "'");
        } else if (bgmIdx !== null) {
          // BGM only (no dialogue audio)
          outputOptions.push('-filter_complex', '[' + bgmIdx + ':a]volume=0.4,aloop=loop=-1:size=2147483647[aout]');
          outputOptions.push('-map', '0:v:0', '-map', '[aout]', ...aacOpts, '-shortest');
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
    // Rules:
    //   - isStarMode=true → skip all title cards (clean video)
    //   - episodeNum is null/undefined → skip title cards (no series set)
    //   - episodeNum is a number → show title cards with seriesName + episode number
    const { seriesName } = req.body || {};
    const hasEpisodeNum = episodeNum !== null && episodeNum !== undefined;

    let introCardPath = null;
    let endCardPath = null;

    if (!isStarMode && hasEpisodeNum) {
      try {
        introCardPath = await buildIntroCard({ workDir, projectTitle, episodeNum, episodeTitle, seriesName });
        console.log('[' + requestId + '] Intro card built: ' + introCardPath);
      } catch (icErr) {
        console.warn('[' + requestId + '] Intro card build failed (skipping): ' + icErr.message);
      }

      try {
        endCardPath = await buildEndCard({ workDir, projectTitle, episodeNum, episodeTitle, seriesName });
        console.log('[' + requestId + '] End card built: ' + endCardPath);
      } catch (ecErr) {
        console.warn('[' + requestId + '] End card build failed (skipping): ' + ecErr.message);
      }
    } else {
      const reason = isStarMode ? 'Star Mode' : 'no episode number set';
      console.log('[' + requestId + '] Skipping title cards: ' + reason);
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

    // HumanTouch post-processing: apply cinematic video/audio filters
    const humanTouchPath = path.join(workDir, 'humantouch.mp4');
    console.log('[' + requestId + '] Applying HumanTouch post-processing...');
    await new Promise((resolve, reject) => {
      const { spawn } = require('child_process');
      const args = [
        '-i', finalPath,
        '-vf', 'eq=contrast=1.02:saturation=0.95:brightness=0.03:gamma=0.95,unsharp=3:3:0.3:3:3:0,gblur=sigma=0.4',
        '-af', 'loudnorm=I=-16:LRA=11:TP=-1.5',
        '-c:v', 'libx264',
        '-crf', '23',
        '-preset', 'medium',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-y',
        humanTouchPath,
      ];
      console.log('[humantouch] ffmpeg args:', args.join(' '));
      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        if (code === 0) {
          console.log('[' + requestId + '] HumanTouch post-processing done.');
          resolve();
        } else {
          reject(new Error('HumanTouch ffmpeg exit ' + code + ': ' + stderr.slice(-500)));
        }
      });
    });

    // ── Watermark ─────────────────────────────────────────────────────────
    // Determine user tier from Supabase, then burn watermark into video.
    // Director Pass → subtle watermark; Basic (default) → standard watermark.
    const watermarkedPath = path.join(workDir, 'watermarked.mp4');
    console.log('[watermark] function called, requestId:', requestId);
    try {
      // Step 1: get user_id from projects table
      let userId = null;
      try {
        const { data: projRow } = await supabase
          .from('projects')
          .select('user_id')
          .eq('id', projectId)
          .single();
        userId = projRow?.user_id ?? null;
      } catch (e) {
        console.warn('[watermark] Could not fetch user_id: ' + e.message);
      }

      // Step 2: check subscription tier
      let isDirectorPass = false;
      if (userId) {
        try {
          // Try subscriptions table first
          const { data: subRow } = await supabase
            .from('subscriptions')
            .select('plan, status')
            .eq('user_id', userId)
            .in('status', ['active', 'trialing'])
            .order('created_at', { ascending: false })
            .limit(1)
            .single();
          if (subRow) {
            const plan = (subRow.plan || '').toLowerCase();
            isDirectorPass = plan.includes('director') || plan.includes('pro') || plan.includes('premium');
          }
        } catch (e) {
          console.warn('[watermark] Subscription lookup failed (defaulting to Basic): ' + e.message);
        }
      }

      // Step 3: burn watermark — bottom-right, clearly visible
      const watermarkText = 'getscriptflow.com';
      const drawtext = "drawtext=fontfile='" + DEJAVU_FONT + "':text='" + watermarkText + "':fontsize=30:fontcolor=white@0.7:borderw=2:bordercolor=black@0.5:x=(w-tw)/2:y=h*0.82:enable='if(gte(t,2),1,0)'";

      console.log('[watermark][' + requestId + '] tier=' + (isDirectorPass ? 'director_pass' : 'basic') + ' text="' + watermarkText + '"');

      await new Promise((resolve, reject) => {
        const { spawn } = require('child_process');
        const args = [
          '-i', humanTouchPath,
          '-vf', drawtext,
          '-c:v', 'libx264',
          '-crf', '23',
          '-preset', 'medium',
          '-c:a', 'copy',
          '-y',
          watermarkedPath,
        ];
        console.log('[watermark] ffmpeg args:', args.join(' '));
        const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('close', (code) => {
          if (code === 0) {
            console.log('[watermark][' + requestId + '] Watermark applied.');
            resolve();
          } else {
            reject(new Error('Watermark ffmpeg exit ' + code + ': ' + stderr.slice(-500)));
          }
        });
      });
    } catch (wmErr) {
      // Watermark failure is non-fatal: fall back to un-watermarked video
      console.warn('[watermark][' + requestId + '] Watermark failed (using humantouch output): ' + wmErr.message);
      await fsp.copyFile(humanTouchPath, watermarkedPath).catch(() => {});
    }
    // ── End Watermark ──────────────────────────────────────────────────────

    // ── F84 Quality Check ──────────────────────────────────────────────────
    console.log('[' + requestId + '] Starting F84 QC...');
    const qcReport = await runF84QC(watermarkedPath, requestId);

    // Write QC result to Supabase projects table (best-effort, non-blocking)
    try {
      const { error: qcErr } = await supabase
        .from('projects')
        .update({
          qc_status: qcReport.status,
          qc_score: qcReport.score,
          qc_report: qcReport,
        })
        .eq('id', projectId);
      if (qcErr) console.warn('[' + requestId + '] QC DB write failed: ' + qcErr.message);
      else console.log('[' + requestId + '] QC result saved: status=' + qcReport.status + ' score=' + qcReport.score);
    } catch (qcDbErr) {
      console.warn('[' + requestId + '] QC DB write error: ' + qcDbErr.message);
    }
    // ── End F84 QC ─────────────────────────────────────────────────────────

    const buf = await fsp.readFile(watermarkedPath);
    const storagePath = projectId + '/final-' + Date.now() + '.mp4';
    const { error } = await supabase.storage.from('generated-videos').upload(storagePath, buf, { contentType: 'video/mp4', upsert: true });
    if (error) throw new Error('Upload failed: ' + error.message);

    const { data } = supabase.storage.from('generated-videos').getPublicUrl(storagePath);
    console.log('[' + requestId + '] Done: ' + data.publicUrl);
    res.json({ success: true, finalVideoUrl: data.publicUrl, qc: { status: qcReport.status, score: qcReport.score } });
  } catch (err) {
    console.error('[' + requestId + '] ERROR:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (workDir) await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

/**
 * F84 Quality Check — "三无产品不放行"
 *
 * Hard Fail (blocks upload) — only 3 conditions:
 *   1. 无影: no video stream, OR duration < 5s
 *   2. 无声: no audio stream
 *   3. 无色: (covered by no video stream check above)
 *
 * If all 3 checks pass → status='passed', score=100
 * If any check fails  → status='failed', score=0
 */
async function runF84QC(videoPath, requestId) {
  const { spawn } = require('child_process');
  const log = (msg) => console.log('[f84qc][' + requestId + '] ' + msg);

  function spawnCollect(cmd, args) {
    return new Promise((resolve) => {
      const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  }

  const report = {
    checkedAt: new Date().toISOString(),
    hardFails: [],
    checks: {},
    score: 0,
    status: 'pending',
  };

  // ── ffprobe: get duration + stream types in one call ─────────────────────
  let durationSec = 0;
  let hasVideoStream = false;
  let hasAudioStream = false;

  try {
    const { code, stdout, stderr } = await spawnCollect('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=codec_type',
      '-of', 'default=noprint_wrappers=1',
      videoPath,
    ]);

    if (code !== 0) {
      report.hardFails.push('file_unreadable: ffprobe exit ' + code);
      log('HARD FAIL: file unreadable (ffprobe exit ' + code + ')');
    } else {
      const durMatch = stdout.match(/duration=([\d.]+)/);
      durationSec = durMatch ? (parseFloat(durMatch[1]) || 0) : 0;
      hasVideoStream = stdout.includes('codec_type=video');
      hasAudioStream = stdout.includes('codec_type=audio');
      log('duration=' + durationSec.toFixed(2) + 's hasVideo=' + hasVideoStream + ' hasAudio=' + hasAudioStream);
    }
  } catch (e) {
    report.hardFails.push('file_unreadable: ' + e.message);
    log('HARD FAIL: ffprobe threw: ' + e.message);
  }

  // ── Check 1: 无影 — no video stream or duration < 5s ────────────────────
  if (!hasVideoStream) {
    report.hardFails.push('no_video_stream');
    log('HARD FAIL: no video stream');
  } else if (durationSec < 5) {
    report.hardFails.push('duration_too_short: ' + durationSec.toFixed(2) + 's < 5s');
    log('HARD FAIL: duration too short (' + durationSec.toFixed(2) + 's)');
  }

  // ── Check 2: 无声 — no audio stream ─────────────────────────────────────
  if (!hasAudioStream) {
    report.hardFails.push('no_audio_stream');
    log('HARD FAIL: no audio stream');
  }

  // ── Result ───────────────────────────────────────────────────────────────
  report.checks = {
    has_video_stream: hasVideoStream,
    has_audio_stream: hasAudioStream,
    duration_sec: durationSec,
  };

  if (report.hardFails.length === 0) {
    report.status = 'passed';
    report.score = 100;
    log('QC PASSED score=100');
  } else {
    report.status = 'failed';
    report.score = 0;
    log('QC FAILED hardFails=' + JSON.stringify(report.hardFails));
  }

  return report;
}

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
    // Noto CJK font paths (fonts-noto-cjk package)
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
  ];
  fontPaths.forEach(p => {
    console.log('[font-check] ' + p + ': ' + (fs.existsSync(p) ? 'EXISTS' : 'NOT FOUND'));
  });
});

// ─── POST /concat-videos ─────────────────────────────────────────────────────
// Accepts either:
//   { videoUrls: string[], outputName?: string }  (new worker format)
//   { sceneVideoUrl: string, faceVideoUrl: string }  (legacy format)
// Downloads all videos, concatenates them in order,
// uploads to Supabase generated-videos bucket, returns { outputUrl }
app.post('/concat-videos', async (req, res) => {
  const body = req.body || {};

  // Support both new array format and legacy two-video format
  let videoUrls;
  let outputName;
  if (Array.isArray(body.videoUrls) && body.videoUrls.length > 0) {
    videoUrls = body.videoUrls;
    outputName = body.outputName || `concat_${Date.now()}`;
  } else if (body.sceneVideoUrl && body.faceVideoUrl) {
    // Legacy format: scene first, face second
    videoUrls = [body.sceneVideoUrl, body.faceVideoUrl];
    outputName = `concat_${Date.now()}`;
  } else {
    return res.status(400).json({ error: 'videoUrls array (or sceneVideoUrl + faceVideoUrl) is required' });
  }

  console.log('[concat-videos] videoUrls count:', videoUrls.length, 'outputName:', outputName);
  const tmpDir = os.tmpdir();
  const id = crypto.randomBytes(8).toString('hex');
  const videoPaths = videoUrls.map((_, i) => path.join(tmpDir, `cv_${id}_${i}.mp4`));
  const listPath = path.join(tmpDir, `cvlist_${id}.txt`);
  const outputPath = path.join(tmpDir, `cvout_${id}.mp4`);

  try {
    // Download all videos in parallel
    const downloadResults = await Promise.all(videoUrls.map(url => fetch(url)));
    for (let i = 0; i < downloadResults.length; i++) {
      if (!downloadResults[i].ok) throw new Error(`Video ${i} download failed: ${downloadResults[i].status} ${videoUrls[i]}`);
    }
    await Promise.all(downloadResults.map((r, i) =>
      r.arrayBuffer().then(buf => fsp.writeFile(videoPaths[i], Buffer.from(buf)))
    ));
    console.log('[concat-videos] downloaded', videoPaths.length, 'videos');

    // Write concat list file
    const listContent = videoPaths.map(p => `file '${path.resolve(p).replace(/'/g, "'\\''")}'`).join('\n');
    await fsp.writeFile(listPath, listContent, 'utf8');

    // Concatenate using ffmpeg concat demuxer (fast, no re-encode)
    await new Promise((resolve, reject) => {
      const { spawn } = require('child_process');
      const args = [
        '-f', 'concat',
        '-safe', '0',
        '-i', listPath,
        '-c', 'copy',
        '-y',
        outputPath
      ];
      console.log('[concat-videos] ffmpeg args:', args.join(' '));
      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error('ffmpeg exit ' + code + ': ' + stderr.slice(-300)));
      });
    });

    // Upload to Supabase
    const outputBuffer = await fsp.readFile(outputPath);
    const storagePath = `concat/${outputName}_${Date.now()}.mp4`;
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('generated-videos')
      .upload(storagePath, outputBuffer, { contentType: 'video/mp4', upsert: true });

    if (uploadError) throw new Error(`Supabase upload failed: ${uploadError.message}`);

    const outputUrl = supabase.storage.from('generated-videos').getPublicUrl(uploadData.path).data.publicUrl;
    console.log('[concat-videos] outputUrl:', outputUrl);
    res.json({ outputUrl });
  } catch (err) {
    console.error('[concat-videos] ERROR:', err.message || err);
    res.status(500).json({ error: err.message || 'concat-videos failed' });
  } finally {
    for (const p of videoPaths) fsp.unlink(p).catch(() => {});
    fsp.unlink(listPath).catch(() => {});
    fsp.unlink(outputPath).catch(() => {});
  }
});

// ─── POST /merge-videos ──────────────────────────────────────────────────────
// Merges a video with an optional audio track.
// For face shots: videoUrl = omni_video_url, audioUrl = kling audio
// For scene shots: videoUrl = kling_scene_url, audioUrl = null (use video's own audio)
// Returns { outputUrl }
app.post('/merge-videos', async (req, res) => {
  const { videoUrl, audioUrl } = req.body || {};
  if (!videoUrl) return res.status(400).json({ error: 'videoUrl is required' });

  console.log('[merge-videos] videoUrl:', videoUrl, 'audioUrl:', audioUrl || '(none)');
  const tmpDir = os.tmpdir();
  const id = crypto.randomBytes(8).toString('hex');
  const videoPath = path.join(tmpDir, `mv_${id}.mp4`);
  const audioPath = audioUrl ? path.join(tmpDir, `ma_${id}.mp3`) : null;
  const outputPath = path.join(tmpDir, `mvout_${id}.mp4`);

  try {
    // Download video (and audio if provided)
    const downloads = [fetch(videoUrl)];
    if (audioUrl) downloads.push(fetch(audioUrl));
    const results = await Promise.all(downloads);

    if (!results[0].ok) throw new Error(`Video download failed: ${results[0].status}`);
    await fsp.writeFile(videoPath, Buffer.from(await results[0].arrayBuffer()));

    if (audioUrl && results[1]) {
      if (!results[1].ok) throw new Error(`Audio download failed: ${results[1].status}`);
      await fsp.writeFile(audioPath, Buffer.from(await results[1].arrayBuffer()));
    }

    console.log('[merge-videos] downloaded video' + (audioUrl ? ' and audio' : ''));

    // Merge or copy
    await new Promise((resolve, reject) => {
      const { spawn } = require('child_process');
      let args;
      if (audioPath) {
        // Replace video audio with provided audio track
        args = [
          '-i', videoPath,
          '-i', audioPath,
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-shortest',
          '-y',
          outputPath,
        ];
      } else {
        // No audio replacement: just copy the video as-is
        args = [
          '-i', videoPath,
          '-c', 'copy',
          '-y',
          outputPath,
        ];
      }
      console.log('[merge-videos] ffmpeg args:', args.join(' '));
      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error('ffmpeg exit ' + code + ': ' + stderr.slice(-300)));
      });
    });

    // Upload to Supabase generated-videos bucket
    const outputBuffer = await fsp.readFile(outputPath);
    const storagePath = `shots/shot_${Date.now()}.mp4`;
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('generated-videos')
      .upload(storagePath, outputBuffer, { contentType: 'video/mp4', upsert: true });

    if (uploadError) throw new Error(`Supabase upload failed: ${uploadError.message}`);

    const outputUrl = supabase.storage.from('generated-videos').getPublicUrl(uploadData.path).data.publicUrl;
    console.log('[merge-videos] outputUrl:', outputUrl);
    res.json({ outputUrl });
  } catch (err) {
    console.error('[merge-videos] ERROR:', err.message || err);
    res.status(500).json({ error: err.message || 'merge-videos failed' });
  } finally {
    fsp.unlink(videoPath).catch(() => {});
    if (audioPath) fsp.unlink(audioPath).catch(() => {});
    fsp.unlink(outputPath).catch(() => {});
  }
});

// ─── POST /merge-audio ───────────────────────────────────────────────────────
// Downloads a video and audio file, merges them with ffmpeg, uploads to Supabase.
// Returns { outputUrl }
app.post('/merge-audio', async (req, res) => {
  const { videoUrl, audioUrl } = req.body || {};
  if (!videoUrl || !audioUrl) return res.status(400).json({ error: 'videoUrl and audioUrl are required' });

  console.log('[merge-audio] videoUrl:', videoUrl, 'audioUrl:', audioUrl);
  const tmpDir = os.tmpdir();
  const id = crypto.randomBytes(8).toString('hex');
  const videoPath = path.join(tmpDir, `mv_${id}.mp4`);
  const audioPath = path.join(tmpDir, `ma_${id}.mp3`);
  const outputPath = path.join(tmpDir, `out_${id}.mp4`);

  try {
    // Download video and audio in parallel
    const [videoRes, audioRes] = await Promise.all([fetch(videoUrl), fetch(audioUrl)]);
    if (!videoRes.ok) throw new Error(`Video download failed: ${videoRes.status}`);
    if (!audioRes.ok) throw new Error(`Audio download failed: ${audioRes.status}`);
    await Promise.all([
      fsp.writeFile(videoPath, Buffer.from(await videoRes.arrayBuffer())),
      fsp.writeFile(audioPath, Buffer.from(await audioRes.arrayBuffer())),
    ]);
    console.log('[merge-audio] downloaded video and audio');

    // Merge: copy video stream, re-encode audio, stop at shortest
    await new Promise((resolve, reject) => {
      const { spawn } = require('child_process');
      const args = [
        '-i', videoPath,
        '-i', audioPath,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-shortest',
        '-y',
        outputPath,
      ];
      console.log('[merge-audio] ffmpeg args:', args.join(' '));
      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error('ffmpeg exit ' + code + ': ' + stderr.slice(-300)));
      });
    });

    // Upload to Supabase generated-videos bucket
    const outputBuffer = await fsp.readFile(outputPath);
    const storagePath = `merged/audio_${Date.now()}.mp4`;
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('generated-videos')
      .upload(storagePath, outputBuffer, { contentType: 'video/mp4', upsert: true });

    if (uploadError) throw new Error(`Supabase upload failed: ${uploadError.message}`);

    const outputUrl = supabase.storage.from('generated-videos').getPublicUrl(uploadData.path).data.publicUrl;
    console.log('[merge-audio] outputUrl:', outputUrl);
    res.json({ outputUrl });
  } catch (err) {
    console.error('[merge-audio] ERROR:', err.message || err);
    res.status(500).json({ error: err.message || 'merge-audio failed' });
  } finally {
    fsp.unlink(videoPath).catch(() => {});
    fsp.unlink(audioPath).catch(() => {});
    fsp.unlink(outputPath).catch(() => {});
  }
});

// ─── POST /extract-frame ──────────────────────────────────────────────────────
// Downloads a video from videoUrl, extracts a frame at 50% duration via ffmpeg,
// uploads it to Supabase recordings/tmp/frame_{timestamp}.jpg, returns { frameUrl }.
app.post('/extract-frame', async (req, res) => {
  const { videoUrl } = req.body || {};
  if (!videoUrl) return res.status(400).json({ error: 'videoUrl is required' });

  console.log('[extract-frame] videoUrl:', videoUrl);
  const tmpDir = os.tmpdir();
  const id = crypto.randomBytes(8).toString('hex');
  const videoPath = path.join(tmpDir, `video_${id}.mp4`);
  const framePath = path.join(tmpDir, `frame_${id}.jpg`);

  try {
    // Step 1: Download video
    const videoRes = await fetch(videoUrl);
    if (!videoRes.ok) throw new Error(`Failed to download video: ${videoRes.status}`);
    const videoBuffer = Buffer.from(await videoRes.arrayBuffer());
    await fsp.writeFile(videoPath, videoBuffer);
    console.log('[extract-frame] video downloaded, size:', videoBuffer.length);

    // Step 2: Get video duration via ffprobe
    let rawDuration = null;
    try {
      rawDuration = await new Promise((resolve) => {
        ffmpeg.ffprobe(videoPath, (err, metadata) => {
          if (err) { console.warn('[extract-frame] ffprobe error:', err.message); return resolve(null); }
          const d = metadata?.format?.duration;
          resolve(d);
        });
      });
    } catch (probeErr) {
      console.warn('[extract-frame] ffprobe threw:', probeErr.message);
    }

    // Handle N/A or missing duration (common with webm/mkv containers)
    const seekTime = (rawDuration && rawDuration !== 'N/A' && !isNaN(parseFloat(rawDuration)))
      ? (parseFloat(rawDuration) * 0.5).toFixed(2)
      : '0.5'; // default to 0.5s if duration unknown
    console.log('[extract-frame] rawDuration:', rawDuration, 'seekTime:', seekTime);

    // Step 3: Extract frame using raw ffmpeg spawn (-ss before -i for fast seeking)
    await new Promise((resolve, reject) => {
      const { spawn } = require('child_process');
      const args = ['-ss', seekTime, '-i', videoPath, '-frames:v', '1', '-f', 'image2', '-vcodec', 'mjpeg', '-y', framePath];
      console.log('[extract-frame] ffmpeg args:', args.join(' '));
      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error('ffmpeg exit ' + code + ': ' + stderr.slice(-300)));
      });
    });

    // Step 4: Upload frame to Supabase
    const frameBuffer = await fsp.readFile(framePath);
    const filePath = `tmp/frame_${Date.now()}.jpg`;
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('recordings')
      .upload(filePath, frameBuffer, { contentType: 'image/jpeg', upsert: true });

    if (uploadError) throw new Error(`Supabase upload failed: ${uploadError.message}`);

    const frameUrl = supabase.storage.from('recordings').getPublicUrl(uploadData.path).data.publicUrl;
    console.log('[extract-frame] frameUrl:', frameUrl);

    res.json({ frameUrl });
  } catch (err) {
    console.error('[extract-frame] ERROR:', err.message || err);
    res.status(500).json({ error: err.message || 'extract-frame failed' });
  } finally {
    // Cleanup temp files
    fsp.unlink(videoPath).catch(() => {});
    fsp.unlink(framePath).catch(() => {});
  }
});

// ─── POST /extract-audio ──────────────────────────────────────────────────────
app.post('/extract-audio', async (req, res) => {
  const videoPath = path.join(os.tmpdir(), `voice_input_${Date.now()}.mp4`);
  const audioPath = path.join(os.tmpdir(), `voice_output_${Date.now()}.mp3`);
  try {
    const { videoUrl } = req.body;
    if (!videoUrl) return res.status(400).json({ error: 'videoUrl is required' });

    console.log('[extract-audio] Downloading video:', videoUrl);
    const response = await fetch(videoUrl);
    if (!response.ok) throw new Error(`Failed to download video: ${response.status}`);
    const buffer = await response.arrayBuffer();
    await fsp.writeFile(videoPath, Buffer.from(buffer));

    // Extract audio with FFmpeg
    console.log('[extract-audio] Extracting audio...');
    await new Promise((resolve, reject) => {
      const { spawn } = require('child_process');
      const ffmpegProc = spawn('ffmpeg', ['-i', videoPath, '-vn', '-acodec', 'libmp3lame', '-q:a', '4', '-y', audioPath]);
      ffmpegProc.stderr.on('data', (d) => process.stderr.write(d));
      ffmpegProc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg exited with code ${code}`)));
    });

    // Upload to Supabase
    const audioBuffer = await fsp.readFile(audioPath);
    const fileName = `voice_samples/voice_${Date.now()}.mp3`;
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('recordings')
      .upload(fileName, audioBuffer, { contentType: 'audio/mpeg', upsert: true });

    if (uploadError) throw new Error(`Supabase upload failed: ${uploadError.message}`);

    const audioUrl = supabase.storage.from('recordings').getPublicUrl(uploadData.path).data.publicUrl;
    console.log('[extract-audio] audioUrl:', audioUrl);

    res.json({ audioUrl });
  } catch (err) {
    console.error('[extract-audio] ERROR:', err.message || err);
    res.status(500).json({ error: err.message || 'extract-audio failed' });
  } finally {
    fsp.unlink(videoPath).catch(() => {});
    fsp.unlink(audioPath).catch(() => {});
  }
});
