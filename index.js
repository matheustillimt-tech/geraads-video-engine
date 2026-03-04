// index.js — FFmpeg Concat Server (Railway)
// Requisitos: FFmpeg + FFprobe instalados na imagem/ambiente do Railway
// ENV:
//   API_KEY = sua chave (ex: matheusgeraads)
//   PORT    = porta do Railway (já vem automático)

const express = require("express");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { URL } = require("url");

const app = express();
app.use(express.json({ limit: "50mb" }));

/** =========================
 *  CONFIG
 *  ========================= */
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "";
const JOB_TIMEOUT_MS = 10 * 60 * 1000; // 10 min (ajuste se quiser)
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS || 2); // profissional: limita carga
let activeJobs = 0;
const jobQueue = [];

function enqueueJob(fn) {
  return new Promise((resolve, reject) => {
    jobQueue.push({ fn, resolve, reject });
    drainQueue();
  });
}

function drainQueue() {
  while (activeJobs < MAX_CONCURRENT_JOBS && jobQueue.length) {
    const item = jobQueue.shift();
    activeJobs++;
    item
      .fn()
      .then(item.resolve)
      .catch(item.reject)
      .finally(() => {
        activeJobs--;
        drainQueue();
      });
  }
}

function safeName(name) {
  return String(name || "output")
    .replace(/[^\w.\-]+/g, "_")
    .slice(0, 120);
}

function isUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function run(cmd, args, opts = {}) {
  const started = Date.now();
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 50,
    timeout: opts.timeout ?? JOB_TIMEOUT_MS,
  });

  if (opts.log) {
    console.log(`[run] ${cmd} ${args.join(" ")}`);
  }

  if (res.error) {
    throw new Error(`${cmd} error: ${res.error.message}`);
  }
  if (res.status !== 0) {
    const stderr = (res.stderr || "").trim();
    const stdout = (res.stdout || "").trim();
    throw new Error(
      `${cmd} exited with code ${res.status}\n` +
        (stderr ? `stderr:\n${stderr}\n` : "") +
        (stdout ? `stdout:\n${stdout}\n` : "")
    );
  }

  if (opts.time) {
    console.log(`[run] done in ${Date.now() - started}ms`);
  }

  return res.stdout || "";
}

function ffprobeJson(filePath) {
  const out = run("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    filePath,
  ]);
  return JSON.parse(out);
}

function hasAudioStream(filePath) {
  const info = ffprobeJson(filePath);
  return (info.streams || []).some((s) => s.codec_type === "audio");
}

function getVideoStreamInfo(filePath) {
  const info = ffprobeJson(filePath);
  const v = (info.streams || []).find((s) => s.codec_type === "video");
  return v || null;
}

/** =========================
 *  DOWNLOAD (com redirect)
 *  ========================= */
function downloadFile(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (!isUrl(url)) return reject(new Error("Invalid URL"));

    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(
      url,
      {
        headers: {
          // ajuda com alguns CDNs
          "User-Agent": "geraads-video-engine/1.0",
          Accept: "*/*",
        },
      },
      (res) => {
        const code = res.statusCode || 0;

        // Redirect
        if (code >= 300 && code < 400 && res.headers.location) {
          if (redirectsLeft <= 0) {
            return reject(new Error("Too many redirects"));
          }
          const nextUrl = new URL(res.headers.location, url).toString();
          res.resume();
          return downloadFile(nextUrl, dest, redirectsLeft - 1)
            .then(resolve)
            .catch(reject);
        }

        if (code < 200 || code >= 300) {
          res.resume();
          return reject(new Error(`Download failed: HTTP ${code}`));
        }

        const file = fs.createWriteStream(dest);
        res.pipe(file);

        file.on("finish", () => file.close(resolve));
        file.on("error", (err) => {
          try {
            fs.unlinkSync(dest);
          } catch {}
          reject(err);
        });
      }
    );

    req.on("error", reject);
    req.setTimeout(120000, () => {
      req.destroy(new Error("Download timeout"));
    });
  });
}

/** =========================
 *  FORMAT MAP (do seu app)
 *  ========================= */
function formatToWH(format) {
  // Você disse que o app manda algo tipo 9:16 / 16:9 / 1:1
  // Padrão: vertical 1080x1920
  const f = String(format || "9:16").trim();
  if (f === "16:9") return { w: 1920, h: 1080 };
  if (f === "1:1") return { w: 1080, h: 1080 };
  return { w: 1080, h: 1920 };
}

/** =========================
 *  AUTH
 *  ========================= */
