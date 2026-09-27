"""Single shared JSON search queue for all bot processes (stdlib only).

Only this service exposes a host port. SearXNG remains on the compose network.
One upstream search at a time, with a full second AFTER completion before the
next search. Cache hits and coalesced requests do not consume an upstream slot.
"""

import hashlib
import json
import logging
import os
import hmac
import re
import threading
import time
from collections import Counter, OrderedDict
from concurrent.futures import Future, TimeoutError
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from queue import Queue
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urlsplit
from urllib.request import Request, urlopen


@dataclass(frozen=True)
class Reply:
    status: int
    body: bytes
    content_type: str = "application/json"
    retry_after: int = 0


def error_reply(status, message, retry_after=0):
    return Reply(status, json.dumps({"error": message}).encode(), retry_after=retry_after)


def search_path(path):
    """Canonicalize transport encoding/order, but preserve query semantics."""
    parts = urlsplit(path)
    if parts.path != "/search":
        raise ValueError("Use GET /search?format=json&q=...")
    pairs = parse_qsl(parts.query, keep_blank_values=True, max_num_fields=20)
    params = dict(pairs)
    allowed = {"q", "format", "language", "categories", "safesearch", "engines", "pageno", "time_range"}
    if len(params) != len(pairs) or params.keys() - allowed:
        raise ValueError("Unknown or duplicate search parameter")
    if params.get("format") != "json" or not params.get("q", "").strip():
        raise ValueError("A nonempty q and format=json are required")
    if len(params["q"]) > 2000:
        raise ValueError("Query too long")
    params["q"] = params["q"].strip()
    # SearXNG adds category engines to an explicit engines list. Do not silently
    # contact Wikipedia when a caller requests Bing alone (including probes).
    if params.get("engines") and params.get("categories") == "general":
        params.pop("categories")
    return "/search?" + urlencode(sorted(params.items()))


def request_path(path):
    parts = urlsplit(path)
    if parts.scheme or parts.netloc or parts.fragment:
        raise ValueError("Use a relative API path")
    if parts.path == "/search":
        return search_path(path)
    if not re.fullmatch(r"/wikipedia/[a-z]{2,3}(?:-[a-z]+)?", parts.path):
        raise ValueError("Unknown API path")
    pairs = parse_qsl(parts.query, keep_blank_values=True, max_num_fields=20)
    params = dict(pairs)
    allowed = {"action", "format", "list", "prop", "srsearch", "srlimit", "srnamespace",
               "cmtitle", "cmtype", "cmlimit", "explaintext", "exintro", "exsentences",
               "exlimit", "titles", "redirects"}
    if len(params) != len(pairs) or params.keys() - allowed or len(parts.query) > 12000:
        raise ValueError("Unknown, duplicate or oversized Wikipedia parameter")
    if params.get("action") != "query" or params.get("format") != "json":
        raise ValueError("Only Wikipedia action=query&format=json is supported")
    if params.get("list") not in (None, "search", "categorymembers") or params.get("prop") not in (None, "extracts"):
        raise ValueError("Unsupported Wikipedia query")
    if not params.get("list") and not params.get("prop"):
        raise ValueError("Wikipedia list or prop is required")
    return parts.path + "?" + urlencode(sorted(params.items()))


def retry_seconds(value):
    try:
        seconds = int(value)
    except (TypeError, ValueError):
        try:
            seconds = int(parsedate_to_datetime(value).timestamp() - time.time())
        except (TypeError, ValueError, OverflowError):
            seconds = 180
    return max(1, min(seconds, 3600))


