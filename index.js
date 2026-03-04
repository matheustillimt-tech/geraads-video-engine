const express = require("express");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const app = express();
app.use(express.json({ limit: "100mb" }));

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

    console.log("JOB:", jobId);

    const localVideos = [];

    // DOWNLOAD DOS VÍDEOS
    for (let i = 0; i < videos.length; i++) {

      const filePath = path.join(tmpDir, `input${i}.mp4`);

      console.log("Downloading:", videos[i]);

      await downloadFile(videos[i], filePath);

      localVideos.push(filePath);
    }

    const listFile = path.join(tmpDir, "list.txt");

    fs.writeFileSync(
      listFile,
      localVideos.map(v => `file '${v}'`).join("\n")
    );

    const output = path.join(tmpDir, "output.mp4");

    console.log("Running FFmpeg");

    execSync(
      `ffmpeg -y -f concat -safe 0 -i "${listFile}" \
      -vf "scale=1080:-2,fps=30" \
      -c:v libx264 -preset ultrafast -crf 28 \
      -an \
      "${output}"`,
      { stdio: "inherit" }
    );

    if (!fs.existsSync(output)) {
      throw new Error("FFmpeg did not create output file");
    }

    console.log("Render done");

    res.download(output, `${output_name}.mp4`);

  } catch (error) {

    console.error("FFmpeg failed:", error);

    res.status(500).json({
      error: "FFmpeg processing failed",
      details: error.message
    });

  } finally {

    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}

  }

});

function downloadFile(url, dest) {

  return new Promise((resolve, reject) => {

    const mod = url.startsWith("https") ? https : http;

    const file = fs.createWriteStream(dest);

    mod.get(url, response => {

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
