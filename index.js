const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const app = express();
app.use(express.json({ limit: "50mb" }));

app.get("/", (req, res) => res.json({ status: "ok" }));

app.post("/concat", async (req, res) => {
  const jobId = `job-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    // ===== AUTH =====
    const apiKey = req.headers["x-api-key"];
    if (!process.env.API_KEY) {
      return res.status(500).json({ error: "Server missing API_KEY env var" });
    }
    if (apiKey !== process.env.API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // ===== BODY =====
    const { videos, output_name } = req.body;
    if (!Array.isArray(videos) || videos.length < 2) {
      return res.status(400).json({ error: "At least 2 video URLs required" });
    }

    // ===== TMP =====
    const tmpDir = path.join("/tmp", jobId);
    fs.mkdirSync(tmpDir, { recursive: true });

    const cleanup = () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    };
    res.on("close", cleanup);
    res.on("finish", cleanup);

    // ===== DOWNLOAD =====
    const inputPaths = [];
    for (let i = 0; i < videos.length; i++) {
      const inputPath = path.join(tmpDir, `input${i}.mp4`);
      await downloadFile(videos[i], inputPath);
      inputPaths.push(inputPath);
      console.log(`[${jobId}] Downloaded input${i}.mp4`);
    }

    // ===== PROBE (duração + tem áudio?) =====
    const metas = [];
    for (let i = 0; i < inputPaths.length; i++) {
      const meta = await probeFile(inputPaths[i]);
      metas.push(meta);
      console.log(
        `[${jobId}] input${i}: duration=${meta.duration}s hasAudio=${meta.hasAudio}`
      );
    }

    // ===== OUTPUT =====
    const outName = sanitizeFileName(output_name || "output");
    const outputPath = path.join(tmpDir, "output.mp4");

    // ===== FFMPEG BUILD =====
    const ffArgs = ["-y"];
    inputPaths.forEach((p) => ffArgs.push("-i", p));

    let filter = "";
    let concatInputs = ""; // <- VAI SER INTERCALADO [v0][a0][v1][a1]...

    for (let i = 0; i < metas.length; i++) {
      // vídeo: pad + fps + formato + sar
      filter +=
        `[${i}:v]` +
        `scale=1080:1920:force_original_aspect_ratio=decrease,` +
        `pad=1080:1920:(ow-iw)/2:(oh-ih)/2,` +
        `fps=30,format=yuv420p,setsar=1` +
        `[v${i}];`;

      // áudio: se não tiver, cria silêncio com mesma duração
      if (metas[i].hasAudio) {
        filter +=
          `[${i}:a]` +
          `aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,` +
          `aresample=async=1` +
          `[a${i}];`;
      } else {
        const dur = Math.max(0.1, metas[i].duration || 1);
        filter +=
          `anullsrc=channel_layout=stereo:sample_rate=44100,` +
          `atrim=0:${dur},asetpts=N/SR/TB` +
          `[a${i}];`;
      }

      // ✅ MUITO IMPORTANTE: concatInputs INTERCALADO
      concatInputs += `[v${i}][a${i}]`;
    }

    // ✅ concat correto (ordem intercalada)
    filter += `${concatInputs}concat=n=${metas.length}:v=1:a=1[vout][aout]`;

    ffArgs.push(
      "-filter_complex", filter,
      "-map", "[vout]",
      "-map", "[aout]",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-ar", "44100",
      "-ac", "2",
      "-movflags", "+faststart",
      outputPath
    );

    console.log(`[${jobId}] Running ffmpeg...`);
    const { code, stderrTail } = await runSpawnCapture("ffmpeg", ffArgs);

    if (code !== 0) {
      console.error(`[${jobId}] ffmpeg failed code=${code}`);
      console.error(stderrTail);

      return res.status(500).json({
        error: "FFmpeg processing failed",
        details: "ffmpeg exited with non-zero code",
        ffmpeg_stderr_tail: stderrTail,
      });
    }

    // ✅ força download (não abrir em nova aba)
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${outName}.mp4"`);

    return res.download(outputPath, `${outName}.mp4`);
  } catch (err) {
    console.error(`[${jobId}] Server error:`, err);
    return res.status(500).json({
      error: "Server error",
      details: err?.message || String(err),
    });
  }
});

function sanitizeFileName(name) {
  return String(name).replace(/[^a-zA-Z0-9_\-\.]/g, "_");
}

function runSpawnCapture(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    p.stdout.on("data", (d) => console.log(String(d)));
    p.stderr.on("data", (d) => {
      const s = String(d);
      console.log(s);
      stderr += s;
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });

    p.on("close", (code) => resolve({ code, stderrTail: stderr.slice(-4000) }));
  });
}

function runSpawnToString(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += String(d)));
    p.stderr.on("data", (d) => (err += String(d)));

    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(err || `Exit ${code}`));
      resolve(out);
    });
  });
}

async function probeFile(filePath) {
  const durStr = await runSpawnToString("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]).catch(() => "0");

  const duration = Math.max(0, parseFloat(String(durStr).trim()) || 0);

  const audioStr = await runSpawnToString("ffprobe", [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=index",
    "-of", "csv=p=0",
    filePath,
  ]).catch(() => "");

  const hasAudio = String(audioStr).trim().length > 0;
  return { duration, hasAudio };
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);

    const req = mod.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
      }

      if (response.statusCode !== 200) {
        file.close();
        return reject(new Error(`Download failed (${response.statusCode}) for ${url}`));
      }

      response.pipe(file);
      file.on("finish", () => file.close(resolve));
    });

    req.on("error", (err) => {
      try { fs.unlinkSync(dest); } catch {}
      reject(err);
    });
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg server running on port ${PORT}`));
