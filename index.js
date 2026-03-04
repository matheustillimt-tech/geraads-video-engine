const express = require("express");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const app = express();
app.use(express.json({ limit: "20mb" }));

// ---------- Helpers ----------
function sh(cmd, opts = {}) {
  return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], timeout: 300000, ...opts }).toString("utf8");
}

function ffprobe(filePath) {
  try {
    const out = sh(`ffprobe -v error -print_format json -show_streams -show_format "${filePath}"`);
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function isHDR(probeJson) {
  const v = probeJson?.streams?.find((s) => s.codec_type === "video");
  if (!v) return false;

  const transfer = (v.color_transfer || "").toLowerCase();
  const primaries = (v.color_primaries || "").toLowerCase();
  const matrix = (v.colorspace || v.color_space || "").toLowerCase();

  const transferIsHdr =
    transfer.includes("smpte2084") || // PQ (HDR10 / Dolby base)
    transfer.includes("arib-std-b67") || // HLG
    transfer.includes("hlg");

  const wideGamut = primaries.includes("bt2020") || matrix.includes("bt2020");

  return transferIsHdr || wideGamut;
}

function buildVf({ w, h, fps, hdr }) {
  if (hdr) {
    // HDR -> SDR (bt709) + normalização
    return [
      `zscale=t=linear:npl=100`,
      `tonemap=tonemap=hable:desat=0`,
      `zscale=p=bt709:t=bt709:m=bt709`,
      `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
      `setsar=1`,
      `fps=${fps}`,
      `format=yuv420p`,
    ].join(",");
  }

  // SDR normal, mantém natural e consistente
  return [
    `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
    `setsar=1`,
    `fps=${fps}`,
    `colorspace=iall=bt709:all=bt709:fast=1`,
    `format=yuv420p`,
  ].join(",");
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);

    mod
      .get(url, (response) => {
        // redirect
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          file.close(() => fs.unlink(dest, () => {}));
          return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
        }

        if (response.statusCode !== 200) {
          file.close(() => fs.unlink(dest, () => {}));
          return reject(new Error(`Download failed (${response.statusCode}) for ${url}`));
        }

        response.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", (err) => {
        file.close(() => fs.unlink(dest, () => {}));
        reject(err);
      });
  });
}

function normalizeClip(inputPath, outputPath, format) {
  const probe = ffprobe(inputPath);
  const hdr = isHDR(probe);
  const vf = buildVf({ w: format.w, h: format.h, fps: format.fps, hdr });

  // Normaliza vídeo e garante áudio AAC (mesmo se vier sem áudio)
  // -map 0:a? permite "se tiver áudio, usa; se não tiver, ok"
  sh(
    `ffmpeg -y -i "${inputPath}" ` +
      `-vf "${vf}" ` +
      `-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p ` +
      `-color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv ` +
      `-c:a aac -b:a 128k -ar 44100 -ac 2 -map 0:v:0 -map 0:a? ` +
      `-movflags +faststart "${outputPath}"`
  );
}

function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch {}
}

// ---------- Health ----------
app.get("/", (req, res) => res.json({ status: "ok" }));

// ---------- Main ----------
app.post("/concat", async (req, res) => {
  try {
    // Auth
    const apiKey = req.headers["x-api-key"];
    if (!process.env.API_KEY) {
      return res.status(500).json({ error: "Server misconfigured: API_KEY not set" });
    }
    if (apiKey !== process.env.API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { videos, output_name, format } = req.body;

    if (!videos || !Array.isArray(videos) || videos.length < 2) {
      return res.status(400).json({ error: "At least 2 video URLs required" });
    }

    // format esperado vindo do seu app (9:16 / 16:9 / 1:1)
    // Se não vier, default 9:16
    const f = format || "9:16";
    const formatMap = {
      "9:16": { w: 1080, h: 1920, fps: 30 },
      "16:9": { w: 1920, h: 1080, fps: 30 },
      "1:1": { w: 1080, h: 1080, fps: 30 },
    };
    const chosen = formatMap[f] || formatMap["9:16"];

    const tmpDir = path.join("/tmp", `job-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    // garante cleanup só depois que a resposta terminar
    res.on("finish", () => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    // 1) Download inputs
    const rawPaths = [];
    for (let i = 0; i < videos.length; i++) {
      const raw = path.join(tmpDir, `raw_${i}.mp4`); // extensão aqui é “nome”, ffmpeg lê mesmo se vier mov
      await downloadFile(videos[i], raw);
      rawPaths.push(raw);
    }

    // 2) Normalize each clip (resolve HDR, fps, size, audio)
    const normPaths = [];
    for (let i = 0; i < rawPaths.length; i++) {
      const norm = path.join(tmpDir, `norm_${i}.mp4`);
      normalizeClip(rawPaths[i], norm, chosen);
      normPaths.push(norm);
    }

    // 3) Concat (agora tudo “igual”: H264 + AAC + mesmo fps/size)
    const listPath = path.join(tmpDir, "list.txt");
    const concatList = normPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
    fs.writeFileSync(listPath, concatList);

    const outputPath = path.join(tmpDir, "output.mp4");

    sh(
      `ffmpeg -y -f concat -safe 0 -i "${listPath}" ` +
        `-c copy -movflags +faststart "${outputPath}"`
    );

    if (!fs.existsSync(outputPath)) {
      return res.status(500).json({ error: "Output not created" });
    }

    // 4) Download response (força download)
    const finalName = `${(output_name || "video").replace(/[^\w\-]/g, "_")}.mp4`;
    res.download(outputPath, finalName, (err) => {
      if (err) {
        console.error("Download error:", err?.message || err);
      }
      // cleanup é feito no res.finish
    });
  } catch (err) {
    console.error("FFmpeg server error:", err?.message || err);
    return res.status(500).json({
      error: "FFmpeg processing failed",
      details: err?.message || String(err),
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg server running on port ${PORT}`));
