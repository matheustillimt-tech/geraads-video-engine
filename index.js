const express = require("express");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const app = express();
app.use(express.json({ limit: "100mb" }));

// Health check
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
      error: "At least 2 videos required"
    });
  }

  const jobId = Date.now();
  const tmpDir = path.join("/tmp", `job-${jobId}`);

  fs.mkdirSync(tmpDir, { recursive: true });

  try {

    console.log("Starting job:", jobId);

    const localVideos = [];

    // Download dos vídeos
    for (let i = 0; i < videos.length; i++) {

      const filePath = path.join(tmpDir, `input${i}.mp4`);

      await downloadFile(videos[i], filePath);

      localVideos.push(filePath);
    }

    // Cria lista de concat
    const listFile = path.join(tmpDir, "list.txt");

    fs.writeFileSync(
      listFile,
      localVideos.map(v => `file '${v}'`).join("\n")
    );

    const output = path.join(tmpDir, "output.mp4");

    console.log("Running FFmpeg...");

    execSync(
      `ffmpeg -y -f concat -safe 0 -i "${listFile}" \
      -vf "scale=1080:-2,fps=30,format=yuv420p" \
      -c:v libx264 -preset ultrafast -crf 28 \
      -an \
      "${output}"`,
      { stdio: "pipe" }
    );

    if (!fs.existsSync(output)) {
      throw new Error("FFmpeg did not produce output file");
    }

    console.log("Render finished");

    res.download(output, `${output_name}.mp4`);

  } catch (error) {

    console.error("FFmpeg error:", error.message);

    res.status(500).json({
      error: "FFmpeg processing failed",
      details: error.message
    });

  } finally {

    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {
      console.log("Cleanup failed");
    }

  }

});

function downloadFile(url, dest) {

  return new Promise((resolve, reject) => {

    const mod = url.startsWith("https") ? https : http;

    const file = fs.createWriteStream(dest);

    mod.get(url, response => {

      // suporte a redirect
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

    }).on("error", err => {

      fs.unlink(dest, () => {});
      reject(err);

    });

  });

}

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("FFmpeg server running on port", PORT);
});
