#!/usr/bin/env bash
# Sets up demucs for the /dub stem-separation feature.
# Run once per machine. Safe to re-run (idempotent).
#
# Version pins — do not upgrade without testing:
#   demucs    4.0.1  — latest stable stem separation model
#   torchaudio 2.9.0 — torchaudio 2.10+ ships a torchaudio that hardcodes torchcodec
#                       as the only audio backend, and the torchcodec that loads with
#                       torch 2.9.x is 0.9.0. Newer torchcodec versions have an ABI
#                       mismatch (missing _aoti_torch_aten_full symbol).
#   torchcodec 0.9.0 — must match torch 2.9.x ABI; 0.10+ requires newer torch
#   ffmpeg (system)  — torchcodec links against system FFmpeg shared libs at runtime;
#                       ffmpeg-static (used by Node) is not sufficient
set -euo pipefail

echo "==> Checking prerequisites..."

# FFmpeg (needed by torchcodec for audio I/O)
if ! command -v ffmpeg &>/dev/null; then
  echo "==> Installing FFmpeg via Homebrew..."
  brew install ffmpeg
else
  echo "    ffmpeg ok ($(ffmpeg -version 2>&1 | head -1))"
fi

# pipx
if ! command -v pipx &>/dev/null; then
  echo "==> Installing pipx via Homebrew..."
  brew install pipx
else
  echo "    pipx ok ($(pipx --version))"
fi

# demucs — pinned, do not upgrade automatically
if pipx list | grep -q "package demucs 4.0.1"; then
  echo "    demucs 4.0.1 ok"
elif pipx list | grep -q "demucs"; then
  echo "    WARNING: demucs is installed but not at 4.0.1. Reinstalling..."
  pipx uninstall demucs
  pipx install "demucs==4.0.1"
else
  echo "==> Installing demucs 4.0.1..."
  pipx install "demucs==4.0.1"
fi

VENV_PYTHON="$HOME/.local/pipx/venvs/demucs/bin/python"

# Pin torchaudio to 2.9.0 (newer versions require torchcodec that is incompatible)
TORCHAUDIO_VERSION=$("$VENV_PYTHON" -c "import torchaudio; print(torchaudio.__version__)" 2>/dev/null || echo "none")
if [ "$TORCHAUDIO_VERSION" != "2.9.0" ]; then
  echo "==> Pinning torchaudio to 2.9.0 (installed: $TORCHAUDIO_VERSION)..."
  "$VENV_PYTHON" -m pip install "torchaudio==2.9.0" --quiet
else
  echo "    torchaudio 2.9.0 ok"
fi

# torchcodec 0.9.0 — must match torch version in the demucs venv
TORCHCODEC_VERSION=$("$VENV_PYTHON" -c "import torchcodec; print(torchcodec.__version__)" 2>/dev/null || echo "none")
if [ "$TORCHCODEC_VERSION" != "0.9.0" ]; then
  echo "==> Installing torchcodec 0.9.0 (installed: $TORCHCODEC_VERSION)..."
  "$VENV_PYTHON" -m pip install "torchcodec==0.9.0" --quiet
else
  echo "    torchcodec 0.9.0 ok"
fi

echo ""
echo "==> Verifying demucs can run..."
if demucs --help &>/dev/null; then
  echo "    demucs ok"
else
  echo "    ERROR: demucs not on PATH. Add ~/.local/bin to your PATH:"
  echo "    echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc && source ~/.zshrc"
  exit 1
fi

echo ""
echo "Done. Stem separation is ready."
echo "Note: first separation on a new track downloads the htdemucs model (~300MB)."
