const express = require("express");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const app = express();
app.use(express.json());

// Health check
app.get("/", (req, res) => res.json({ status: "ok" }));

app.post("/concat", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { videos, output_name, combo_id } = req.body;

  if (!videos || videos.length < 2) {
    return res.status(400).json({ error: "At least 2 video URLs required" });
  }

  const tmpDir = path.join("/tmp", `job-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // 1. Download all videos
    for (let i = 0; i < videos.length; i++) {
      const filePath = path.join(tmpDir, `input${i}.mp4`);
      await downloadFile(videos[i], filePath);
      console.log(`Downloaded: input${i}.mp4`);
    }

    // 2. Create concat list
    const concatList = videos
      .map((_, i) => `file '${path.join(tmpDir, `input${i}.mp4`)}'`)
      .join("\n");
    const listPath = path.join(tmpDir, "list.txt");
    fs.writeFileSync(listPath, concatList);

    // 3. Concatenate with FFmpeg
    const outputPath = path.join(tmpDir, "output.mp4");
    execSync(
  `ffmpeg -y -f concat -safe 0 -i "${listPath}" \
  -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p \
  -c:a aac -b:a 128k -ar 44100 -ac 2 \
  -af "aresample=async=1" -movflags +faststart "${outputPath}"`,
  { stdio: "pipe", timeout: 300000 }
);
    );
    console.log(`Concatenated: ${output_name}`);

    //4. Send file download
    await new Promise((resolve, reject) => {
  res.download(outputPath, `${output_name}.mp4`, (err) => {
    if (err) reject(err);
    else resolve();
  });

    });
  } catch (err) {
    console.error("FFmpeg error:", err.message);
    res.status(500).json({ error: "FFmpeg processing failed", details: err.message });
  } finally {
    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);
    mod.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
      }
      response.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
    }).on("error", (err) => { fs.unlink(dest, () => {}); reject(err); });
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg server running on port ${PORT}`));
