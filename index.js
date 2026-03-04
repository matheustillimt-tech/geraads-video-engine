const express = require("express");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const app = express();
app.use(express.json({ limit: "100mb" }));

// health check
app.get("/", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/concat", async (req, res) => {

  const apiKey = req.headers["x-api-key"];

  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { videos, output_name } = req.body;

  if (!videos || videos.length < 2) {
    return res.status(400).json({
      error: "At least 2 video URLs required"
    });
  }

  const jobId = Date.now();
  const tmpDir = path.join("/tmp", `job-${jobId}`);

  fs.mkdirSync(tmpDir, { recursive: true });

  try {

    console.log("Starting render job:", jobId);

    const normalizedVideos = [];

    // ===============================
    // 1. DOWNLOAD + NORMALIZE VIDEOS
    // ===============================

    for (let i = 0; i < videos.length; i++) {

      const rawPath = path.join(tmpDir, `raw_${i}.mp4`);
      const normalizedPath = path.join(tmpDir, `input_${i}.mp4`);

      console.log("Downloading:", videos[i]);

      await downloadFile(videos[i], rawPath);

      console.log("Normalizing video:", i);

      execSync(
        `ffmpeg -y -i "${rawPath}" \
        -vf "scale=1080:-2:flags=lanczos,fps=30,format=yuv420p" \
        -c:v libx264 -preset fast -crf 23 \
        -c:a aac -ar 44100 -b:a 128k \
        -movflags +faststart "${normalizedPath}"`,
        { stdio: "pipe", timeout: 300000 }
      );

      normalizedVideos.push(normalizedPath);
    }

    // ===============================
    // 2. CREATE CONCAT LIST
    // ===============================

    const listPath = path.join(tmpDir, "list.txt");

    const concatList = normalizedVideos
      .map(v => `file '${v}'`)
      .join("\n");

    fs.writeFileSync(listPath, concatList);

    // ===============================
    // 3. CONCAT VIDEOS
    // ===============================

    const outputPath = path.join(tmpDir, "output.mp4");

    console.log("Concatenating videos...");

    execSync(
      `ffmpeg -y -f concat -safe 0 -i "${listPath}" -c copy "${outputPath}"`,
      { stdio: "pipe", timeout: 300000 }
    );

    console.log("Render finished");

    // ===============================
    // 4. SEND FILE
    // ===============================

    await new Promise((resolve, reject) => {

      res.download(outputPath, `${output_name}.mp4`, (err) => {

        if (err) reject(err);
        else resolve();

      });

    });

  } catch (error) {

    console.error("Render error:", error.message);

    res.status(500).json({
      error: "FFmpeg processing failed",
      details: error.message
    });

  } finally {

    // ===============================
    // CLEANUP
    // ===============================

    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {
      console.log("Cleanup failed");
    }

  }

});

// ===============================
// DOWNLOAD FUNCTION
// ===============================

function downloadFile(url, dest) {

  return new Promise((resolve, reject) => {

    const mod = url.startsWith("https") ? https : http;

    const file = fs.createWriteStream(dest);

    mod.get(url, (response) => {

      // redirect support
      if (
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        return downloadFile(response.headers.location, dest)
          .then(resolve)
          .catch(reject);
      }

      response.pipe(file);

      file.on("finish", () => {
        file.close();
        resolve();
      });

    }).on("error", (err) => {

      fs.unlink(dest, () => {});

      reject(err);

    });

  });

}

// ===============================
// SERVER
// ===============================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("FFmpeg render server running on port", PORT);
});
