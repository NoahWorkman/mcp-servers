# Smoke Test Plan

Restart Claude Code, then paste this entire block and let the MCP tools do the work.

---

## The prompt

Paste this into a fresh Claude Code session:

```
I want to test my ffmpeg MCP. Run through these steps and tell me what works and what doesn't. Use the MCP tools (probe, find_keyframes, check_render_ready, strip_audio, reencode_h264, resample_audio, crop_portrait, extract_audio) -- NOT raw ffmpeg commands.

Use /tmp/mcp-test/ as the output directory. Create it first.

### Step 1: Probe (structured metadata)
Probe this file and tell me what codec, resolution, sample rate, and metadata tags it has:
/Users/noahworkman-studiom4/Downloads/01-hook-scroll-stopper.mp4

### Step 2: Check render ready (should pass)
Check if that same file is production-ready.

### Step 3: Probe a WebM file (should flag issues)
Probe this file:
/Users/noahworkman-studiom4/Downloads/From Working On A Farm To $60,000 A Month- How Ken Eurich Turned Social Media Into A 'Real Job'.webm

Then check if it's production-ready. It should flag the codec.

### Step 4: Fix the WebM file
Re-encode the WebM to H.264. Output to /tmp/mcp-test/fixed.mp4
Then check if the output is production-ready. It should pass now.

### Step 5: Find keyframes
Find keyframes in the fixed.mp4 file between 0 and 10 seconds.

### Step 6: Strip audio
Strip audio from the fixed.mp4 file. Output to /tmp/mcp-test/broll.mp4
Verify the output has no audio stream.

### Step 7: Resample audio
Resample audio on the original scroll-stopper to 44100Hz (intentionally wrong).
Output to /tmp/mcp-test/bad-sample-rate.mp4
Then check if it's production-ready. It should flag the 44100Hz.
Then fix it by resampling back to 48000Hz. Output to /tmp/mcp-test/fixed-audio.mp4

### Step 8: Crop portrait
Crop the fixed.mp4 to portrait (9:16) with xOffset=400. Output to /tmp/mcp-test/portrait.mp4

### Step 9: Extract audio
Extract audio from the scroll-stopper as WAV. Output to /tmp/mcp-test/voice.wav

### After all steps
Summarize: which tools worked, which failed, and any issues you noticed with the MCP responses (missing info, confusing output, slow performance, etc).
```

---

## What you're testing

| Step | Tool | What it proves |
|------|------|---------------|
| 1 | `probe` | Structured JSON comes back with tags |
| 2 | `check_render_ready` | Pass case works |
| 3 | `probe` + `check_render_ready` | Fail case catches VP9/WebM |
| 4 | `reencode_h264` + `check_render_ready` | Transform + validation gate works end-to-end |
| 5 | `find_keyframes` | Keyframe search returns structured data |
| 6 | `strip_audio` | Audio removal + validation confirms no audio |
| 7 | `resample_audio` x2 + `check_render_ready` | Catches bad sample rate, fixes it |
| 8 | `crop_portrait` | Landscape to portrait crop works |
| 9 | `extract_audio` | Audio extraction to WAV works |

## What to watch for

- **Timeouts**: The WebM re-encode (step 4) might be slow on a large file. If it times out, note it.
- **Validation gate**: After every transform, check the validation section. Does it correctly flag issues? Does it pass when it should?
- **Error messages**: If a tool fails, is the error message clear enough to act on?
- **Missing info**: Is there anything you wanted to see in the output that wasn't there?
- **Performance**: How long do the transforms take? Are probes fast?
