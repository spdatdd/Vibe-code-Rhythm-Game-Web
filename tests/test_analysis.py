"""Kiểm tra phân tích với âm thanh tổng hợp biết trước thời điểm đánh nốt."""
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.tools' / 'python'))
sys.path.insert(0, str(ROOT / 'analysis'))
import numpy as np
import soundfile as sf
from prepare import analyze


class AnalysisTests(unittest.TestCase):
    """Kiểm tra biến thiên tempo và trường hợp không có âm thanh để tạo chart."""

    def test_variable_onsets(self):
        """Các nốt piano tổng hợp đổi tốc độ vẫn phải có onset gần thời điểm gốc."""
        sr = 44100
        times = [.7, 1.2, 1.7, 2.2, 2.65, 3.05, 3.4, 3.72, 4.03, 4.31, 4.59, 4.89, 5.22, 5.6, 6.1, 6.7]
        # Đặt thêm nốt sát ranh giới giữa hai đoạn phân tích (khoảng 17,833 giây).
        times += [17.63, 17.84, 18.12, 18.55, 19.11]
        y = np.zeros(sr * 20, dtype=np.float32)
        for i, onset in enumerate(times):
            t = np.arange(int(sr * .22)) / sr
            attack = np.minimum(1, t / .004) * np.exp(-t * 18)
            tone = .6 * attack * (np.sin(2 * np.pi * (220 + i * 27) * t) + .3 * np.sin(2 * np.pi * (440 + i * 54) * t))
            start = int(onset * sr)
            y[start:start + len(t)] += tone
        with tempfile.TemporaryDirectory() as directory:
            wav = Path(directory) / 'fixture.wav'
            sf.write(wav, y, sr, subtype='PCM_16')
            result = analyze(wav)
        found = [event['time'] for event in result['events']]
        errors = [min(abs(point - onset) for point in found) for onset in times]
        self.assertLess(max(errors), .065)
        self.assertAlmostEqual(result['duration'], 20, places=3)

    def test_silence(self):
        """Từ chối file im lặng thay vì tạo bản đồ nốt giả từ một BPM mặc định."""
        with tempfile.TemporaryDirectory() as directory:
            wav = Path(directory) / 'silence.wav'
            sf.write(wav, np.zeros(44100 * 6, dtype=np.float32), 44100)
            with self.assertRaises(ValueError):
                analyze(wav)

    def test_native_22050_mono(self):
        """Đường phân tích trực tiếp 22.05 kHz mono không cần resample vẫn giữ đúng onset."""
        sr = 22050
        times = [.6, 1.1, 1.6, 2.1, 2.6, 3.1, 3.6, 4.1, 4.6, 5.1]
        y = np.zeros(sr * 7, dtype=np.float32)
        for onset in times:
            t = np.arange(int(sr * .18)) / sr
            tone = .7 * np.minimum(1, t / .004) * np.exp(-t * 20) * np.sin(2 * np.pi * 330 * t)
            start = int(onset * sr)
            y[start:start + len(t)] += tone
        with tempfile.TemporaryDirectory() as directory:
            wav = Path(directory) / 'mono22k.wav'
            sf.write(wav, y, sr, subtype='PCM_16')
            result = analyze(wav)
        found = [event['time'] for event in result['events']]
        errors = [min(abs(point - onset) for point in found) for onset in times]
        self.assertLess(max(errors), .05)
        self.assertEqual(result['sampleRate'], 22050)
        self.assertTrue(all(0.0 <= event['beatScore'] <= 1.0 for event in result['events']))
        self.assertTrue(any(event['beatScore'] > 0.5 for event in result['events']))


if __name__ == '__main__':
    unittest.main()
