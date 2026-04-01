import { execute } from "./execute.js";
import { ENCODING, PROTOCOL_WHITELIST, TIMEOUTS } from "./constants.js";
import type {
  MediaInfo,
  StreamInfo,
  FormatInfo,
  RawProbeOutput,
  RawProbeStream,
  RawProbeFormat,
  ValidationResult,
} from "./types.js";

export function safeFloat(value: string | undefined): number | undefined {
  if (value === undefined || value === "" || value === "N/A") return undefined;
  const n = parseFloat(value);
  return isNaN(n) ? undefined : n;
}

export function safeInt(value: string | number | undefined): number | undefined {
  if (value === undefined || value === "" || value === "N/A") return undefined;
  const n = typeof value === "number" ? value : parseInt(value, 10);
  return isNaN(n) ? undefined : n;
}

export function parseFrameRate(rate: string | undefined): number | undefined {
  if (!rate || rate === "0/0" || rate === "N/A") return undefined;
  const parts = rate.split("/");
  if (parts.length === 2) {
    const num = parseFloat(parts[0]!);
    const den = parseFloat(parts[1]!);
    if (den === 0 || isNaN(num) || isNaN(den)) return undefined;
    return Math.round((num / den) * 100) / 100;
  }
  return safeFloat(rate);
}

function toStreamInfo(raw: RawProbeStream): StreamInfo {
  return {
    index: raw.index,
    type: raw.codec_type ?? "unknown",
    codec: raw.codec_name ?? "unknown",
    codecLong: raw.codec_long_name ?? "unknown",
    width: safeInt(raw.width),
    height: safeInt(raw.height),
    frameRate: parseFrameRate(raw.r_frame_rate ?? raw.avg_frame_rate),
    duration: safeFloat(raw.duration),
    bitRate: safeFloat(raw.bit_rate),
    sampleRate: safeFloat(raw.sample_rate),
    channels: safeInt(raw.channels),
    channelLayout: raw.channel_layout,
    tags: raw.tags ?? {},
  };
}

function toFormatInfo(raw: RawProbeFormat): FormatInfo {
  return {
    filename: raw.filename ?? "unknown",
    formatName: raw.format_name ?? "unknown",
    formatLong: raw.format_long_name ?? "unknown",
    duration: safeFloat(raw.duration) ?? 0,
    size: safeFloat(raw.size) ?? 0,
    bitRate: safeFloat(raw.bit_rate) ?? 0,
    streamCount: safeInt(raw.nb_streams) ?? 0,
    tags: raw.tags ?? {},
  };
}

export function toMediaInfo(raw: RawProbeOutput): MediaInfo {
  const streams = (raw.streams ?? []).map(toStreamInfo);
  const videoStream = streams.find((s) => s.type === "video");
  const audioStream = streams.find((s) => s.type === "audio");
  const format = toFormatInfo(raw.format ?? ({} as RawProbeFormat));

  // Prefer stream-level duration when format duration is unreliable.
  // Container metadata can be stale after stream copies or format conversions.
  const maxStreamDuration = Math.max(
    ...streams.map((s) => s.duration ?? 0),
    0,
  );
  if (
    maxStreamDuration > 0 &&
    format.duration > 0 &&
    Math.abs(maxStreamDuration - format.duration) / format.duration > 0.1
  ) {
    return {
      format: { ...format, duration: maxStreamDuration },
      streams,
      videoStream,
      audioStream,
    };
  }

  return { format, streams, videoStream, audioStream };
}

export async function runProbe(filePath: string): Promise<MediaInfo> {
  const result = await execute({
    command: "ffprobe",
    args: [
      "-v", "quiet",
      "-protocol_whitelist", PROTOCOL_WHITELIST,
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      filePath,
    ],
    description: `Probe media: ${filePath}`,
    timeoutMs: TIMEOUTS.probe,
  });

  let raw: RawProbeOutput;
  try {
    raw = JSON.parse(result.stdout) as RawProbeOutput;
  } catch {
    throw new Error(
      `Failed to parse ffprobe output as JSON. Raw output: ${result.stdout.slice(0, 500)}`,
    );
  }

  return toMediaInfo(raw);
}

export async function findKeyframes(
  filePath: string,
  startTime?: number,
  endTime?: number,
): Promise<Array<{ time: number; position: number }>> {
  const args = [
    "-v", "error",
    "-protocol_whitelist", PROTOCOL_WHITELIST,
    "-select_streams", "v:0",
    "-show_entries", "packet=pts_time,pos,flags",
    "-of", "json",
    filePath,
  ];

  const result = await execute({
    command: "ffprobe",
    args,
    description: `Find keyframes: ${filePath}`,
    timeoutMs: TIMEOUTS.probe,
  });

  let parsed: { packets?: Array<{ pts_time?: string; pos?: string; flags?: string }> };
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `Failed to parse ffprobe keyframe output. Raw output: ${result.stdout.slice(0, 500)}`,
    );
  }

  const keyframes: Array<{ time: number; position: number }> = [];

  for (const pkt of parsed.packets ?? []) {
    if (!pkt.flags?.includes("K")) continue;

    const time = safeFloat(pkt.pts_time);
    const position = safeFloat(pkt.pos);
    if (time === undefined) continue;

    if (startTime !== undefined && time < startTime) continue;
    if (endTime !== undefined && time > endTime) continue;

    keyframes.push({ time, position: position ?? 0 });
  }

  return keyframes;
}

export function checkRenderReady(
  info: MediaInfo,
  trimStartSeconds?: number,
  keyframes?: Array<{ time: number; position: number }>,
): ValidationResult {
  const issues: string[] = [];

  // Check video codec
  if (info.videoStream) {
    const codec = info.videoStream.codec.toLowerCase();
    if (codec !== "h264") {
      issues.push(
        `Video codec is "${info.videoStream.codec}", expected h264. Use reencode_h264 to fix.`,
      );
    }
  } else {
    issues.push("No video stream found.");
  }

  // Check audio exists and sample rate
  if (info.audioStream) {
    const sampleRate = info.audioStream.sampleRate;
    if (sampleRate !== undefined && sampleRate !== ENCODING.audioSampleRate) {
      issues.push(
        `Audio sample rate is ${sampleRate}Hz, expected ${ENCODING.audioSampleRate}Hz. Use resample_audio to fix.`,
      );
    }
  } else {
    issues.push(
      "No audio stream found. This is fine for b-roll but will be silent if used as primary footage.",
    );
  }

  // Check keyframe alignment if trimStartSeconds provided
  if (
    trimStartSeconds !== undefined &&
    keyframes !== undefined &&
    keyframes.length > 0
  ) {
    let nearestDistance = Infinity;
    for (const kf of keyframes) {
      const distance = Math.abs(kf.time - trimStartSeconds);
      if (distance < nearestDistance) {
        nearestDistance = distance;
      }
    }
    if (nearestDistance > 0.5) {
      issues.push(
        `trimStartSeconds=${trimStartSeconds} is ${nearestDistance.toFixed(2)}s from the nearest keyframe. This may cause frozen frames. Nearest keyframes: ${keyframes
          .filter((kf) => Math.abs(kf.time - trimStartSeconds) <= 2)
          .map((kf) => kf.time.toFixed(3))
          .join(", ")}`,
      );
    }
  }

  return {
    ready: issues.length === 0,
    issues,
  };
}
