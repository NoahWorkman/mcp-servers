import { spawn } from "node:child_process";
import {
  TIMEOUTS,
  MAX_CONCURRENT,
  SIGKILL_GRACE_MS,
  STDERR_ERROR_PATTERNS,
} from "./constants.js";
import type { FfmpegTask, FfmpegResult } from "./types.js";
import { FfmpegError } from "./types.js";

// Concurrency semaphore -- prevents CPU starvation from parallel tool calls
function createSemaphore(max: number) {
  const queue: Array<() => void> = [];
  let current = 0;

  return {
    acquire(): Promise<void> {
      if (current < max) {
        current++;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        queue.push(resolve);
      });
    },
    release(): void {
      current--;
      const next = queue.shift();
      if (next) {
        current++;
        next();
      }
    },
  };
}

const semaphore = createSemaphore(MAX_CONCURRENT);

function extractErrors(stderr: string): string[] {
  const lines = stderr.split("\n");
  const errors: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && STDERR_ERROR_PATTERNS.some((p) => p.test(trimmed))) {
      errors.push(trimmed);
    }
  }
  return errors;
}

export async function execute(task: FfmpegTask): Promise<FfmpegResult> {
  const timeoutMs =
    task.timeoutMs ??
    (task.command === "ffprobe" ? TIMEOUTS.probe : TIMEOUTS.transform);

  await semaphore.acquire();

  return new Promise<FfmpegResult>((resolve, reject) => {
    const settled = { done: false };

    const finish = (
      result: FfmpegResult | null,
      error: FfmpegError | null,
    ) => {
      if (settled.done) return;
      settled.done = true;
      clearTimeout(timer);
      semaphore.release();
      if (error) {
        reject(error);
      } else {
        resolve(result!);
      }
    };

    let stdout = "";
    let stderr = "";

    const proc = spawn(task.command, [...task.args], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      const message =
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? `${task.command} not found on PATH. Install ffmpeg: https://ffmpeg.org/download.html`
          : `Failed to spawn ${task.command}: ${err.message}`;
      finish(null, FfmpegError.spawn(message));
    });

    proc.on("close", (code) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0) {
        const errors = extractErrors(stderr);
        finish(
          null,
          FfmpegError.process(
            `${task.description} failed (exit code ${exitCode})${errors.length > 0 ? ": " + errors.join("; ") : ""}`,
            exitCode,
            stderr,
            errors,
          ),
        );
      } else {
        finish({ stdout, stderr, exitCode: 0 }, null);
      }
    });

    const timer = setTimeout(() => {
      // Kill escalation: SIGTERM first, SIGKILL after grace period
      try {
        proc.kill("SIGTERM");
      } catch {
        // process may have already exited
      }
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // process may have already exited
        }
      }, SIGKILL_GRACE_MS);
      finish(
        null,
        FfmpegError.timeout(
          `${task.description} timed out after ${timeoutMs}ms`,
          timeoutMs,
        ),
      );
    }, timeoutMs);
  });
}

// Pre-flight check: verify binaries exist on PATH
export async function checkBinaries(): Promise<void> {
  for (const cmd of ["ffmpeg", "ffprobe"] as const) {
    try {
      await execute({
        command: cmd,
        args: ["-version"],
        description: `Check ${cmd} binary`,
        timeoutMs: 5_000,
      });
    } catch (err) {
      const error = err as FfmpegError;
      if (error._tag === "SpawnError") {
        throw new Error(error.message, { cause: err });
      }
      // Non-zero exit from -version is fine, as long as the binary exists
    }
  }
}
