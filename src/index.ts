#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { checkBinaries } from "./execute.js";
import { validateInputPath, validateOutputPath } from "./validate.js";
import { runProbe, findKeyframes, checkRenderReady } from "./ffprobe.js";
import {
  stripAudio,
  reencodeH264,
  resampleAudio,
  cropPortrait,
  extractAudio,
} from "./ffmpeg.js";
import type { TransformResult } from "./types.js";

const server = new McpServer({
  name: "mcp-server-ffmpeg",
  version: "0.1.0",
});

// --- Inspection Tools ---

server.tool(
  "probe",
  "Probe a media file and return structured metadata: format (duration, size, bitrate, tags) " +
    "and streams (codec, resolution, fps, sample_rate, channels, tags). " +
    "Use this to inspect any audio or video file before processing.",
  {
    path: z.string().describe("Absolute path to the media file"),
  },
  async ({ path }) => {
    await validateInputPath(path);
    const info = await runProbe(path);
    const text = JSON.stringify(info, null, 2);
    return {
      content: [{ type: "text" as const, text }],
    };
  },
);

server.tool(
  "find_keyframes",
  "Find keyframe (I-frame) timestamps in a video file. " +
    "Use this before trimming video -- landing between keyframes causes " +
    "frozen frames at the cut point. Optionally filter to a time range.",
  {
    path: z.string().describe("Absolute path to the video file"),
    startTime: z
      .number()
      .optional()
      .describe("Start of time range to search (seconds)"),
    endTime: z
      .number()
      .optional()
      .describe("End of time range to search (seconds)"),
  },
  async ({ path, startTime, endTime }) => {
    await validateInputPath(path);
    const keyframes = await findKeyframes(path, startTime, endTime);
    const text = JSON.stringify(
      {
        count: keyframes.length,
        keyframes,
      },
      null,
      2,
    );
    return {
      content: [{ type: "text" as const, text }],
    };
  },
);

server.tool(
  "check_render_ready",
  "Check if a media file meets production requirements. " +
    "Validates: video codec is H.264, audio sample rate is 48000Hz, " +
    "audio stream exists. If trimStartSeconds is provided, checks " +
    "keyframe alignment and warns if nearest keyframe is >0.5s away. " +
    "Returns a pass/fail with actionable fix suggestions.",
  {
    path: z.string().describe("Absolute path to the media file"),
    trimStartSeconds: z
      .number()
      .optional()
      .describe(
        "If set, checks keyframe alignment at this timestamp to prevent frozen frames",
      ),
  },
  async ({ path, trimStartSeconds }) => {
    await validateInputPath(path);
    const info = await runProbe(path);

    let keyframes: Array<{ time: number; position: number }> | undefined;
    if (trimStartSeconds !== undefined) {
      keyframes = await findKeyframes(
        path,
        Math.max(0, trimStartSeconds - 2),
        trimStartSeconds + 2,
      );
    }

    const validation = checkRenderReady(info, trimStartSeconds, keyframes);

    const text = JSON.stringify(
      {
        ready: validation.ready,
        issues: validation.issues,
        metadata: {
          codec: info.videoStream?.codec,
          resolution: info.videoStream
            ? `${info.videoStream.width}x${info.videoStream.height}`
            : null,
          frameRate: info.videoStream?.frameRate,
          audioSampleRate: info.audioStream?.sampleRate,
          audioChannels: info.audioStream?.channels,
          duration: info.format.duration,
          formatTags: info.format.tags,
        },
      },
      null,
      2,
    );

    return {
      content: [{ type: "text" as const, text }],
    };
  },
);

// --- Transformation Tools ---

function formatTransformResult(result: TransformResult): string {
  const lines: string[] = [];
  if (result.validation.ready) {
    lines.push("Validation: PASS (production-ready)");
  } else {
    lines.push("Validation: WARN (issues detected)");
    for (const issue of result.validation.issues) {
      lines.push(`  - ${issue}`);
    }
  }
  return JSON.stringify(
    {
      success: result.success,
      validation: result.validation,
      output: {
        codec: result.output.videoStream?.codec,
        resolution: result.output.videoStream
          ? `${result.output.videoStream.width}x${result.output.videoStream.height}`
          : null,
        audioSampleRate: result.output.audioStream?.sampleRate,
        duration: result.output.format.duration,
        size: result.output.format.size,
        tags: result.output.format.tags,
      },
      input: {
        codec: result.input.videoStream?.codec,
        resolution: result.input.videoStream
          ? `${result.input.videoStream.width}x${result.input.videoStream.height}`
          : null,
        audioSampleRate: result.input.audioStream?.sampleRate,
        duration: result.input.format.duration,
        size: result.input.format.size,
        tags: result.input.format.tags,
      },
    },
    null,
    2,
  );
}

server.tool(
  "strip_audio",
  "Remove the audio track from a video file. Video stream is copied without re-encoding. " +
    "Use this for b-roll clips where separate narration or music plays over the video.",
  {
    inputPath: z.string().describe("Absolute path to the input video file"),
    outputPath: z.string().describe("Absolute path for the output file"),
    stripMetadata: z
      .boolean()
      .optional()
      .default(false)
      .describe("If true, removes all metadata from output. Default preserves source metadata."),
  },
  async ({ inputPath, outputPath, stripMetadata }) => {
    await validateInputPath(inputPath);
    validateOutputPath(outputPath);
    const result = await stripAudio(inputPath, outputPath, stripMetadata);
    return {
      content: [{ type: "text" as const, text: formatTransformResult(result) }],
    };
  },
);

