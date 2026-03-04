/**
 * GeraAds Video Engine - PRO
 * - Accepts MOV/MP4 mixed inputs
 * - Normalizes each clip to a strict standard
 * - Guarantees audio track (injects silence if missing)
 * - Concats normalized clips reliably
 * - Rate-limits concurrent jobs (Railway stability)
 */

const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const http = require("http");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "2mb" }));

// CORS (ok for internal use; if you want, restrict to your domain)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "";
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 2);
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 12 * 60 * 1000);
const DOWNLOAD_TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS || 3 * 60 * 1000);
const DEFAULT_FPS = Number(process.env.DEFAULT_FPS || 30);

const TARGETS = {
  "9:16": { w: 1080, h: 1920 },
  "16:9": { w: 1920, h: 1080 },
  "1:1": { w: 1080, h: 1080 },
};

// ---------- Simple semaphore ----------
class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }
  acquire() {
    return new Promise((resolve) => {
      if (this.current < this.max) {
        this.current++;
        resolve();
      } else {
        this.queue.push(resolve);
      }
    });
  }
  release() {
    this.current = Math.max(0, this.current - 1);
    const next = this.queue.shift();
    if (next) {
      this.current++;
      next();
    }
  }
}
const sem = new Semaphore(MAX_CONCURRENT);

// ---------- Helpers ----------
function safeFilename(name) {
  const base = (name || "output")
    .toString()
    .trim()
    .replace(/[^\w\-\.]+/g, "_")
    .slice(0, 80);
  return base.endsWith(".mp4") ? base : `${base}.mp4`;
}

function mkTmpDir() {
  const id = crypto.randomBytes(8).toString("hex");
  const dir = path.join(os.tmpdir(), `job-${Date.now()}-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;

    const req = mod.get(url, (response) => {
      // redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
      }

      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`Download failed: HTTP ${response.statusCode}`));
      }

      const file = fs.createWriteStream(dest);
      response.pipe(file);

      file.on("finish", () => file.close(resolve));
      file.on("error", (err) => {
        try { fs.unlinkSync(dest); } catch {}
        reject(err);
      });
    });

    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy(new Error("Download timeout"));
    });

    req.on("error", reject);
  });
}

function runFFmpeg(args, timeoutMs = JOB_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    p.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });

    const t = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new Error("FFmpeg timeout"));
    }, timeoutMs);

    p.on("error", (err) => {
      clearTimeout(t);
      reject(err);
    });

    p.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exited with code ${code}\n${stderr}`));
    });
  });
}

// Normaliza cada clip para um padrão único:
// - resolução/fps fixos
// - yuv420p
// - setsar=1 (evita distorção / CTA “esticando”)
// - H264 + AAC
// - áudio garantido (anullsrc + shortest)
async function normalizeClip(inputPath, outputPath, { w, h, fps }) {
  const vf =
    `scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,` +
    `setsar=1,fps=${fps},format=yuv420p`;

  const args = [
    "-y",
    "-i", inputPath,

    // áudio silencioso (fallback)
    "-f", "lavfi",
    "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",

    "-shortest",
    "-vf", vf,

    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",

    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "44100",
    "-ac", "2",
    "-af", "aresample=async=1:first_pts=0",

    "-movflags", "+faststart",
    outputPath,
  ];

  await runFFmpeg(args);
}

async function concatNormalized(listPath, outputPath) {
  // Como já está tudo normalizado, concat + copy fica rápido e estável
  const args = [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    "-c", "copy",
    "-movflags", "+faststart",
    outputPath,
  ];
  await runFFmpeg(args);
}

// ---------- Routes ----------
app.get("/", (req, res) => res.json({ status: "ok" }));

app.post("/concat", async (req, res) => {
  // Auth
  const apiKey = req.headers["x-api-key"];
  if (!API_KEY || apiKey !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  await sem.acquire();

  const tmpDir = mkTmpDir();
  let cleaned = false;

  const doCleanup = () => {
    if (cleaned) return;
    cleaned = true;
    cleanupDir(tmpDir);
    sem.release();
  };

  // se o cliente abortar, limpa
  res.on("close", doCleanup);

  try {
    const { videos, output_name, format, fps } = req.body;

    if (!Array.isArray(videos) || videos.length < 2) {
      doCleanup();
      return res.status(400).json({ error: "At least 2 video URLs required" });
    }

    const chosen = TARGETS[format] || TARGETS["9:16"];
    const target = { w: chosen.w, h: chosen.h, fps: Number(fps || DEFAULT_FPS) };

    // 1) download
    const rawPaths = [];
    for (let i = 0; i < videos.length; i++) {
      const raw = path.join(tmpDir, `raw_${i}.bin`);
      await downloadFile(videos[i], raw);
      rawPaths.push(raw);
    }

    // 2) normalize
    const normPaths = [];
    for (let i = 0; i < rawPaths.length; i++) {
      const norm = path.join(tmpDir, `norm_${i}.mp4`);
      await normalizeClip(rawPaths[i], norm, target);
      normPaths.push(norm);
    }

    // 3) list.txt
    const listPath = path.join(tmpDir, "list.txt");
    fs.writeFileSync(listPath, normPaths.map((p) => `file '${p}'`).join("\n"));

    // 4) concat final
    const outFile = safeFilename(output_name || "output");
    const outputPath = path.join(tmpDir, "output.mp4");
    await concatNormalized(listPath, outputPath);

    if (!fs.existsSync(outputPath)) {
      throw new Error("Output file not found after concat");
    }

    // 5) download (cleanup só depois)
    res.download(outputPath, outFile, (err) => {
      doCleanup();
      if (err) console.error("Download error:", err.message);
    });
  } catch (err) {
    console.error("Engine error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Processing failed", details: err.message });
    }
    doCleanup();
  }
});

app.listen(PORT, () => {
  console.log(`FFmpeg engine running on port ${PORT}`);
  console.log(`MAX_CONCURRENT=${MAX_CONCURRENT} DEFAULT_FPS=${DEFAULT_FPS}`);
});