class SearchQueue:
    def __init__(self, fetch, *, interval=1.0, capacity=8, queue_timeout=10.0,
                 cache_ttl=300.0, degraded_ttl=15.0, cache_size=256, cooldown=180.0,
                 wiki_cache_ttl=21600.0, cache_bytes=16 * 1024 * 1024):
        self.fetch = fetch
        self.interval = interval
        self.capacity = capacity
        self.queue_timeout = queue_timeout
        self.cache_ttl = cache_ttl
        self.degraded_ttl = degraded_ttl
        self.cache_size = cache_size
        self.wiki_cache_ttl = wiki_cache_ttl
        self.cache_bytes = cache_bytes
        self.cooldown = cooldown
        self.blocked_until = 0.0
        self.lock = threading.Lock()
        self.jobs = Queue()
        self.pending = {}
        self.cache = OrderedDict()
        self.counts = Counter()
        self.sources = {}
        self.last_search = None
        self.worker = threading.Thread(target=self._run, daemon=True)
        self.worker.start()

    def submit(self, path, source="other"):
        # Source is observability only, never part of the cache key.
        if source not in {"grounding", "knowledge-card", "radio", "topic-song", "character", "probe", "calendar", "calendar-wiki", "research-page"}:
            source = "other"
        with self.lock:
            self.counts["requests"] += 1
            counts = self.sources.setdefault(source, Counter())
            counts["requests"] += 1
            cached = self.cache.pop(path, None)
            if cached and cached[0] > time.monotonic():
                self.cache[path] = cached
                self.counts["cache_hits"] += 1
                counts["cache_hits"] += 1
                future = Future()
                future.set_result(cached[1])
                return future, "hit"
            if path in self.pending:
                self.counts["coalesced"] += 1
                counts["coalesced"] += 1
                return self.pending[path], "shared"
            future = Future()
            if self.blocked_until > time.monotonic():
                self.counts["cooldown_rejected"] += 1
                future.set_result(error_reply(429, "Upstream cooldown", max(1, int(self.blocked_until - time.monotonic()) + 1)))
                return future, "cooldown"
            if len(self.pending) >= self.capacity:
                self.counts["rejected"] += 1
                future.set_result(error_reply(503, "Search queue full"))
                return future, "rejected"
            self.pending[path] = future
            self.jobs.put((path, source, time.monotonic() + self.queue_timeout, future))
            return future, "miss"

    def snapshot(self):
        with self.lock:
            return {**self.counts, "pending": len(self.pending), "cache_entries": len(self.cache),
                    "sources": {k: dict(v) for k, v in self.sources.items()},
                    "last_search": self.last_search,
                    "cooldown_seconds": max(0, round(self.blocked_until - time.monotonic()))}

    def _run(self):
        next_start = 0.0
        while True:
            job = self.jobs.get()
            if job is None:
                return
            path, source, deadline, future = job
            remaining = min(max(next_start, self.blocked_until), deadline) - time.monotonic()
            if remaining > 0:
                time.sleep(remaining)
            if time.monotonic() >= deadline:
                reply = error_reply(503, "Search queue wait expired")
                with self.lock:
                    self.counts["expired"] += 1
                    self.pending.pop(path)
                    future.set_result(reply)
                continue  # Never send stale queued work to the engines.
            started = time.monotonic()
            ttl = 0
            summary = {}
            limited = False
            try:
                reply = self.fetch(path)
                if reply.status == 200:
                    body = json.loads(reply.body)
                    if not isinstance(body, dict):
                        raise ValueError("Invalid search JSON")
                    if path.startswith("/search?"):
                        if not isinstance(body.get("results"), list):
                            raise ValueError("Invalid search results")
                        summary = {"results": len(body["results"]),
                                   "infoboxes": len(body.get("infoboxes", [])),
                                   "unresponsive_engines": body.get("unresponsive_engines", [])}
                        limited = any("too many requests" in str(e).lower() for e in summary["unresponsive_engines"])
                        ttl = self.degraded_ttl if summary["unresponsive_engines"] else self.cache_ttl
                    elif "error" in body:
                        code = str(body["error"].get("code", "unknown"))
                        limited = code in ("ratelimited", "maxlag")
                        reply = error_reply(429 if limited else 502, "Wikipedia API error: " + code)
                    elif "query" not in body:
                        raise ValueError("Invalid Wikipedia JSON")
                    else:
                        ttl = self.wiki_cache_ttl
            except Exception as error:
                # No URLs/query text in logs: grounding may contain user material.
                logging.warning("Search upstream request failed: %s", type(error).__name__)
                reply = error_reply(502, "Search upstream unavailable or invalid JSON")
            # Completion spacing also prevents delayed engine starts overlapping.
            next_start = time.monotonic() + self.interval
            summary.update(status=reply.status, source=source,
                           elapsed_ms=round((time.monotonic() - started) * 1000),
                           query_id=hashlib.sha256(path.encode()).hexdigest()[:12])
            with self.lock:
                if reply.status == 429 or limited:
                    self.blocked_until = time.monotonic() + (reply.retry_after or self.cooldown)
                self.counts["upstream"] += 1
                self.sources[source]["upstream"] += 1
                if reply.status != 200:
                    self.counts["errors"] += 1
                if summary.get("unresponsive_engines"):
                    self.counts["degraded"] += 1
                self.last_search = summary
                if ttl > 0:
                    self.cache[path] = (time.monotonic() + ttl, reply)
                    while (len(self.cache) > self.cache_size or
                           sum(len(entry[1].body) for entry in self.cache.values()) > self.cache_bytes):
                        self.cache.popitem(last=False)
                self.pending.pop(path)
                future.set_result(reply)
            logging.info("search %s", json.dumps(summary, ensure_ascii=False))

    def close(self):
        self.jobs.put(None)
        self.worker.join(timeout=30)


