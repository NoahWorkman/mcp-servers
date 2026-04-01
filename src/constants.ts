import os from "node:os";

export const ENCODING = {
  videoCodec: "libx264",
  audioCodec: "aac",
  crf: 23,
  preset: "medium",
  pixelFormat: "yuv420p",
  movFlags: "+faststart",
  audioSampleRate: 48000,
  audioBitrate: "192k",
} as const;

export const TIMEOUTS = {
  probe: 30_000,
  transform: 300_000,
} as const;

export const MAX_CONCURRENT = os.cpus().length;

export const SIGKILL_GRACE_MS = 5_000;

export const ALLOWED_EXTENSIONS = new Set([
  ".mp4", ".mkv", ".webm", ".mov", ".avi",
  ".wav", ".mp3", ".aac", ".flac", ".m4a",
  ".ts", ".mts", ".m2ts", ".ogg", ".opus",
]);

export const DANGEROUS_PATH_CHARS = /[;&|`{}<>]/;

export const MIN_FILE_SIZE = 1024;

export const PROTOCOL_WHITELIST = "file,pipe";

export const STDERR_ERROR_PATTERNS = [
  /No such file or directory/i,
  /Invalid data found/i,
  /Unrecognized option/i,
  /Error while/i,
  /does not contain/i,
  /Invalid argument/i,
  /Permission denied/i,
  /already exists\. Overwrite/i,
  /Conversion failed/i,
  /Output file is empty/i,
];
