const express = require('express');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const Replicate = require('replicate');

// Check Replicate API token at startup
console.log('[startup] REPLICATE_API_TOKEN exists:', 
  !!process.env.REPLICATE_API_TOKEN,
  'starts with r8_:', 
  process.env.REPLICATE_API_TOKEN?.startsWith('r8_')
);

// Use system ffmpeg (installed via nixpacks.toml)
// fluent-ffmpeg will auto-detect from PATH

// Initialize Replicate for emotion generation
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN
});

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = Number(process.env.PORT || 3000);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false },
    realtime: {
      transport: ws
    }
  }
);

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

/** Sanitize subtitle text before passing to FFmpeg drawtext */
function sanitizeSubtitle(text) {
  return String(text || '')
    .replace(/'/g, '')
    .replace(/"/g, '')
    .replace(/\\/g, '')
    .replace(/:/g, ' ')
    .replace(/[^\w\s\.,!?]/g, '')
    .trim();
}

const DEJAVU_FONT = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc';

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
          // Mix original video audio with BGM using sidechain compression
          outputOptions.push('-filter_complex',
            '[' + bgmIdx + ':a]volume=0.4,aloop=loop=-1:size=2147483647[bgm];' +
            '[bgm][0:a]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=300[bgm_ducked];' +
            '[0:a]volume=0.85[orig];' +
            '[orig][bgm_ducked]amix=inputs=2:duration=longest[aout]'
          );
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
    // Check if movie is paid - if paid, skip watermark entirely
    const watermarkedPath = path.join(workDir, 'watermarked.mp4');
    console.log('[watermark] function called, requestId:', requestId);
    
    let isPaidMovie = false;
    try {
      // Check if this is a paid movie from movies table
      const { data: movieRow } = await supabase
        .from('movies')
        .select('paid')
        .eq('id', projectId)
        .single();
      isPaidMovie = movieRow?.paid === true;
      console.log('[watermark] Movie paid status:', isPaidMovie);
    } catch (e) {
      console.warn('[watermark] Could not check paid status: ' + e.message);
    }

    // If paid, skip watermark entirely - just copy the file
    if (isPaidMovie) {
      console.log('[watermark][' + requestId + '] Paid movie - skipping watermark');
      try {
        await fsp.copyFile(humanTouchPath, watermarkedPath);
      } catch (copyErr) {
        console.warn('[watermark] Copy failed, using original path');
      }
    } else {
      // Unpaid/hook videos - apply watermark
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
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
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
  const { videoUrls, outputName, sceneVideoUrl, faceVideoUrl } = req.body || {};

  // Handle both new format (videoUrls array) and legacy format
  const urls = videoUrls ?? [sceneVideoUrl, faceVideoUrl].filter(Boolean);

  if (!urls || urls.length === 0) {
    return res.status(400).json({ error: 'videoUrls array is required' });
  }

  const resolvedOutputName = outputName || `concat_${Date.now()}`;

  const tmpDir = os.tmpdir();
  const id = crypto.randomBytes(8).toString('hex');
  const videoPaths = urls.map((_, i) => path.join(tmpDir, `cv_${id}_${i}.mp4`));
  const listPath = path.join(tmpDir, `cvlist_${id}.txt`);
  const outputPath = path.join(tmpDir, `cvout_${id}.mp4`);

  try {
    // Download all videos in parallel
    const downloadResults = await Promise.all(urls.map(url => fetch(url)));
    for (let i = 0; i < downloadResults.length; i++) {
      if (!downloadResults[i].ok) throw new Error(`Video ${i} download failed: ${downloadResults[i].status} ${urls[i]}`);
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
    const storagePath = `concat/${resolvedOutputName}_${Date.now()}.mp4`;
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
  const { videoUrl, imageUrl, audioUrl } = req.body || {};
  const sourceUrl = imageUrl || videoUrl;
  if (!sourceUrl || !audioUrl) return res.status(400).json({ error: 'videoUrl (or imageUrl) and audioUrl are required' });

  const isImage = sourceUrl.match(/\.(jpg|jpeg|png|gif|webp)$/i);
  console.log('[merge-audio] sourceUrl:', sourceUrl, 'audioUrl:', audioUrl, 'isImage:', !!isImage);
  const tmpDir = os.tmpdir();
  const id = crypto.randomBytes(8).toString('hex');
  const videoPath = path.join(tmpDir, `mv_${id}.mp4`);
  const audioPath = path.join(tmpDir, `ma_${id}.mp3`);
  const outputPath = path.join(tmpDir, `out_${id}.mp4`);

  try {
    // Download source (image or video) and audio in parallel
    const [videoRes, audioRes] = await Promise.all([fetch(sourceUrl), fetch(audioUrl)]);
    if (!videoRes.ok) throw new Error(`Source download failed: ${videoRes.status}`);
    if (!audioRes.ok) throw new Error(`Audio download failed: ${audioRes.status}`);
    await Promise.all([
      fsp.writeFile(videoPath, Buffer.from(await videoRes.arrayBuffer())),
      fsp.writeFile(audioPath, Buffer.from(await audioRes.arrayBuffer())),
    ]);
    console.log('[merge-audio] downloaded source and audio');

    // Merge: use different args depending on whether source is image or video
    await new Promise((resolve, reject) => {
      const { spawn } = require('child_process');
      let args;
      if (isImage) {
        args = [
          '-loop', '1',
          '-i', videoPath,
          '-i', audioPath,
          '-c:v', 'libx264',
          '-tune', 'stillimage',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-pix_fmt', 'yuv420p',
          '-shortest',
          '-y',
          outputPath,
        ];
      } else {
        args = [
          '-i', videoPath,
          '-i', audioPath,
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-shortest',
          '-y',
          outputPath,
        ];
      }
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

// ─── POST /hook ───────────────────────────────────────────────────────────────
// Creates a hook video with 3-photo expression switching or single photo
// Body: { photoUrls: [url1, url2, url3], photoUrl, bgmUrl, subtitles, colorGrade, movieId }
// Returns: { success, hookVideoUrl }
app.post('/hook', async (req, res) => {
  const fs = require('fs')
  const { photoUrl, photoUrls, bgmUrl, subtitles, colorGrade, movieId } = req.body
  
  // Accept either photoUrls array (3 photos) or photoUrl (single)
  const useMultiPhoto = Array.isArray(photoUrls) && photoUrls.length === 3
  if (!useMultiPhoto && !photoUrl) {
    return res.status(400).json({ success: false, error: 'photoUrl or photoUrls (3 items) is required' })
  }
  
  const id = require('uuid').v4()
  const workDir = `/tmp/${id}_hook`
  fs.mkdirSync(workDir, { recursive: true })
  
  const bgmPath = path.join(workDir, 'bgm.mp3')
  const outputPath = path.join(workDir, 'hook.mp4')
  
  try {
    // Download BGM with fallback
    let hasBgm = false
    if (bgmUrl) {
      try {
        const bgmRes = await fetch(bgmUrl)
        if (bgmRes.ok) {
          const bgmBuffer = await bgmRes.arrayBuffer()
          fs.writeFileSync(bgmPath, Buffer.from(bgmBuffer))
          hasBgm = true
          console.log('[hook] BGM downloaded successfully')
        } else {
          console.warn('[hook] BGM download failed (status ' + bgmRes.status + '), continuing without BGM')
        }
      } catch (bgmErr) {
        console.warn('[hook] BGM download error (continuing without BGM):', bgmErr.message)
      }
    } else {
      console.log('[hook] No BGM URL provided, continuing without BGM')
    }
    
    const line1 = (subtitles?.[0]?.text || 'This is you.').replace(/'/g, '').replace(/:/g, ' ')
    const line2 = (subtitles?.[1]?.text || 'But something is wrong.').replace(/'/g, '').replace(/:/g, ' ')
    const line3 = (subtitles?.[2]?.text || 'Watch your full movie.').replace(/'/g, '').replace(/:/g, ' ')
    
    const font = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'
    const { execSync } = require('child_process')
    
    if (useMultiPhoto) {
      // ─── 3-PHOTO MODE: Create 3 segments with different effects ───────────
      console.log('[hook] 3-photo mode: creating segments')
      
      // Download 3 photos
      const photo1Path = path.join(workDir, 'photo1.jpg')
      const photo2Path = path.join(workDir, 'photo2.jpg')
      const photo3Path = path.join(workDir, 'photo3.jpg')
      
      const [res1, res2, res3] = await Promise.all([
        fetch(photoUrls[0]),
        fetch(photoUrls[1]),
        fetch(photoUrls[2])
      ])
      
      fs.writeFileSync(photo1Path, Buffer.from(await res1.arrayBuffer()))
      fs.writeFileSync(photo2Path, Buffer.from(await res2.arrayBuffer()))
      fs.writeFileSync(photo3Path, Buffer.from(await res3.arrayBuffer()))
      
      // Segment paths
      const seg1Path = path.join(workDir, 'seg1.mp4')
      const seg2Path = path.join(workDir, 'seg2.mp4')
      const seg3Path = path.join(workDir, 'seg3.mp4')
      const concatPath = path.join(workDir, 'concat.mp4')
      
      // Simpler color grade filters for each segment
      const coldFilter = "eq=contrast=1.3:brightness=-0.08:saturation=0.8,vignette=PI/4"
      const warmFilter = "eq=contrast=1.1:brightness=0.05:saturation=1.2,vignette=PI/4"
      const epicFilter = "eq=contrast=1.5:brightness=-0.1:saturation=0.9,vignette=PI/4"
      
      // Segment 1: Neutral expression with slow zoom + cold grade (2.5s)
      console.log('[hook] Creating segment 1: neutral with slow zoom + cold grade')
      const seg1Filter = `scale=4000:-1,zoompan=z='min(zoom+0.005,1.5)':d=62:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920,${coldFilter},format=yuv420p`
      execSync(`ffmpeg -y -loop 1 -i "${photo1Path}" -t 2.5 -vf "${seg1Filter}" -r 25 -c:v libx264 -preset veryfast -crf 23 "${seg1Path}"`)
      
      // Segment 2: Surprised expression with faster zoom + warm grade (2.5s)
      console.log('[hook] Creating segment 2: surprised with faster zoom + warm grade')
      const seg2Filter = `scale=4000:-1,zoompan=z='min(zoom+0.008,1.5)':d=62:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920,${warmFilter},format=yuv420p`
      execSync(`ffmpeg -y -loop 1 -i "${photo2Path}" -t 2.5 -vf "${seg2Filter}" -r 25 -c:v libx264 -preset veryfast -crf 23 "${seg2Path}"`)
      
      // Segment 3: Fear expression with dramatic zoom + epic grade (2.5s)
      console.log('[hook] Creating segment 3: fear with dramatic zoom + epic grade')
      const seg3Filter = `scale=4000:-1,zoompan=z='min(zoom+0.005,1.5)':d=62:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920,${epicFilter},format=yuv420p`
      execSync(`ffmpeg -y -loop 1 -i "${photo3Path}" -t 2.5 -vf "${seg3Filter}" -r 25 -c:v libx264 -preset veryfast -crf 23 "${seg3Path}"`)
      
      // Concatenate 3 segments
      console.log('[hook] Concatenating 3 segments')
      const concatListPath = path.join(workDir, 'concat.txt')
      fs.writeFileSync(concatListPath, `file '${seg1Path}'\nfile '${seg2Path}'\nfile '${seg3Path}'`)
      execSync(`ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -c copy "${concatPath}"`)
      
      // Add subtitles and BGM to final video
      console.log('[hook] Adding subtitles' + (hasBgm ? ' and BGM' : ' (no BGM)'))
      if (hasBgm) {
        execSync(`ffmpeg -y -i "${concatPath}" -i "${bgmPath}" -filter_complex "[0:v]drawtext=fontfile=${font}:text='${line1}':fontcolor=white:fontsize=56:x=(w-text_w)/2:y=h*0.72:enable='between(t,0.5,2.5)',drawtext=fontfile=${font}:text='${line2}':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=h*0.75:enable='between(t,3,5)',drawtext=fontfile=${font}:text='${line3}':fontcolor=white:fontsize=52:x=(w-text_w)/2:y=h*0.78:enable='between(t,5.5,7.5)'[v];[1:a]volume=0.2[a]" -map "[v]" -map "[a]" -t 8 -r 25 -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 192k "${outputPath}"`)
      } else {
        // No BGM: add subtitles only with silent audio
        execSync(`ffmpeg -y -i "${concatPath}" -f lavfi -i anullsrc=r=48000:cl=stereo -filter_complex "[0:v]drawtext=fontfile=${font}:text='${line1}':fontcolor=white:fontsize=56:x=(w-text_w)/2:y=h*0.72:enable='between(t,0.5,2.5)',drawtext=fontfile=${font}:text='${line2}':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=h*0.75:enable='between(t,3,5)',drawtext=fontfile=${font}:text='${line3}':fontcolor=white:fontsize=52:x=(w-text_w)/2:y=h*0.78:enable='between(t,5.5,7.5)'[v]" -map "[v]" -map 1:a -t 8 -r 25 -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 192k "${outputPath}"`)
      }
      
    } else {
      // ─── SINGLE PHOTO MODE: Use existing logic ────────────────────────────
      console.log('[hook] Single photo mode')
      const photoPath = path.join(workDir, 'photo.jpg')
      
      const photoRes = await fetch(photoUrl)
      const photoBuffer = await photoRes.arrayBuffer()
      fs.writeFileSync(photoPath, Buffer.from(photoBuffer))
      
      // Simpler color grading
      const colorFilters = {
        cold: 'eq=contrast=1.3:brightness=-0.08:saturation=0.8,vignette=PI/4',
        warm: 'eq=contrast=1.1:brightness=0.05:saturation=1.2,vignette=PI/4',
        epic: 'eq=contrast=1.5:brightness=-0.1:saturation=0.9,vignette=PI/4',
        cinematic: 'eq=contrast=1.2:brightness=-0.05:saturation=1.0,vignette=PI/4'
      }
      const colorFilter = colorFilters[colorGrade] || colorFilters.cinematic
      
      // Movie poster style: title at top, subtitles at bottom, letterbox bars, fade in
      const line1Upper = line1.toUpperCase()
      if (hasBgm) {
        execSync(`ffmpeg -y -loop 1 -i "${photoPath}" -i "${bgmPath}" -filter_complex "[0:v]scale=4000:-1,zoompan=z='min(zoom+0.005,1.5)':d=200:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920,${colorFilter},drawbox=x=0:y=0:w=iw:h=ih*0.08:color=black:t=fill,drawbox=x=0:y=ih*0.92:w=iw:h=ih*0.08:color=black:t=fill,drawtext=fontfile=${font}:text='${line1Upper}':fontcolor=white:fontsize=72:x=(w-text_w)/2:y=h*0.1:shadowcolor=black:shadowx=3:shadowy=3:enable='between(t,0.5,2.5)',drawtext=fontfile=${font}:text='${line2}':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=h*0.8:shadowcolor=black:shadowx=2:shadowy=2:enable='between(t,3,5)',drawtext=fontfile=${font}:text='${line3}':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=h*0.88:shadowcolor=black:shadowx=2:shadowy=2:enable='between(t,5.5,7.5)',fade=t=in:st=0:d=0.5,format=yuv420p[v];[1:a]volume=0.2[a]" -map "[v]" -map "[a]" -t 8 -r 25 -c:v libx264 -c:a aac "${outputPath}"`)
      } else {
        // No BGM: add subtitles only with silent audio
        execSync(`ffmpeg -y -loop 1 -i "${photoPath}" -f lavfi -i anullsrc=r=48000:cl=stereo -filter_complex "[0:v]scale=4000:-1,zoompan=z='min(zoom+0.005,1.5)':d=200:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920,${colorFilter},drawbox=x=0:y=0:w=iw:h=ih*0.08:color=black:t=fill,drawbox=x=0:y=ih*0.92:w=iw:h=ih*0.08:color=black:t=fill,drawtext=fontfile=${font}:text='${line1Upper}':fontcolor=white:fontsize=72:x=(w-text_w)/2:y=h*0.1:shadowcolor=black:shadowx=3:shadowy=3:enable='between(t,0.5,2.5)',drawtext=fontfile=${font}:text='${line2}':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=h*0.8:shadowcolor=black:shadowx=2:shadowy=2:enable='between(t,3,5)',drawtext=fontfile=${font}:text='${line3}':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=h*0.88:shadowcolor=black:shadowx=2:shadowy=2:enable='between(t,5.5,7.5)',fade=t=in:st=0:d=0.5,format=yuv420p[v]" -map "[v]" -map 1:a -t 8 -r 25 -c:v libx264 -c:a aac "${outputPath}"`)
      }
    }
    
    // Upload to Supabase
    const fileBuffer = fs.readFileSync(outputPath)
    const fileName = `hooks/hook_${Date.now()}.mp4`
    await supabase.storage.from('generated-videos').upload(fileName, fileBuffer, { contentType: 'video/mp4', upsert: true })
    const { data: urlData } = supabase.storage.from('generated-videos').getPublicUrl(fileName)
    const hookVideoUrl = urlData.publicUrl
    
    // Update movies table with hook_video_url if movieId is provided
    if (movieId) {
      try {
        const { error: updateErr } = await supabase
          .from('movies')
          .update({ hook_video_url: hookVideoUrl })
          .eq('id', movieId)
        if (updateErr) {
          console.warn('[hook] Failed to update movies table:', updateErr.message)
        } else {
          console.log('[hook] Updated movies table with hook_video_url for:', movieId)
        }
      } catch (dbErr) {
        console.warn('[hook] Database update error (non-fatal):', dbErr.message)
      }
    }
    
    // Cleanup
    fs.rmSync(workDir, { recursive: true, force: true })
    
    console.log('[hook] Success:', hookVideoUrl)
    res.json({ success: true, hookVideoUrl })
  } catch (err) {
    console.error('[hook] error:', err.message)
    res.status(500).json({ success: false, error: err.message })
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

// ─── POST /api/generate-hook-emotion ─────────────────────────────────────────
// 根据模板生成单个情绪视频 (只生成1个，节省成本)
// Body: { imageUrl: string, template_id: string }
// Returns: { success: true, emotion: string, videoUrl: string }

// Template → Emotion mapping
const TEMPLATE_EMOTION_MAP = {
  'she_didnt_choose_you': 'sad',
  'phone_3am': 'sad',
  'lost_someone': 'sad',
  'dog_last_words': 'sad',
  'what_could_have_been': 'sad',
  'parallel_universe': 'neutral',
  'future_you': 'scared',
  'future_warning': 'scared',
  'last_person': 'sad',
  'group_chat': 'sad',
  'friend_betrayal': 'angry',
  'breaking_news': 'surprised'
};

const EMOTIONS = {
  neutral: `A cinematic close-up portrait of the same person 
from the reference photo. Neutral face, still eyes, 
subtle breathing, tense silence, shallow depth of field, 
realistic skin, no face change, no smile, no talking.`,

  surprised: `A cinematic close-up portrait of the same person 
from the reference photo. The person suddenly looks shocked, 
eyes widen, mouth slightly opens, quick emotional reaction, 
realistic expression, no face change, no talking.`,

  scared: `A cinematic close-up portrait of the same person 
from the reference photo. The person looks terrified, 
eyes trembling, breathing fast, frozen in fear, 
dramatic lighting, realistic fear expression, 
no face change, no talking.`,

  sad: `A cinematic close-up portrait of the same person 
from the reference photo. The person looks heartbroken, 
eyes wet, holding back tears, subtle sadness, 
emotional silence, realistic face, no face change, no talking.`,

  angry: `A cinematic close-up portrait of the same person
from the reference photo. The person looks deeply betrayed,
jaw tightening, eyes hardening with controlled fury,
the calm before the storm, realistic anger,
no face change, no talking.`
};

async function generateOneEmotion(imageUrl, prompt) {
  console.log('[replicate] starting generation...')
  
  const timeoutPromise = new Promise((_, reject) => 
    setTimeout(() => reject(new Error('Replicate timeout after 90s')), 90000)
  )
  
  const replicatePromise = replicate.run(
    "bytedance/seedance-1-lite",
    {
      input: {
        prompt,
        image: imageUrl,
        duration: 5,
        resolution: "720p",
        fps: 24,
        camera_fixed: false
      }
    }
  )
  
  const output = await Promise.race([replicatePromise, timeoutPromise])
  console.log('[replicate] raw output type:', typeof output)
  console.log('[replicate] raw output:', JSON.stringify(output))
  
  // Replicate returns an object with url() method
  if (output && typeof output.url === 'function') {
    const url = await output.url()
    console.log('[replicate] url():', url)
    return url.href || String(url)
  }
  if (typeof output === 'string') return output
  if (Array.isArray(output)) return output[0]
  return null
}

app.post('/api/generate-hook-emotion', async (req, res) => {
  try {
    const { imageUrl, template_id } = req.body;
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl required' });
    
    // Select ONE emotion based on template
    const emotion = TEMPLATE_EMOTION_MAP[template_id] || 'neutral';
    const prompt = EMOTIONS[emotion];
    
    console.log(`[generate-hook-emotion] Template: ${template_id} → Emotion: ${emotion}`);
    console.log(`[generate-hook-emotion] Generating for: ${imageUrl}`);
    
    // Generate only ONE video
    const videoUrl = await generateOneEmotion(imageUrl, prompt);
    
    console.log(`[generate-hook-emotion] Success:`, videoUrl);
    res.json({ 
      success: true, 
      emotion,
      videoUrl 
    });
  } catch (err) {
    console.error('[generate-hook-emotion] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/add-bgm-to-video ──────────────────────────────────────────────
// Adds BGM to a video (for Seedance emotion videos)
// Body: { videoUrl: string, bgmUrl?: string, movieId?: string }
// Returns: { success: true, videoUrl: string }
app.post('/api/add-bgm-to-video', async (req, res) => {
  const { videoUrl, bgmUrl, movieId } = req.body;
  if (!videoUrl) return res.status(400).json({ error: 'videoUrl required' });
  
  const id = require('uuid').v4();
  const workDir = `/tmp/${id}_bgm`;
  const fs = require('fs');
  fs.mkdirSync(workDir, { recursive: true });
  
  try {
    // Download video
    const videoPath = path.join(workDir, 'input.mp4');
    await download(videoUrl, videoPath);
    
    const outputPath = path.join(workDir, 'output.mp4');
    
    if (bgmUrl) {
      // Download BGM
      const bgmPath = path.join(workDir, 'bgm.mp3');
      await download(bgmUrl, bgmPath);
      
      console.log('[add-bgm] Adding BGM to video...');
      
      // Add BGM to video
      await new Promise((resolve, reject) => {
        ffmpeg(videoPath)
          .input(bgmPath)
          .outputOptions([
            '-c:v copy',
            '-c:a aac',
            '-map 0:v:0',
            '-map 1:a:0',
            '-shortest'
          ])
          .save(outputPath)
          .on('end', resolve)
          .on('error', reject);
      });
    } else {
      fs.copyFileSync(videoPath, outputPath);
    }
    
    // Upload to Supabase
    const fileName = `hooks/bgm_${Date.now()}.mp4`;
    const fileBuffer = fs.readFileSync(outputPath);
    const { data, error } = await supabase.storage
      .from('generated-videos')
      .upload(fileName, fileBuffer, { contentType: 'video/mp4', upsert: true });
    
    if (error) throw new Error(`Upload failed: ${error.message}`);
    
    const { data: urlData } = supabase.storage
      .from('generated-videos')
      .getPublicUrl(fileName);
    
    // Update movies table if movieId is provided
    if (movieId) {
      await supabase.from('movies')
        .update({ hook_video_url: urlData.publicUrl })
        .eq('id', movieId)
      console.log('[add-bgm] Updated movie hook_video_url:', movieId)
    }
    
    console.log('[add-bgm] Success:', urlData.publicUrl);
    res.json({ success: true, videoUrl: urlData.publicUrl });
  } catch (err) {
    console.error('[add-bgm] error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

// ─── POST /api/burn-subtitle ─────────────────────────────────────────────────
// Burns a single subtitle onto a video (for final movie ending line)
// Body: { videoUrl: string, subtitle: string, startTime?: number, duration?: number }
// Returns: { success: true, videoUrl: string }
app.post('/api/burn-subtitle', async (req, res) => {
  const { videoUrl, subtitle, startTime = 11, duration = 4 } = req.body
  
  if (!videoUrl || !subtitle) {
    return res.status(400).json({ error: 'videoUrl and subtitle required' })
  }
  
  const id = require('uuid').v4()
  const workDir = `/tmp/${id}_sub`
  const fs = require('fs')
  fs.mkdirSync(workDir, { recursive: true })
  
  try {
    const videoPath = path.join(workDir, 'input.mp4')
    await download(videoUrl, videoPath)
    const outputPath = path.join(workDir, 'output.mp4')
    
    const font = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'
    const escapedSubtitle = subtitle.replace(/'/g, "\\'")
    
    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .videoFilters(
          `drawtext=fontfile='${font}':text='${escapedSubtitle}':` +
          `fontsize=36:fontcolor=white:` +
          `x=(w-tw)/2:y=h-150:` +
          `shadowcolor=black:shadowx=2:shadowy=2:` +
          `enable='between(t,${startTime},${startTime + duration})'`
        )
        .outputOptions(['-c:a copy'])
        .save(outputPath)
        .on('end', resolve)
        .on('error', reject)
    })
    
    const fileName = `subtitled/sub_${Date.now()}.mp4`
    const fileBuffer = fs.readFileSync(outputPath)
    await supabase.storage.from('generated-videos')
      .upload(fileName, fileBuffer, { contentType: 'video/mp4', upsert: true })
    const { data: urlData } = supabase.storage
      .from('generated-videos').getPublicUrl(fileName)
    
    console.log('[burn-subtitle] Success:', urlData.publicUrl)
    res.json({ success: true, videoUrl: urlData.publicUrl })
  } catch (err) {
    console.error('[burn-subtitle] error:', err)
    res.status(500).json({ error: err.message })
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
})

// ─── POST /api/process-hook ──────────────────────────────────────────────────
// Processes hook video: adds BGM + burns subtitles + updates database
// Body: { videoUrl: string, bgmUrl: string, subtitles: Array<{time: number, text: string}>, movieId: string }
// Returns: { success: true, status: 'processing' } immediately, then processes in background
app.post('/api/process-hook', async (req, res) => {
  const { videoUrl, bgmUrl, audioUrls, subtitles, movieId } = req.body;
  
  if (!videoUrl || !bgmUrl || !movieId) {
    return res.status(400).json({ error: 'videoUrl, bgmUrl, and movieId required' });
  }
  
  // Respond immediately
  res.json({ success: true, status: 'processing' });
  
  // Then process in background
  const workDir = `/tmp/${movieId}_process`;
  const fs = require('fs');
  
  try {
    fs.mkdirSync(workDir, { recursive: true });
    
    const videoPath = path.join(workDir, 'input.mp4');
    const bgmPath = path.join(workDir, 'bgm.mp3');
    let currentVideoPath = videoPath;
    
    console.log('[process-hook] Starting for movieId:', movieId);
    
    // Download video and BGM
    await download(videoUrl, videoPath);
    await download(bgmUrl, bgmPath);
    console.log('[process-hook] Downloaded video and BGM');
    
    // If audioUrls provided, mix dialogue audio with video first
    if (audioUrls && Array.isArray(audioUrls) && audioUrls.length > 0) {
      console.log('[process-hook] Mixing dialogue audio with video...');
      
      // Download all audio files
      const audioPaths = [];
      for (let i = 0; i < audioUrls.length; i++) {
        const audioPath = path.join(workDir, `audio_${i}.mp3`);
        await download(audioUrls[i], audioPath);
        audioPaths.push(audioPath);
      }
      
      // Create silence file (0.5 seconds)
      const silencePath = path.join(workDir, 'silence.mp3');
      await new Promise((resolve, reject) => {
        const { spawn } = require('child_process');
        const args = [
          '-f', 'lavfi',
          '-i', 'anullsrc=r=48000:cl=stereo',
          '-t', '0.5',
          '-c:a', 'libmp3lame',
          '-y',
          silencePath
        ];
        const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error('Silence generation failed: ' + stderr.slice(-300)));
        });
      });
      
      // Build concat list with silence between audio files
      const concatAudioPath = path.join(workDir, 'concat_audio.mp3');
      const audioListPath = path.join(workDir, 'audio_list.txt');
      const concatList = [];
      for (let i = 0; i < audioPaths.length; i++) {
        concatList.push(`file '${path.resolve(audioPaths[i]).replace(/'/g, "'\\''")}'`);
        if (i < audioPaths.length - 1) {
          // Add silence between lines (but not after last line)
          concatList.push(`file '${path.resolve(silencePath).replace(/'/g, "'\\''")}'`);
        }
      }
      fs.writeFileSync(audioListPath, concatList.join('\n'), 'utf8');
      
      // Concatenate audio files with silence
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(audioListPath)
          .inputOptions(['-f', 'concat', '-safe', '0'])
          .outputOptions(['-c', 'copy'])
          .save(concatAudioPath)
          .on('end', resolve)
          .on('error', reject);
      });
      
      // Mix concatenated dialogue audio with video from beginning
      const withAudioPath = path.join(workDir, 'with_audio.mp4');
      await new Promise((resolve, reject) => {
        ffmpeg(videoPath)
          .input(concatAudioPath)
          .outputOptions([
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-map', '0:v:0',
            '-map', '1:a:0',
            '-shortest'
          ])
          .save(withAudioPath)
          .on('end', resolve)
          .on('error', reject);
      });
      
      currentVideoPath = withAudioPath;
      console.log('[process-hook] Dialogue audio mixed with 0.5s silence between lines');
    }
    
    // Add BGM on top
    const withBgmPath = path.join(workDir, 'with_bgm.mp4');
    await new Promise((resolve, reject) => {
      ffmpeg(currentVideoPath)
        .input(bgmPath)
        .outputOptions([
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-t', '15'
        ])
        .save(withBgmPath)
        .on('end', resolve)
        .on('error', reject);
    });
    console.log('[process-hook] BGM added');
    
    // Burn subtitles if provided
    const finalPath = path.join(workDir, 'final.mp4');
    if (subtitles && Array.isArray(subtitles) && subtitles.length > 0) {
      const font = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc';
      const drawtextFilters = subtitles.map(sub => {
        const escapedText = sub.text.replace(/'/g, '').replace(/:/g, ' ').replace(/,/g, '\\,');
        // Handle both formats: {time, text} or {startTime, endTime, text}
        const startTime = sub.startTime || sub.time || 0;
        const endTime = sub.endTime || (startTime + 1.5);
        return `drawtext=fontfile='${font}':text='${escapedText}':fontcolor=white:fontsize=56:x=(w-text_w)/2:y=(h-th-100):shadowcolor=black@0.8:shadowx=3:shadowy=3:enable='between(t,${startTime},${endTime})'`;
      }).join(',');
      
      await new Promise((resolve, reject) => {
        ffmpeg(withBgmPath)
          .videoFilters(drawtextFilters)
          .outputOptions(['-c:a', 'copy'])
          .save(finalPath)
          .on('end', resolve)
          .on('error', reject);
      });
      console.log('[process-hook] Subtitles burned');
    } else {
      fs.copyFileSync(withBgmPath, finalPath);
      console.log('[process-hook] No subtitles, using BGM video');
    }
    
    // Upload to Supabase
    const fileName = `hooks/processed_${Date.now()}.mp4`;
    const fileBuffer = fs.readFileSync(finalPath);
    await supabase.storage.from('generated-videos')
      .upload(fileName, fileBuffer, { contentType: 'video/mp4', upsert: true });
    
    const { data: urlData } = supabase.storage
      .from('generated-videos').getPublicUrl(fileName);
    
    // Update movies table
    await supabase.from('movies')
      .update({ hook_video_url: urlData.publicUrl })
      .eq('id', movieId);
    
    console.log('[process-hook] ✅ Complete:', urlData.publicUrl);
    
    // Cleanup
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch (err) {
    console.error('[process-hook] error:', err);
    // Cleanup on error
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.error('[process-hook] cleanup error:', cleanupErr);
    }
  }
});

// ─── POST /api/finalize-movie ────────────────────────────────────────────────
// Handles all post-processing for final movie: TTS + merge + BGM + ending subtitle
// Body: { videoUrl: string, movieId: string, archetype: string, dialogueLines: string[], bgmUrl: string }
// Returns: { success: true, status: 'processing' } immediately, then processes in background

// Helper function for ending lines
function getEndingLine(archetype) {
  const ENDING_LINES = {
    'she_didnt_choose_you': "She saw everything.",
    'lost_someone': "It had something to tell you.",
    'last_person': "You shouldn't read this.",
    'future_you': "You already made the wrong choice.",
    'friend_betrayal': "And you trusted him.",
    'what_could_have_been': "Look at what you lost.",
    'breaking_news': "They're saying his name.",
    'parallel_universe': "Some doors should stay closed.",
    'phone_3am': "She saw everything.",
    'future_warning': "You already made the wrong choice.",
    'group_chat': "You shouldn't read this.",
    'dog_last_words': "It had something to tell you.",
    'pet_daily': "Every moment was a gift.",
    'playful_chaos': "Life is better with you.",
    'late_regret': "Some words come too late.",
    'heartbreak': "Love doesn't always stay.",
    'lonely_reflection': "Sometimes alone is better.",
    'hero_moment': "This is who I was meant to be.",
    'martial_arts': "Strength comes from within.",
    'chase_escape': "Freedom has a price.",
    'unspoken_love': "I should have said it.",
    'reconciliation': "Forgiveness changes everything.",
    'spring_festival': "Home is where the heart returns.",
    'christmas': "Magic lives in the moments we share."
  };
  return ENDING_LINES[archetype] || null;
}

app.post('/api/finalize-movie', async (req, res) => {
  const { videoUrl, movieId, archetype, dialogueLines, bgmUrl } = req.body;
  
  if (!videoUrl || !movieId) {
    return res.status(400).json({ error: 'videoUrl and movieId required' });
  }
  
  // Respond immediately
  res.json({ success: true, status: 'processing' });
  
  const workDir = `/tmp/${movieId}_finalize`;
  const fs = require('fs');
  
  (async () => {
    try {
      fs.mkdirSync(workDir, { recursive: true });
      console.log('[finalize] Starting for movie:', movieId);
      
      // Step 1: Download Kling video
      const videoPath = path.join(workDir, 'kling.mp4');
      await download(videoUrl, videoPath);
      console.log('[finalize] Step 1: Video downloaded');
      
      // Step 2: Generate ElevenLabs dialogue
      const audioFiles = [];
      if (dialogueLines && Array.isArray(dialogueLines) && dialogueLines.length > 0 && process.env.ELEVENLABS_API_KEY) {
        console.log('[finalize] Step 2: Generating dialogue...');
        for (let i = 0; i < dialogueLines.length; i++) {
          const line = dialogueLines[i];
          try {
            const ttsRes = await fetch(
              'https://api.elevenlabs.io/v1/text-to-speech/KdYTpVAufDTTk08g3eJi',
              {
                method: 'POST',
                headers: {
                  'xi-api-key': process.env.ELEVENLABS_API_KEY,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  text: line,
                  model_id: 'eleven_turbo_v2',
                  voice_settings: { stability: 0.5, similarity_boost: 0.75 }
                })
              }
            );
            if (!ttsRes.ok) {
              console.warn(`[finalize] TTS failed for line ${i + 1}:`, ttsRes.status);
              continue;
            }
            const audioBuffer = await ttsRes.arrayBuffer();
            const audioPath = path.join(workDir, `line-${i}.mp3`);
            fs.writeFileSync(audioPath, Buffer.from(audioBuffer));
            audioFiles.push(audioPath);
            console.log(`[finalize] Generated line ${i + 1}:`, line);
          } catch (lineErr) {
            console.warn(`[finalize] Line ${i + 1} failed:`, lineErr.message);
          }
        }
        console.log('[finalize] Step 2: Dialogue generated', audioFiles.length, 'lines');
      } else {
        console.log('[finalize] Step 2: No dialogue lines, skipping TTS');
      }
      
      // Step 3: Download BGM
      const bgmPath = path.join(workDir, 'bgm.mp3');
      const hasBgm = typeof bgmUrl === 'string' && bgmUrl.trim().length > 0;
      
      if (hasBgm) {
        try {
          await download(bgmUrl, bgmPath);
          console.log('[finalize] Step 3: BGM downloaded');
        } catch (bgmErr) {
          console.warn('[finalize] Step 3: BGM download failed:', bgmErr.message);
        }
      } else {
        console.log('[finalize] Step 3: No BGM');
      }
      
      // Step 4: Merge video + dialogue + BGM
      const mergedPath = path.join(workDir, 'merged.mp4');
      console.log('[finalize] Step 4: Merging video + dialogue + BGM...');
      
      if (audioFiles.length === 0 && hasBgm) {
        // Simple BGM only merge
        await new Promise((resolve, reject) => {
          ffmpeg(videoPath)
            .input(bgmPath)
            .outputOptions([
              '-c:v copy',
              '-c:a aac',
              '-map 0:v:0',
              '-map 1:a:0',
              '-shortest',
              '-t 15'
            ])
            .save(mergedPath)
            .on('end', resolve)
            .on('error', reject);
        });
      } else if (audioFiles.length === 0 && !hasBgm) {
        // No audio at all, just copy video
        await new Promise((resolve, reject) => {
          ffmpeg(videoPath)
            .outputOptions(['-c', 'copy'])
            .save(mergedPath)
            .on('end', resolve)
            .on('error', reject);
        });
      } else {
        // Complex case with dialogue (will implement later)
        await new Promise((resolve, reject) => {
          let cmd = ffmpeg(videoPath);
          
          // Add dialogue files
          for (const audioFile of audioFiles) {
            cmd = cmd.input(audioFile);
          }
          
          // Add BGM if exists
          if (hasBgm) {
            cmd = cmd.input(bgmPath);
          }
          
          // Build filter complex
          if (audioFiles.length > 0 && hasBgm) {
            // Concat dialogue + mix with BGM
            const concatFilter = audioFiles.map((_, i) => `[${i+1}:a]`).join('') + 
              `concat=n=${audioFiles.length}:v=0:a=1[dialogue];` +
              `[dialogue]volume=1.0[d];` +
              `[${audioFiles.length+1}:a]volume=0.3,aloop=loop=-1:size=2147483647[bgm];` +
              `[d][bgm]amix=inputs=2:duration=first[aout]`;
            
            cmd.complexFilter(concatFilter)
              .map('0:v')
              .map('[aout]');
          } else if (audioFiles.length > 0) {
            // Dialogue only
            const concatFilter = audioFiles.map((_, i) => `[${i+1}:a]`).join('') + 
              `concat=n=${audioFiles.length}:v=0:a=1[aout]`;
            cmd.complexFilter(concatFilter)
              .map('0:v')
              .map('[aout]');
          }
          
          cmd.outputOptions(['-c:v', 'copy', '-c:a', 'aac', '-ar', '48000', '-t', '15', '-shortest'])
            .save(mergedPath)
            .on('end', resolve)
            .on('error', reject);
        });
      }
      console.log('[finalize] Step 4: Merged');
      
      // Step 5: Burn ending subtitle
      const endingLine = getEndingLine(archetype);
      let finalPath = mergedPath;
      
      if (endingLine) {
        console.log('[finalize] Step 5: Burning subtitle:', endingLine);
        const subtitledPath = path.join(workDir, 'subtitled.mp4');
        const font = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc';
        await new Promise((resolve, reject) => {
          ffmpeg(mergedPath)
            .videoFilters(
              `drawtext=fontfile='${font}':text='${endingLine.replace(/'/g, "\\'")}':` +
              `fontsize=36:fontcolor=white:` +
              `x=(w-tw)/2:y=h-150:` +
              `shadowcolor=black:shadowx=2:shadowy=2:` +
              `enable='between(t,11,15)'`
            )
            .outputOptions(['-c:a', 'copy'])
            .save(subtitledPath)
            .on('end', resolve)
            .on('error', reject);
        });
        finalPath = subtitledPath;
        console.log('[finalize] Step 5: Subtitle burned');
      } else {
        console.log('[finalize] Step 5: No ending line for archetype:', archetype);
      }
      
      // Step 6: Upload to Supabase
      console.log('[finalize] Step 6: Uploading to Supabase...');
      const fileName = `${movieId}/final-${Date.now()}.mp4`;
      const fileBuffer = fs.readFileSync(finalPath);
      await supabase.storage
        .from('generated-videos')
        .upload(fileName, fileBuffer, { contentType: 'video/mp4', upsert: true });
      const { data: urlData } = supabase.storage
        .from('generated-videos').getPublicUrl(fileName);
      console.log('[finalize] Step 6: Uploaded:', urlData.publicUrl);
      
      // Step 7: Update database
      await supabase.from('movies')
        .update({ 
          final_video_url: urlData.publicUrl,
          status: 'complete'
        })
        .eq('id', movieId);
      console.log('[finalize] Step 7: Database updated');
      
      console.log('[finalize] ✅ Complete:', urlData.publicUrl);
      
    } catch (err) {
      console.error('[finalize] error:', err);
      await supabase.from('movies')
        .update({ status: 'failed' })
        .eq('id', movieId);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  })();
});

// ─── POST /api/burn-hook-subtitles ───────────────────────────────────────────
// Burns subtitles onto a hook video with zero-delay emotional impact
// Body: { videoUrl: string, subtitles: Array<{time: number, text: string}> }
// Returns: { success: true, videoUrl: string }
app.post('/api/burn-hook-subtitles', async (req, res) => {
  const { videoUrl, subtitles } = req.body;
  
  if (!videoUrl || !subtitles || !Array.isArray(subtitles)) {
    return res.status(400).json({ error: 'videoUrl and subtitles array required' });
  }
  
  console.log('[burn-hook-subtitles] Processing:', videoUrl, 'subtitles:', subtitles.length);
  
  const workDir = `/tmp/${require('uuid').v4()}_burn`;
  const fs = require('fs');
  fs.mkdirSync(workDir, { recursive: true });
  
  const inputPath = path.join(workDir, 'input.mp4');
  const outputPath = path.join(workDir, 'output.mp4');
  
  try {
    // Download video
    const videoRes = await fetch(videoUrl);
    if (!videoRes.ok) throw new Error(`Video download failed: ${videoRes.status}`);
    const videoBuffer = await videoRes.arrayBuffer();
    fs.writeFileSync(inputPath, Buffer.from(videoBuffer));
    console.log('[burn-hook-subtitles] Video downloaded');
    
    // Build drawtext filters for each subtitle
    // Zero-delay appearance, bold white text, center screen, drop shadow
    const font = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc';
    const drawtextFilters = subtitles.map(sub => {
      const escapedText = sub.text.replace(/'/g, '').replace(/:/g, ' ').replace(/,/g, '\\,');
      const endTime = sub.time + 1.5; // Show for 1.5 seconds
      return `drawtext=fontfile='${font}':text='${escapedText}':fontcolor=white:fontsize=56:x=(w-text_w)/2:y=(h-th-100):shadowcolor=black@0.8:shadowx=3:shadowy=3:enable='between(t,${sub.time},${endTime})'`;
    }).join(',');
    
    console.log('[burn-hook-subtitles] Burning subtitles with FFmpeg...');
    
    // Burn subtitles using FFmpeg
    const { execSync } = require('child_process');
    execSync(`ffmpeg -y -i "${inputPath}" -vf "${drawtextFilters}" -c:v libx264 -preset veryfast -crf 23 -c:a copy "${outputPath}"`);
    
    // Upload to Supabase
    const fileBuffer = fs.readFileSync(outputPath);
    const fileName = `hooks/subtitled_${Date.now()}.mp4`;
    await supabase.storage.from('generated-videos').upload(fileName, fileBuffer, { contentType: 'video/mp4', upsert: true });
    const { data: urlData } = supabase.storage.from('generated-videos').getPublicUrl(fileName);
    const finalVideoUrl = urlData.publicUrl;
    
    // Cleanup
    fs.rmSync(workDir, { recursive: true, force: true });
    
    console.log('[burn-hook-subtitles] Success:', finalVideoUrl);
    res.json({ success: true, videoUrl: finalVideoUrl });
  } catch (err) {
    console.error('[burn-hook-subtitles] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
