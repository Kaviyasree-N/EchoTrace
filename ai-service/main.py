"""
ai-service/main.py – EchoTrace AI Sound Classification Service
HTTP server running on port 5000
"""

import base64
import json
import logging
from http.server import BaseHTTPRequestHandler, HTTPServer
import sys

from config import HOST, PORT, TARGET_CLASSES
from audio_processor import decode_audio_payload
import detector

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("EchoTrace-AIService")


class AIServiceHandler(BaseHTTPRequestHandler):
    def _send_json(self, status_code: int, data: dict):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {
                "status": "ready" if detector.is_ready() else "loading",
                "model": "YAMNet",
                "classes_count": len(detector.get_classes()),
                "target_classes_count": len(TARGET_CLASSES),
            })
        elif self.path == "/classes":
            self._send_json(200, {
                "target_classes": TARGET_CLASSES,
                "all_classes": detector.get_classes()[:100],
            })
        else:
            self._send_json(404, {"error": "Not found"})

    def do_POST(self):
        if self.path == "/classify":
            content_length = int(self.headers.get("Content-Length", 0))
            if content_length == 0:
                self._send_json(400, {"error": "Empty audio payload"})
                return

            body = self.rfile.read(content_length)
            content_type = self.headers.get("Content-Type", "")

            samples = []
            if "application/json" in content_type:
                try:
                    payload = json.loads(body.decode("utf-8"))
                    if "samples" in payload and isinstance(payload["samples"], list):
                        samples = [float(x) for x in payload["samples"]]
                    elif "audio_base64" in payload:
                        raw_bytes = base64.b64decode(payload["audio_base64"])
                        samples = decode_audio_payload(raw_bytes, payload.get("format", ""))
                except Exception as exc:
                    self._send_json(400, {"error": f"Invalid JSON payload: {exc}"})
                    return
            else:
                samples = decode_audio_payload(body, content_type)

            result = detector.classify_waveform(samples)
            if result:
                self._send_json(200, {
                    "detected": True,
                    **result
                })
            else:
                self._send_json(200, {
                    "detected": False,
                    "sound_class": None,
                    "confidence": 0.0,
                    "message": "No target sound detected above confidence threshold"
                })
        else:
            self._send_json(404, {"error": "Not found"})


def run():
    detector.init_model()
    server_address = (HOST, PORT)
    httpd = HTTPServer(server_address, AIServiceHandler)
    logger.info(f"EchoTrace AI Inference Service running on http://{HOST}:{PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        logger.info("Stopping AI service...")
        httpd.server_close()


if __name__ == "__main__":
    run()
