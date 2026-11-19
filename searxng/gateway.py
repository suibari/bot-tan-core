"""Single shared JSON search queue for all bot processes (stdlib only).

Web search goes to paid APIs on their free monthly allowance (Tavily first, then
Exa), answered in the SearXNG JSON shape the bots already parse. The Wikipedia
API is relayed as before. One upstream request at a time, spaced by `interval`
AFTER completion. Cache hits and coalesced requests do not consume a slot.

Why not SearXNG any more (2026-11-19): scraping Yahoo from the home line got the
IPv4 address poisoned (fake results / HTTP 500) in early November, and after the
move to IPv6 on 11-08 the whole /64 followed on 11-14. Free API allowances are
small, so each provider has a daily budget persisted to disk (see DailyBudget).
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
from datetime import datetime, timedelta, timezone
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
    # "budget" = our own daily allowance ran out. Unlike an upstream 429 it must not
    # pause the Wikipedia API, so the queue does not start the shared cooldown for it.
    scope: str = "upstream"


def error_reply(status, message, retry_after=0, scope="upstream"):
    return Reply(status, json.dumps({"error": message}).encode(), retry_after=retry_after, scope=scope)


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
    # Accepted for compatibility with the SearXNG-era clients, but the APIs have no
    # categories, so they must not split the cache. engines= naming only API providers
    # ("exa,tavily") is the caller's preferred order and is kept; SearXNG engine names
    # ("yahoo,bing,...") are dropped.
    for name in ("categories", "safesearch", "pageno"):
        params.pop(name, None)
    order = [item.strip() for item in params.pop("engines", "").split(",") if item.strip()]
    if order and all(item in PROVIDERS for item in order):
        params["engines"] = ",".join(order)
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


JST = timezone(timedelta(hours=9))


class DailyBudget:
    """Per-provider daily allowance, persisted so a restart does not hand out a fresh one.

    Limits come from the free monthly allowance divided by 31 (Tavily 1,000 credits ->
    32/day, Exa $10 at $0.004 per lite search incl. snippets -> 80/day). The day turns
    over at midnight JST. A provider that answers "quota exceeded" is closed for the day.
    """

    def __init__(self, limits, path=None, now=lambda: datetime.now(JST)):
        self.limits = dict(limits)
        self.path = path
        self.now = now
        self.lock = threading.Lock()
        self.day = self._today()
        self.used = Counter()
        if path:
            try:
                with open(path, encoding="utf-8") as file:
                    saved = json.load(file)
                if saved.get("day") == self.day:
                    self.used.update({str(k): int(v) for k, v in saved.get("used", {}).items()})
            except (OSError, ValueError, TypeError, AttributeError):
                pass  # Missing or broken file: start the day empty.

    def _today(self):
        return self.now().strftime("%Y-%m-%d")

    def _roll(self):
        today = self._today()
        if today != self.day:
            self.day, self.used = today, Counter()

    def _save(self):
        if not self.path:
            return
        tmp = self.path + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as file:
                json.dump({"day": self.day, "used": dict(self.used)}, file)
            os.replace(tmp, self.path)
        except OSError as error:
            logging.warning("Could not persist search budget: %s", type(error).__name__)

    def available(self):
        with self.lock:
            self._roll()
            return any(self.used[name] < limit for name, limit in self.limits.items())

    def take(self, name):
        with self.lock:
            self._roll()
            if self.used[name] >= self.limits.get(name, 0):
                return False
            self.used[name] += 1
            self._save()
            return True

    def refund(self, name):
        """Give back a slot for a request the provider did not bill (network error, 5xx)."""
        with self.lock:
            if self.used[name] > 0:
                self.used[name] -= 1
                self._save()

    def close_for_today(self, name):
        with self.lock:
            self.used[name] = max(self.used[name], self.limits.get(name, 0))
            self._save()

    def seconds_until_reset(self):
        now = self.now()
        tomorrow = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        return max(1, int((tomorrow - now).total_seconds()))

    def snapshot(self):
        with self.lock:
            self._roll()
            return {"day": self.day, "used": dict(self.used), "limits": dict(self.limits)}


class ProviderError(Exception):
    def __init__(self, message, *, quota=False):
        super().__init__(message)
        self.quota = quota


# HTTP statuses that mean "this key cannot search any more today" (auth or allowance).
# Tavily uses 432/433 for plan/pay-as-you-go limits; Exa uses 402 when credits run out.
QUOTA_STATUSES = {401, 402, 403, 432, 433}


def post_json(url, headers, body, timeout=12):
    request = Request(url, data=json.dumps(body).encode(), method="POST", headers={
        "Content-Type": "application/json", "Accept": "application/json", **headers})
    try:
        response = urlopen(request, timeout=timeout)
    except HTTPError as error:
        raise ProviderError(f"HTTP {error.code}", quota=error.code in QUOTA_STATUSES) from None
    with response:
        data = response.read(4 * 1024 * 1024 + 1)
    if len(data) > 4 * 1024 * 1024:
        raise ProviderError("response too large")
    return json.loads(data)


def tavily_search(key, query, language):
    body = {"query": query, "search_depth": "basic", "max_results": 10}
    if language == "ja":
        body["country"] = "japan"
    data = post_json("https://api.tavily.com/search", {"Authorization": "Bearer " + key}, body)
    return [{"title": item.get("title") or "", "url": item.get("url") or "",
             "content": item.get("content") or "", "engine": "tavily"}
            for item in data.get("results") or [] if isinstance(item, dict)]


def exa_search(key, query, language):
    # "lite" is the cheapest type; snippets (contents.text) are included in its price
    # (measured costDollars 0.004 for 10 results with text, 2026-11-19).
    data = post_json("https://api.exa.ai/search", {"x-api-key": key}, {
        "query": query, "type": "lite", "numResults": 10,
        "contents": {"text": {"maxCharacters": 400}}})
    return [{"title": item.get("title") or "", "url": item.get("url") or "",
             "content": item.get("text") or "", "engine": "exa",
             **({"publishedDate": item["publishedDate"]} if item.get("publishedDate") else {})}
            for item in data.get("results") or [] if isinstance(item, dict)]


PROVIDERS = {"tavily": tavily_search, "exa": exa_search}


def api_search(path, providers, budget):
    """Answer GET /search from the first provider that has allowance left.

    providers: list of (name, search_fn, key). Returns a SearXNG-shaped JSON Reply.
    """
    params = dict(parse_qsl(urlsplit(path).query, keep_blank_values=True))
    query, language = params["q"], params.get("language", "ja")
    # Caller's preferred order first (live research asks for the fast one), then the rest.
    preferred = [item for item in params.get("engines", "").split(",") if item]
    providers = sorted(providers, key=lambda entry: preferred.index(entry[0]) if entry[0] in preferred else len(preferred))
    tried = []
    for name, search, key in providers:
        if not budget.take(name):
            continue
        try:
            results = search(key, query, language)
        except ProviderError as error:
            if error.quota:
                budget.close_for_today(name)
            else:
                budget.refund(name)
            tried.append(f"{name}: {error}")
            continue
        except (URLError, OSError, ValueError) as error:
            budget.refund(name)
            tried.append(f"{name}: {type(error).__name__}")
            continue
        body = {"query": query, "results": [item for item in results if item["url"] and item["title"]],
                "infoboxes": [], "unresponsive_engines": [], "provider": name}
        return Reply(200, json.dumps(body, ensure_ascii=False).encode())
    if not tried:
        return error_reply(429, "Daily web search budget exhausted",
                           min(budget.seconds_until_reset(), 3600), scope="budget")
    logging.warning("All search providers failed: %s", "; ".join(tried))
    return error_reply(502, "Search providers unavailable")


class SearchQueue:
    def __init__(self, fetch, *, interval=1.0, capacity=8, queue_timeout=10.0,
                 cache_ttl=300.0, cache_size=256, cooldown=180.0,
                 wiki_cache_ttl=21600.0, cache_bytes=16 * 1024 * 1024, budget=None):
        self.fetch = fetch
        self.interval = interval
        self.capacity = capacity
        self.queue_timeout = queue_timeout
        self.cache_ttl = cache_ttl
        self.budget = budget
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
        if source not in {"grounding", "knowledge-card", "radio", "topic-song", "character", "probe", "calendar", "calendar-wiki", "research-page", "live-research"}:
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
            # Out of allowance: answer now instead of queueing. Cache hits above still work.
            if self.budget and path.startswith("/search?") and not self.budget.available():
                self.counts["budget_rejected"] += 1
                counts["budget_rejected"] += 1
                future.set_result(error_reply(429, "Daily web search budget exhausted",
                                              min(self.budget.seconds_until_reset(), 3600), scope="budget"))
                return future, "budget"
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
                    "cooldown_seconds": max(0, round(self.blocked_until - time.monotonic())),
                    **({"budget": self.budget.snapshot()} if self.budget else {})}

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
                        summary = {"results": len(body["results"]), "provider": body.get("provider")}
                        ttl = self.cache_ttl
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
                if (reply.status == 429 and reply.scope == "upstream") or limited:
                    self.blocked_until = time.monotonic() + (reply.retry_after or self.cooldown)
                self.counts["upstream"] += 1
                self.sources[source]["upstream"] += 1
                if reply.status != 200:
                    self.counts["errors"] += 1
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


def wikipedia_fetch(path):
    parts = urlsplit(path)
    if not parts.path.startswith("/wikipedia/"):
        raise ValueError("Not a Wikipedia path")
    language = parts.path.removeprefix("/wikipedia/")
    url = f"https://{language}.wikipedia.org/w/api.php?{parts.query}&maxlag=5"
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
            elif self.path == "/healthz":
                # Liveness of the gateway itself. Spending allowance on a health probe is
                # pointless, and the APIs do not poison results the way scraping did.
                reply = Reply(200, b'{"status": "ok"}')
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


def configured_providers(env):
    """Providers in WEB_SEARCH_PROVIDERS order that have an API key, with daily limits."""
    providers, limits = [], {}
    defaults = {"tavily": 32, "exa": 80}
    for name in [item.strip() for item in env.get("WEB_SEARCH_PROVIDERS", "tavily,exa").split(",") if item.strip()]:
        if name not in PROVIDERS:
            raise ValueError(f"Unknown search provider: {name}")
        key = env.get(f"{name.upper()}_API_KEY", "").strip()
        if not key:
            logging.warning("Search provider %s has no API key; skipped", name)
            continue
        providers.append((name, PROVIDERS[name], key))
        limits[name] = int(env.get(f"{name.upper()}_DAILY_LIMIT", defaults[name]))
    if not providers:
        raise ValueError("No web search provider has an API key")
    return providers, limits


def make_fetch(providers, budget):
    return lambda path: api_search(path, providers, budget) if path.startswith("/search?") else wikipedia_fetch(path)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    api_key = os.environ["SEARCH_GATEWAY_API_KEY"]
    if len(api_key) < 32:
        raise ValueError("SEARCH_GATEWAY_API_KEY must contain at least 32 characters")
    providers, limits = configured_providers(os.environ)
    budget = DailyBudget(limits, os.environ.get("SEARCH_BUDGET_FILE") or None)
    fetch = make_fetch(providers, budget)
    # Spacing was 1 s to keep scraping polite; the APIs and Wikipedia do not need that,
    # and live research has a 5 s deadline for Wikipedia + web together.
    searches = SearchQueue(fetch, budget=budget,
                           interval=float(os.environ.get("SEARCH_GATEWAY_INTERVAL", "0.3")),
                           # Paid lookups: keep answers longer than the scraping-era 5 minutes.
                           cache_ttl=float(os.environ.get("SEARCH_CACHE_TTL", "21600")))
    logging.info("search providers=%s limits=%s", [name for name, _, _ in providers], limits)
    GatewayServer(("0.0.0.0", 8080), searches, fetch, api_key).serve_forever()
