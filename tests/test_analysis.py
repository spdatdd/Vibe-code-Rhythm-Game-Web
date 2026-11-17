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
        y = np.zeros(sr * 8, dtype=np.float32)
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
        self.assertAlmostEqual(result['duration'], 8, places=3)

    def test_silence(self):
        """Từ chối file im lặng thay vì tạo bản đồ nốt giả từ một BPM mặc định."""
        with tempfile.TemporaryDirectory() as directory:
            wav = Path(directory) / 'silence.wav'
            sf.write(wav, np.zeros(44100 * 6, dtype=np.float32), 44100)
            with self.assertRaises(ValueError):
                analyze(wav)


if __name__ == '__main__':
    unittest.main()