server.tool(
  "reencode_h264",
  "Re-encode a video file to H.264 codec. Use this to fix VP9/WebM files that cause " +
    "compatibility issues in video editors and web players. Audio stream is copied without " +
    "re-encoding. Includes faststart flag for web playback.",
  {
    inputPath: z.string().describe("Absolute path to the input video file"),
    outputPath: z.string().describe("Absolute path for the output file (.mp4)"),
    crf: z
      .number()
      .min(0)
      .max(51)
      .optional()
      .default(23)
      .describe("Constant Rate Factor: 0=lossless, 23=default, 51=worst quality"),
    stripMetadata: z
      .boolean()
      .optional()
      .default(false)
      .describe("If true, removes all metadata from output. Default preserves source metadata."),
  },
  async ({ inputPath, outputPath, crf, stripMetadata }) => {
    await validateInputPath(inputPath);
    validateOutputPath(outputPath);
    const result = await reencodeH264(inputPath, outputPath, crf, stripMetadata);
    return {
      content: [{ type: "text" as const, text: formatTransformResult(result) }],
    };
  },
);

server.tool(
  "resample_audio",
  "Resample audio to a target sample rate. Defaults to 48000Hz, the standard for video " +
    "production. 44.1kHz audio causes silent drift that compounds over the duration of " +
    "the video. Video stream is copied without re-encoding.",
  {
    inputPath: z.string().describe("Absolute path to the input media file"),
    outputPath: z.string().describe("Absolute path for the output file"),
    sampleRate: z
      .number()
      .optional()
      .default(48000)
      .describe("Target sample rate in Hz. Default 48000."),
    stripMetadata: z
      .boolean()
      .optional()
      .default(false)
      .describe("If true, removes all metadata from output. Default preserves source metadata."),
  },
  async ({ inputPath, outputPath, sampleRate, stripMetadata }) => {
    await validateInputPath(inputPath);
    validateOutputPath(outputPath);
    const result = await resampleAudio(inputPath, outputPath, sampleRate, stripMetadata);
    return {
      content: [{ type: "text" as const, text: formatTransformResult(result) }],
    };
  },
);

server.tool(
  "crop_portrait",
  "Crop a landscape (16:9) video to portrait (9:16) format. Calculates crop dimensions " +
    "from source resolution and scales to target size. Audio is stripped. " +
    "Use xOffset to control which horizontal slice of the frame is visible.",
  {
    inputPath: z.string().describe("Absolute path to the input video file"),
    outputPath: z.string().describe("Absolute path for the output file"),
    xOffset: z
      .number()
      .min(0)
      .describe(
        "Horizontal pixel offset for the crop window. 0=left edge, higher values shift right. " +
          "For 1920x1080 source: 0=left, 656=center, 1313=right edge.",
      ),
    targetWidth: z
      .number()
      .optional()
      .default(1080)
      .describe("Output width in pixels. Default 1080."),
    targetHeight: z
      .number()
      .optional()
      .default(1920)
      .describe("Output height in pixels. Default 1920."),
    stripMetadata: z
      .boolean()
      .optional()
      .default(false)
      .describe("If true, removes all metadata from output. Default preserves source metadata."),
  },
  async ({ inputPath, outputPath, xOffset, targetWidth, targetHeight, stripMetadata }) => {
    await validateInputPath(inputPath);
    validateOutputPath(outputPath);
    const result = await cropPortrait(
      inputPath,
      outputPath,
      xOffset,
      targetWidth,
      targetHeight,
      stripMetadata,
    );
    return {
      content: [{ type: "text" as const, text: formatTransformResult(result) }],
    };
  },
);

server.tool(
  "extract_audio",
  "Extract the audio track from a video file. Outputs WAV (PCM 16-bit) or MP3. " +
    "Always resamples to 48000Hz. Useful for voice isolation or audio-only workflows.",
  {
    inputPath: z.string().describe("Absolute path to the input video file"),
    outputPath: z.string().describe("Absolute path for the output audio file (.wav or .mp3)"),
    format: z
      .enum(["wav", "mp3"])
      .optional()
      .default("wav")
      .describe("Output format. WAV for lossless, MP3 for smaller files."),
    stripMetadata: z
      .boolean()
      .optional()
      .default(false)
      .describe("If true, removes all metadata from output. Default preserves source metadata."),
  },
  async ({ inputPath, outputPath, format, stripMetadata }) => {
    await validateInputPath(inputPath);
    validateOutputPath(outputPath);
    const result = await extractAudio(inputPath, outputPath, format, stripMetadata);
    return {
      content: [{ type: "text" as const, text: formatTransformResult(result) }],
    };
  },
);

async function main() {
  try {
    await checkBinaries();
  } catch (err) {
    console.error(
      `Pre-flight check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP FFmpeg server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

export { server };