function auth(req, res, next) {
  // Aceita: x-api-key: <chave>
  const apiKey = req.headers["x-api-key"];
  if (!API_KEY) return res.status(500).json({ error: "API_KEY not set on server" });
  if (apiKey !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  return next();
}

/** =========================
 *  ROUTES
 *  ========================= */
app.get("/", (req, res) => res.json({ status: "ok" }));

/**
 * POST /concat
 * headers: x-api-key
 * body:
 * {
 *   "videos": ["https://...","https://...","https://..."],
 *   "output_name": "G1K_G1C1A1_0403_....",
 *   "format": "9:16" | "16:9" | "1:1"
 * }
 */
app.post("/concat", auth, async (req, res) => {
  // roda em fila (evita travar Railway)
  return enqueueJob(async () => {
    const { videos, output_name, format } = req.body || {};

    if (!Array.isArray(videos) || videos.length < 2) {
      res.status(400).json({ error: "At least 2 video URLs required" });
      return;
    }

    const safeOutput = safeName(output_name);
    const { w, h } = formatToWH(format);

    const tmpDir = path.join("/tmp", `job-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    };

    // MUITO IMPORTANTE:
    // não apagar /tmp antes do download terminar
    res.on("finish", cleanup);
    res.on("close", cleanup);

    try {
      console.log(`[job] start: ${safeOutput} | videos=${videos.length} | format=${format || "9:16"}`);

      // 1) Download inputs
      const inputPaths = [];
      for (let i = 0; i < videos.length; i++) {
        const url = videos[i];
        if (!isUrl(url)) throw new Error(`Invalid video URL at index ${i}`);
        const inputPath = path.join(tmpDir, `input_${i}`);
        // salva sem extensão (ffmpeg/ffprobe aceitam)
        await downloadFile(url, inputPath);
        inputPaths.push(inputPath);
      }

      // 2) Normalize todos para MESMO codec/params + COR correta (evita vermelho / HDR bug)
      const normalizedPaths = [];

      // filtro PRO: pad + fps + bt709 + yuv420p
      const fps = 30;
      const vf =
        `scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,` +
        `setsar=1,` +
        `fps=${fps},` +
        // ✅ CORREÇÃO DEFINITIVA do "avermelhado" / HDR / iPhone
        `colorspace=all=bt709:iall=bt709,` +
        `format=yuv420p`;

      for (let i = 0; i < inputPaths.length; i++) {
        const inFile = inputPaths[i];
        const outFile = path.join(tmpDir, `norm_${i}.mp4`);

        const audioExists = hasAudioStream(inFile);

        // Se não tiver áudio: injeta silêncio (para não quebrar concat / player)
        // Se tiver áudio: usa o áudio original normalizado
        if (!audioExists) {
          run(
            "ffmpeg",
            [
              "-y",
              "-i",
              inFile,
              "-f",
              "lavfi",
              "-i",
              "anullsrc=channel_layout=stereo:sample_rate=44100",
              "-vf",
              vf,
              "-c:v",
              "libx264",
              "-preset",
              "veryfast",
              "-crf",
              "23",
              "-pix_fmt",
              "yuv420p",
              // tags de cor (ajudam players)
              "-color_primaries",
              "bt709",
              "-color_trc",
              "bt709",
              "-colorspace",
              "bt709",
              "-map",
              "0:v:0",
              "-map",
              "1:a:0",
              "-shortest",
              "-c:a",
              "aac",
              "-b:a",
              "128k",
              "-ar",
              "44100",
              "-ac",
              "2",
              "-movflags",
              "+faststart",
              outFile,
            ],
            { timeout: JOB_TIMEOUT_MS }
          );
        } else {
          run(
            "ffmpeg",
            [
              "-y",
              "-i",
              inFile,
              "-vf",
              vf,
              "-c:v",
              "libx264",
              "-preset",
              "veryfast",
              "-crf",
              "23",
              "-pix_fmt",
              "yuv420p",
              "-color_primaries",
              "bt709",
              "-color_trc",
              "bt709",
              "-colorspace",
              "bt709",
              // áudio “estável” (evita drift / cortes)
              "-c:a",
              "aac",
              "-b:a",
              "128k",
              "-ar",
              "44100",
              "-ac",
              "2",
              "-af",
              "aresample=async=1:first_pts=0",
              "-movflags",
              "+faststart",
              outFile,
            ],
            { timeout: JOB_TIMEOUT_MS }
          );
        }

        normalizedPaths.push(outFile);
      }

      // 3) Concat (agora dá pra fazer -c copy sem mismatch)
      const listPath = path.join(tmpDir, "list.txt");
      fs.writeFileSync(
        listPath,
        normalizedPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"),
        "utf8"
      );

      const outputPath = path.join(tmpDir, "output.mp4");

      run(
        "ffmpeg",
        [
          "-y",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          listPath,
          "-c",
          "copy",
          outputPath,
        ],
        { timeout: JOB_TIMEOUT_MS }
      );

      // sanity check
      if (!fs.existsSync(outputPath)) {
        throw new Error("Output file was not created");
      }

      // 4) Download (força attachment)
      // OBS: o download automático no front depende de como você dispara o request.
      // Do lado do servidor aqui fica certinho.
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", `attachment; filename="${safeOutput}.mp4"`);

      return await new Promise((resolve, reject) => {
        res.download(outputPath, `${safeOutput}.mp4`, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    } catch (err) {
      console.error("[job] error:", err?.message || err);
      // se já começou a responder arquivo, não dá pra mandar json
      if (!res.headersSent) {
        res.status(500).json({
          error: "FFmpeg processing failed",
          details: err?.message || String(err),
        });
      }
      cleanup();
    }
  });
});

app.listen(PORT, () => console.log(`FFmpeg server running on port ${PORT}`));
