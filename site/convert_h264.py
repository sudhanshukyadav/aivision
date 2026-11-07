"""
convert_h264.py — make camera MP4 clips playable in every browser before upload.

Runs on the SITE PC next to r2_watcher.py (V:\\cam\\). Browsers can't reliably
play H.265/HEVC, and an MP4 whose index ("moov atom") sits at the end won't
start streaming until fully downloaded. This helper:

  * already H.264  -> fast remux only (no re-encode), moov moved to the front
  * anything else  -> re-encode to H.264 (yuv420p) + AAC, moov at the front

Usage from r2_watcher.py (just before uploading a requested clip):

    from convert_h264 import ensure_h264
    upload_path = ensure_h264(local_mp4_path)      # returns a temp .mp4 to upload
    try:
        s3.upload_file(upload_path, BUCKET, key, ExtraArgs={"ContentType": "video/mp4"})
    finally:
        if upload_path != local_mp4_path:
            os.remove(upload_path)

Command line (to test, or to batch-convert a folder in place):

    python convert_h264.py S:\\HQ-AD\\motion\\gate\\20261107_001744_p14_t00_z128.mp4
    python convert_h264.py S:\\HQ-AD\\motion\\gate --in-place

Needs ffmpeg: either on PATH, set FFMPEG=C:\\path\\to\\ffmpeg.exe, or
`pip install imageio-ffmpeg` (ships its own ffmpeg binary).
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile

# Tuning: "veryfast" keeps a 10 s clip to a few seconds of CPU; CRF 23 is
# visually close to the source at a fraction of HEVC-to-H.264 size blowup.
PRESET = os.environ.get("H264_PRESET", "veryfast")
CRF = os.environ.get("H264_CRF", "23")
TIMEOUT_S = int(os.environ.get("H264_TIMEOUT", "300"))


def find_ffmpeg() -> str:
    explicit = os.environ.get("FFMPEG")
    if explicit and os.path.isfile(explicit):
        return explicit
    on_path = shutil.which("ffmpeg")
    if on_path:
        return on_path
    try:
        import imageio_ffmpeg  # type: ignore
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        pass
    raise RuntimeError(
        "ffmpeg not found: install it (winget install Gyan.FFmpeg), set FFMPEG=, "
        "or pip install imageio-ffmpeg"
    )


def probe(path: str, ffmpeg: str | None = None) -> dict:
    """Return {'video': codec or None, 'audio': codec or None} using `ffmpeg -i`."""
    ffmpeg = ffmpeg or find_ffmpeg()
    proc = subprocess.run(
        [ffmpeg, "-hide_banner", "-i", path],
        capture_output=True, text=True, errors="replace", timeout=60,
    )
    info = proc.stderr
    v = re.search(r"Stream #\S+.*?: Video: (\w+)", info)
    a = re.search(r"Stream #\S+.*?: Audio: (\w+)", info)
    if not v:
        raise RuntimeError(f"No video stream found in {path}:\n{info[-800:]}")
    return {"video": v.group(1).lower(), "audio": a.group(1).lower() if a else None}


def ensure_h264(src: str, dst: str | None = None) -> str:
    """
    Produce a browser-playable H.264 MP4 from `src`.
    Returns the path to upload: a new temp file (or `dst` if given).
    The source file is never modified.
    """
    ffmpeg = find_ffmpeg()
    codecs = probe(src, ffmpeg)

    if dst is None:
        fd, dst = tempfile.mkstemp(suffix=".mp4", prefix="h264_")
        os.close(fd)

    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", src, "-map", "0:v:0", "-map", "0:a:0?"]
    if codecs["video"] == "h264":
        cmd += ["-c:v", "copy"]                               # remux only — fast, lossless
    else:
        cmd += ["-c:v", "libx264", "-preset", PRESET, "-crf", CRF,
                "-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "4.1"]
    if codecs["audio"] in (None, "aac", "mp3"):
        cmd += ["-c:a", "copy"]
    else:                                                     # pcm_alaw/mulaw/etc. from IP cams
        cmd += ["-c:a", "aac", "-b:a", "96k"]
    cmd += ["-movflags", "+faststart", dst]

    proc = subprocess.run(cmd, capture_output=True, text=True, errors="replace", timeout=TIMEOUT_S)
    if proc.returncode != 0 or not os.path.getsize(dst):
        try:
            os.remove(dst)
        except OSError:
            pass
        raise RuntimeError(f"ffmpeg failed for {src}:\n{proc.stderr[-1500:]}")
    return dst


def _main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    target = argv[0]
    in_place = "--in-place" in argv
    files = (
        [os.path.join(target, f) for f in sorted(os.listdir(target)) if f.lower().endswith(".mp4")]
        if os.path.isdir(target) else [target]
    )
    failed = 0
    for f in files:
        try:
            before = probe(f)
            out = ensure_h264(f, None if in_place else os.path.splitext(f)[0] + "_h264.mp4")
            if in_place:
                shutil.move(out, f)                           # temp may be on another drive
                out = f
            print(f"OK  {f}  [{before['video']}/{before['audio']}] -> {out}  [{probe(out)['video']}]")
        except Exception as e:  # keep going through a folder
            failed += 1
            print(f"ERR {f}: {e}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
