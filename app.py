#!/usr/bin/env python3
"""
WebLinkChecker — Flask web application
"""

import json
import queue
import threading
import uuid
from urllib.parse import urlparse

from flask import Flask, Response, jsonify, render_template, request

from link_checker import LinkResult, build_session, crawl

app = Flask(__name__)

# In-memory job store: job_id -> {queue, stop_event, done}
_jobs: dict[str, dict] = {}


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/check", methods=["POST"])
def start_check():
    data = request.get_json(force=True) or {}
    url = (data.get("url") or "").strip()
    timeout = max(1, int(data.get("timeout") or 15))
    delay = max(0.0, float(data.get("delay") or 0.0))
    max_pages = max(0, int(data.get("maxPages") or 0))

    parsed = urlparse(url)
    if not parsed.scheme or not parsed.netloc:
        return jsonify({"error": "請輸入包含 http:// 或 https:// 的完整網址"}), 400

    job_id = str(uuid.uuid4())
    q: queue.Queue = queue.Queue()
    stop_event = threading.Event()
    _jobs[job_id] = {"queue": q, "stop_event": stop_event, "done": False}

    def run() -> None:
        try:
            session = build_session(timeout, "WebLinkChecker/1.0 (web)")

            def on_status(msg: str) -> None:
                q.put({"type": "status", "message": msg})

            def on_result(result: LinkResult) -> None:
                q.put({
                    "type": "result",
                    "url": result.url,
                    "status_code": result.status_code,
                    "error": result.error,
                    "is_broken": result.is_broken,
                    "status_label": result.status_label,
                    "found_on": result.found_on,
                    "link_text": result.link_text,
                })

            results = crawl(
                start_url=url,
                session=session,
                timeout=timeout,
                delay=delay,
                max_pages=max_pages,
                verbose=False,
                on_result=on_result,
                on_status=on_status,
                stop_event=stop_event,
            )
            total = len(results)
            broken = sum(1 for r in results.values() if r.is_broken)
            q.put({"type": "summary", "total": total, "broken": broken, "ok": total - broken})
        except Exception as exc:
            q.put({"type": "error", "message": str(exc)})
        finally:
            q.put(None)
            _jobs[job_id]["done"] = True

    threading.Thread(target=run, daemon=True).start()
    return jsonify({"job_id": job_id})


@app.route("/stream/<job_id>")
def stream(job_id: str):
    if job_id not in _jobs:
        return Response("Job not found", status=404)

    def generate():
        q = _jobs[job_id]["queue"]
        while True:
            try:
                item = q.get(timeout=30)
            except queue.Empty:
                yield ": keep-alive\n\n"
                continue
            if item is None:
                yield f"data: {json.dumps({'type': 'done'})}\n\n"
                break
            yield f"data: {json.dumps(item)}\n\n"

    return Response(
        generate(),
        content_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.route("/cancel/<job_id>", methods=["POST"])
def cancel(job_id: str):
    job = _jobs.get(job_id)
    if job:
        job["stop_event"].set()
        return jsonify({"cancelled": True})
    return jsonify({"error": "Job not found"}), 404


if __name__ == "__main__":
    app.run(debug=True, threaded=True, host="0.0.0.0", port=5000)
