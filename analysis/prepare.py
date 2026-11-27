"""Tải video YouTube, tách âm thanh nén + nền không tiếng và gọi bộ phân tích DSP."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.tools' / 'python'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
os.environ.setdefault('NUMBA_CACHE_DIR', str(ROOT / '.cache' / 'numba'))

from dsp import analyze, report


def create_background(ffmpeg, source, target, codec):
    """Tạo MP4 chỉ có hình, giới hạn độ phân giải và bỏ track âm thanh."""
    temporary = target.with_name('background-part.mp4')
    encoding = ['-c:v', 'copy'] if codec.startswith('avc1') else [
        '-vf', "scale=-2:'min(360,ih)',fps=24", '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-threads', '2',
    ]
    try:
        subprocess.run([ffmpeg, '-nostdin', '-v', 'error', '-y', '-i', str(source),
                        '-map', '0:v:0', '-an', '-t', '600', *encoding,
                        '-movflags', '+faststart', str(temporary)], check=True,
                       timeout=180, capture_output=True)
        temporary.replace(target)
        return True
    except (OSError, subprocess.SubprocessError):
        return False
    finally:
        temporary.unlink(missing_ok=True)


def prepare(video_id, directory, node):
    """Tải video công khai, tạo nền không tiếng và phân tích bản âm thanh dùng khi chơi."""
    import imageio_ffmpeg
    import yt_dlp

    if not re.fullmatch(r'[\w-]{11}', video_id):
        raise ValueError('ID YouTube không hợp lệ.')
    directory.mkdir(parents=True, exist_ok=True)
    report('downloading', 5, 'Đang đọc thông tin bài nhạc từ YouTube…')

    def progress_hook(data):
        """Chuyển tiến độ tải âm thanh sang phần trăm của toàn bộ quá trình chuẩn bị."""
        if data.get('status') == 'downloading':
            total = data.get('total_bytes') or data.get('total_bytes_estimate') or 0
            fraction = min(1, data.get('downloaded_bytes', 0) / total) if total else 0
            report('downloading', round(10 + 30 * fraction), 'Đang tải video và âm thanh…')

    def filter_video(info, *, incomplete=False):
        """Giới hạn video tối đa mười phút và từ chối livestream trước khi tải."""
        if info.get('is_live') or info.get('live_status') == 'is_live':
            return 'Không hỗ trợ livestream; hãy chọn một bài nhạc đã hoàn tất.'
        if info.get('duration') and info['duration'] > 600:
            return 'Bản thử nghiệm hỗ trợ video dài tối đa 10 phút.'
        return None

    options = {'format': 'best[height<=360][ext=mp4][vcodec^=avc1]/best[height<=360]/bestaudio',
               'outtmpl': str(directory / 'source.%(ext)s'),
               'noplaylist': True, 'quiet': True, 'noprogress': True, 'no_warnings': True, 'restrictfilenames': True,
               'socket_timeout': 25, 'retries': 2, 'fragment_retries': 2, 'max_filesize': 100 * 1024 * 1024,
               'match_filter': filter_video, 'progress_hooks': [progress_hook],
               'js_runtimes': {'node': {'path': node}}, 'cachedir': str(ROOT / '.cache' / 'ytdlp')}
    with yt_dlp.YoutubeDL(options) as downloader:
        info = downloader.extract_info('https://www.youtube.com/watch?v=' + video_id, download=True)
        if not info or info.get('is_live') or not info.get('duration') or info['duration'] > 600:
            raise ValueError('Chỉ hỗ trợ video nhạc đã hoàn tất, dài tối đa 10 phút.')
        source_path = Path(downloader.prepare_filename(info))
        if not source_path.is_file():
            raise ValueError('Không tải được âm thanh. Video có thể bị giới hạn hoặc quá lớn.')
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    report('decoding', 45, 'Đang chuẩn bị âm thanh nén và video nền…')
    audio_path = directory / 'audio-v3.mp3'
    analysis_wav = directory / 'analysis-part.wav'
    try:
        subprocess.run([
            ffmpeg, '-nostdin', '-v', 'error', '-y', '-i', str(source_path),
            '-vn', '-t', '600', '-ar', '44100', '-ac', '2', '-c:a', 'libmp3lame', '-q:a', '2', str(audio_path),
            '-vn', '-t', '600', '-ar', '22050', '-ac', '1', '-c:a', 'pcm_s16le', str(analysis_wav),
        ], check=True, timeout=150, capture_output=True)
        codec = info.get('vcodec') or 'none'
        has_video = codec != 'none' and create_background(ffmpeg, source_path, directory / 'background.mp4', codec)
        if not has_video:
            report('decoding', 49, 'Đang tìm luồng hình riêng để làm nền…')
            video_options = dict(options, format='bestvideo[height<=360]', outtmpl=str(directory / 'visual.%(ext)s'),
                                 progress_hooks=[])
            try:
                with yt_dlp.YoutubeDL(video_options) as downloader:
                    visual = downloader.extract_info('https://www.youtube.com/watch?v=' + video_id, download=True)
                    if visual:
                        visual_path = Path(downloader.prepare_filename(visual))
                        try:
                            if visual_path.is_file():
                                has_video = create_background(ffmpeg, visual_path, directory / 'background.mp4',
                                                              visual.get('vcodec') or '')
                        finally:
                            visual_path.unlink(missing_ok=True)
            except yt_dlp.utils.DownloadError:
                pass
        report('analyzing', 55, 'Đang khởi động bộ phân tích; lần đầu có thể mất vài phút…')
        result = analyze(analysis_wav)
    finally:
        analysis_wav.unlink(missing_ok=True)
    result.update({'videoId': video_id, 'title': info.get('title', video_id), 'version': 3, 'hasVideo': has_video})
    temporary = directory / 'result.tmp'
    temporary.write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
    temporary.replace(directory / 'result.json')
    for legacy in ('audio.wav', 'audio-v2.wav'):
        (directory / legacy).unlink(missing_ok=True)
    source_path.unlink(missing_ok=True)
    report('ready', 100, 'Đã phân tích xong. Đang nạp âm thanh vào game…')


def main():
    """Đọc tham số CLI và trả lỗi có thể hiển thị an toàn cho người dùng."""
    parser = argparse.ArgumentParser()
    parser.add_argument('--id', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--node', required=True)
    args = parser.parse_args()
    try:
        prepare(args.id, Path(args.output), args.node)
    except Exception as error:
        report('error', 0, str(error)[-1200:])
        sys.exit(1)


if __name__ == '__main__':
    main()
