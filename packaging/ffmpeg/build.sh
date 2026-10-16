#!/usr/bin/env bash
# Minimal static ffmpeg + ffprobe for YT Music → MP3.
#
# A full ffmpeg build is ~150 MB; the app only needs to read YouTube audio
# (Opus/AAC/Vorbis), write MP3 through LAME and embed tags + a JPEG cover.
# This build does exactly that and ends up at a few MB.
#
#   packaging/ffmpeg/build.sh linux   <out-dir>   # native x86_64 Linux
#   packaging/ffmpeg/build.sh windows <out-dir>   # cross-compiled with mingw-w64
#
# Needs: build-essential, nasm, curl (and mingw-w64 for windows).
# Sources: FFMPEG_SRC / LAME_SRC may point at existing checkouts/tarballs.
set -euo pipefail

TARGET=${1:-linux}
OUT=$(mkdir -p "${2:-dist/ffmpeg}" && cd "${2:-dist/ffmpeg}" && pwd)
FFMPEG_REF=${FFMPEG_REF:-n8.0}
LAME_VERSION=3.100
WORK=${WORK:-$(mktemp -d)}
PREFIX="$WORK/prefix"
JOBS=$(nproc 2>/dev/null || echo 4)
mkdir -p "$PREFIX"

case "$TARGET" in
  linux)   HOST=""; EXE="" ;;
  windows) HOST=x86_64-w64-mingw32; EXE=".exe" ;;
  *) echo "unknown target: $TARGET" >&2; exit 1 ;;
esac

# --- LAME (MP3 encoder, LGPL) ---
cd "$WORK"
if [ -n "${LAME_SRC:-}" ]; then cp "$LAME_SRC" lame.tar.gz
else curl -fsSL --retry 5 --retry-delay 3 -o lame.tar.gz "https://downloads.sourceforge.net/project/lame/lame/$LAME_VERSION/lame-$LAME_VERSION.tar.gz"; fi
tar xzf lame.tar.gz
cd "lame-$LAME_VERSION"
# lame 3.100 lists a symbol that no longer exists; newer toolchains refuse it.
sed -i '/lame_init_old/d' include/libmp3lame.sym
./configure --prefix="$PREFIX" ${HOST:+--host=$HOST} --enable-static --disable-shared \
  --disable-frontend --disable-decoder --disable-gtktest --enable-nasm CFLAGS="-O2" >/dev/null
make -j"$JOBS" >/dev/null
make install >/dev/null

# --- ffmpeg ---
cd "$WORK"
if [ -n "${FFMPEG_SRC:-}" ]; then cp -r "$FFMPEG_SRC" ffmpeg
else git clone -q --depth 1 --branch "$FFMPEG_REF" https://github.com/FFmpeg/FFmpeg.git ffmpeg; fi
cd ffmpeg

CROSS=()
if [ "$TARGET" = windows ]; then
  CROSS=(--target-os=mingw32 --arch=x86_64 --cross-prefix=$HOST- --extra-ldflags="-static -static-libgcc")
else
  CROSS=(--extra-ldflags="-static" --pkg-config-flags=--static)
fi

./configure \
  --prefix="$PREFIX" "${CROSS[@]}" \
  --extra-cflags="-I$PREFIX/include -O2" --extra-ldflags="-L$PREFIX/lib" \
  --disable-everything --disable-autodetect --disable-debug --disable-doc \
  --disable-network --disable-ffplay --disable-avdevice \
  --enable-static --disable-shared --enable-small \
  --enable-ffmpeg --enable-ffprobe --enable-swresample --enable-swscale --enable-avfilter \
  --enable-libmp3lame \
  --enable-protocol=file,pipe \
  --enable-demuxer=matroska,mov,mp3,ogg,wav,aac,flac,image2,image_jpeg_pipe,image_webp_pipe \
  --enable-decoder=opus,aac,aac_latm,vorbis,mp3,mp3float,flac,pcm_s16le,pcm_f32le,mjpeg,webp \
  --enable-encoder=libmp3lame,mjpeg \
  --enable-muxer=mp3,mp4,ipod,ogg,opus,webm,matroska,image2,mjpeg \
  --enable-parser=opus,aac,vorbis,mpegaudio,flac,mjpeg,webp \
  --enable-bsf=aac_adtstoasc,setts,mjpeg2jpeg,null \
  --enable-filter=aresample,aformat,anull,null,format,scale,crop,volume,abuffer,abuffersink,buffer,buffersink,copy,acopy \
  > configure.out || { tail -20 configure.out; exit 1; }
make -j"$JOBS" >/dev/null

STRIP=${HOST:+$HOST-}strip
$STRIP "ffmpeg$EXE" "ffprobe$EXE"
cp "ffmpeg$EXE" "ffprobe$EXE" "$OUT/"
ls -la "$OUT"
