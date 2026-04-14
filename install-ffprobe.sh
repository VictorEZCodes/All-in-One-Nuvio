#!/bin/bash
# Install ffprobe (part of ffmpeg) for stream probing on Render
# Render runs on Ubuntu/Debian — uses apt-get

if command -v ffprobe &> /dev/null; then
    echo "ffprobe already installed: $(ffprobe -version | head -1)"
    exit 0
fi

echo "Installing ffmpeg (includes ffprobe)..."
apt-get update -qq && apt-get install -y -qq ffmpeg 2>/dev/null

if command -v ffprobe &> /dev/null; then
    echo "ffprobe installed: $(ffprobe -version | head -1)"
else
    echo "WARNING: ffprobe install failed — audio probing will be unavailable"
fi