def upstream_fetch(base_url, path):
    if path.startswith("/wikipedia/"):
        parts = urlsplit(path)
        language = parts.path.removeprefix("/wikipedia/")
        url = f"https://{language}.wikipedia.org/w/api.php?{parts.query}&maxlag=5"
    else:
        url = base_url + path
    request = Request(url, headers={"Accept": "application/json",
        "User-Agent": "bot-tan-search-gateway/1.0 (https://github.com/suibari/bsky-affirmative-bot)"})
    try:
        response = urlopen(request, timeout=15)
    except HTTPError as error:
        response = error
    with response:
        body = response.read(4 * 1024 * 1024 + 1)
        if len(body) > 4 * 1024 * 1024:
            raise ValueError("Search response too large")
        return Reply(response.status, body, response.headers.get("Content-Type", "application/json"),
                     retry_seconds(response.headers.get("Retry-After")) if response.status == 429 else 0)


class GatewayServer(ThreadingHTTPServer):
    # Cap waiting HTTP handlers too, including callers sharing an in-flight job.
    daemon_threads = True

    def __init__(self, address, searches, fetch, api_key):
        self.searches = searches
        self.fetch = fetch
        self.api_key = api_key
        self.slots = threading.BoundedSemaphore(32)
        super().__init__(address, Handler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            try:
                request.settimeout(1)
                request.sendall(b"HTTP/1.0 503 Service Unavailable\r\nContent-Length: 0\r\nRetry-After: 1\r\n\r\n")
            finally:
                self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            request.settimeout(5)
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass  # Default access logs would contain private query strings.

    def do_GET(self):
        cache = "none"
        try:
            authorized = hmac.compare_digest(self.headers.get("Authorization", "").encode(), ("Bearer " + self.server.api_key).encode())
            if self.path != "/healthz" and not authorized:
                reply = error_reply(401, "API key required")
            elif self.path in ("/healthz", "/config"):
                reply = self.server.fetch(self.path)
            elif self.path == "/stats":
                reply = Reply(200, json.dumps(self.server.searches.snapshot()).encode())
            else:
                path = request_path(self.path)
                future, cache = self.server.searches.submit(path, self.headers.get("X-Search-Source", "other"))
                # Queue expiry (10s) + upstream deadline (15s); client uses 30s.
                reply = future.result(timeout=26)
        except ValueError as error:
            reply = error_reply(400, str(error))
        except TimeoutError:
            reply = error_reply(504, "Search deadline exceeded")
        except (URLError, OSError):
            reply = error_reply(502, "Search upstream unavailable")
        try:
            self.send_response(reply.status)
            self.send_header("Content-Type", reply.content_type)
            self.send_header("Content-Length", str(len(reply.body)))
            self.send_header("X-Search-Cache", cache)
            if reply.status == 503:
                self.send_header("Retry-After", "1")
            elif reply.status == 429:
                self.send_header("Retry-After", str(reply.retry_after or 180))
            self.end_headers()
            self.wfile.write(reply.body)
        except (BrokenPipeError, ConnectionResetError):
            pass


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    upstream = os.environ.get("SEARXNG_UPSTREAM", "http://searxng:8080").rstrip("/")
    api_key = os.environ["SEARCH_GATEWAY_API_KEY"]
    if len(api_key) < 32:
        raise ValueError("SEARCH_GATEWAY_API_KEY must contain at least 32 characters")
    fetch = lambda path: upstream_fetch(upstream, path)
    searches = SearchQueue(fetch)
    GatewayServer(("0.0.0.0", 8080), searches, fetch, api_key).serve_forever()
