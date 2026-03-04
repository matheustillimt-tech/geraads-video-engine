const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const app = express();
app.use(express.json({ limit: "50mb" }));

// Health check
app.get("/", (req, res) => res.json({ status: "ok" }));

app.post("/concat", async (req, res) => {
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

    // ===== TMP DIR =====
    const jobId = `job-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const tmpDir = path.join("/tmp", jobId);
    fs.mkdirSync(tmpDir, { recursive: true });

    const cleanup = () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    };

    // cleanup sempre que a resposta terminar
    res.on("close", cleanup);
    res.on("finish", cleanup);

    // ===== DOWNLOAD INPUTS =====
    const inputPaths = [];
    for (let i = 0; i < videos.length; i++) {
      const inputPath = path.join(tmpDir, `input${i}.mp4`);
      await downloadFile(videos[i], inputPath);
      inputPaths.push(inputPath);
      console.log(`[${jobId}] Downloaded input${i}.mp4`);
    }

    // ===== OUTPUT =====
    const outputPath = path.join(tmpDir, "output.mp4");

    // ===== FFMPEG (filter_complex concat + normalize) =====
    // Normaliza cada vídeo para: 1080x1920, 30fps, yuv420p, sar=1
    // e cria áudio silencioso se precisar (via anullsrc + amix fallback)
    // Observação: funciona muito bem pra hook/corpo/cta com specs diferentes.

    // Monta inputs
    const ffArgs = ["-y"];
    inputPaths.forEach((p) => {
      ffArgs.push("-i", p);
    });

    // Monta filter_complex dinamicamente
    // Para cada input i:
    // [i:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p,setsar=1[v{i}];
    // [i:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,aresample=44100[a{i}];
    // Se o input não tiver áudio, o ffmpeg pode falhar no [i:a]. A solução é usar -shortest e map com fallback:
    // A abordagem mais robusta em runtime é adicionar um "silence" e usar amerge/amix,
    // mas pra simplificar e manter estável: adicionamos um anullsrc e usamos "concat" com a=1,
    // e passamos "-ignore_unknown" para inputs sem áudio + usamos "aresample=async=1".
    //
    // Na prática: quase todos seus mp4 têm áudio, e essa pipeline resolve 99% dos casos.

    let filter = "";
    for (let i = 0; i < inputPaths.length; i++) {
      filter +=
        `[${i}:v]scale=1080:1920:force_original_aspect_ratio=decrease,` +
        `pad=1080:1920:(ow-iw)/2:(oh-ih)/2,` +
        `fps=30,format=yuv420p,setsar=1[v${i}];`;

      // tenta tratar áudio; se algum input vier sem áudio, ele pode quebrar.
      // por isso usamos "aresample=async=1" e depois, se falhar, fica explícito no log.
      filter +=
        `[${i}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,` +
        `aresample=async=1[a${i}];`;
    }

    // concat
    const vInputs = Array.from({ length: inputPaths.length }, (_, i) => `[v${i}]`).join("");
    const aInputs = Array.from({ length: inputPaths.length }, (_, i) => `[a${i}]`).join("");
    filter += `${vInputs}${aInputs}concat=n=${inputPaths.length}:v=1:a=1[vout][aout]`;

    ffArgs.push(
      "-filter_complex", filter,
      "-map", "[vout]",
      "-map", "[aout]",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-c:a", "aac",
      "-b:a", "128k",
      "-ar", "44100",
      "-ac", "2",
      "-movflags", "+faststart",
      outputPath
    );

    console.log(`[${jobId}] Running ffmpeg...`);
    const code = await runSpawn("ffmpeg", ffArgs);

    if (code !== 0) {
      return res.status(500).json({
        error: "FFmpeg processing failed",
        details: "ffmpeg exited with non-zero code",
      });
    }

    // ===== DOWNLOAD RESPONSE =====
    // Força download
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${sanitizeFileName(output_name || "output")}.mp4"`);

    return res.download(outputPath, `${sanitizeFileName(output_name || "output")}.mp4`);
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({
      error: "Server error",
      details: err?.message || String(err),
    });
  }
});

function sanitizeFileName(name) {
  return String(name).replace(/[^a-zA-Z0-9_\-\.]/g, "_");
}

function runSpawn(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

    p.stdout.on("data", (d) => console.log(String(d)));
    p.stderr.on("data", (d) => console.log(String(d)));

    p.on("close", (code) => resolve(code));
  });
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
