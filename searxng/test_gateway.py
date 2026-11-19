import json
import os
import tempfile
from datetime import datetime
import threading
import time
import subprocess
import sys
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from gateway import (JST, DailyBudget, GatewayServer, ProviderError, Reply, SearchQueue, api_search,
                     configured_providers, request_path, retry_seconds, wikipedia_fetch)


SEARCH = "/search?format=json&q=test"
WIKI = "/wikipedia/ja?action=query&format=json&prop=extracts&titles=test"


def result(path):
    body = {"query": {"pages": {}}} if path.startswith("/wikipedia/") else {"results": [], "infoboxes": []}
    return Reply(200, json.dumps(body).encode())


class GatewayTests(unittest.TestCase):
    def queue(self, fetch=result, **kwargs):
        queue = SearchQueue(fetch, **kwargs)
        self.addCleanup(queue.close)
        return queue

    def test_shared_search_and_wikipedia_spacing_through_http(self):
        calls = []

        def fetch(path):
            calls.append((path, time.monotonic()))
            return result(path)

        queue = self.queue(fetch)  # Test real production 1-second interval.
        server = GatewayServer(("127.0.0.1", 0), queue, fetch, "test-key")
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        base = f"http://127.0.0.1:{server.server_port}"

        def get(path):
            with urlopen(Request(base + path, headers={"Authorization": "Bearer test-key"}), timeout=5) as response:
                return response.status

        # Independent client processes must share the same interval too.
        script = "from urllib.request import Request,urlopen; import sys; print(urlopen(Request(sys.argv[1], headers={'Authorization':'Bearer test-key'}), timeout=5).status)"
        clients = [subprocess.Popen([sys.executable, "-c", script, base + path], stdout=subprocess.PIPE)
                   for path in [SEARCH, WIKI, SEARCH + "2"]]
        for client in clients:
            stdout, _ = client.communicate(timeout=6)
            self.assertEqual(client.returncode, 0)
            self.assertEqual(stdout.strip(), b"200")
        self.assertEqual(len(calls), 3)
        for before, after in zip(calls, calls[1:]):
            self.assertGreaterEqual(after[1] - before[1], 1.0)
        self.assertEqual(get("/stats"), 200)
        with self.assertRaises(HTTPError) as error:
            urlopen(base + SEARCH, timeout=5)
        self.assertEqual(error.exception.code, 401)
        self.assertEqual(len(calls), 3)

    def test_coalesces_between_sources_and_caches(self):
        entered, release = threading.Event(), threading.Event()
        calls = []

        def fetch(path):
            calls.append(path)
            entered.set()
            release.wait(2)
            return result(path)

        queue = self.queue(fetch, interval=0)
        first, state = queue.submit(SEARCH, "radio")
        self.assertEqual(state, "miss")
        self.assertTrue(entered.wait(1))
        shared, state = queue.submit(SEARCH, "calendar")
        self.assertEqual(state, "shared")
        self.assertIs(shared, first)
        release.set()
        self.assertEqual(first.result(2).status, 200)
        cached, state = queue.submit(SEARCH, "calendar")
        self.assertEqual(state, "hit")
        self.assertEqual(cached.result(), first.result())
        self.assertEqual(calls, [SEARCH])
        self.assertEqual(queue.snapshot()["coalesced"], 1)
        self.assertEqual(queue.snapshot()["sources"]["calendar"]["cache_hits"], 1)

    def test_expired_jobs_are_never_sent(self):
        calls = []
        queue = self.queue(lambda p: (calls.append(p), result(p))[1], interval=.1, queue_timeout=.03)
        self.assertEqual(queue.submit(SEARCH)[0].result(1).status, 200)
        expired = queue.submit(WIKI)[0].result(1)
        self.assertEqual(expired.status, 503)
        self.assertEqual(calls, [SEARCH])

    def test_capacity_is_bounded_but_duplicates_share_slot(self):
        release = threading.Event()
        queue = self.queue(lambda p: (release.wait(1), result(p))[1], interval=0, capacity=1)
        first = queue.submit(SEARCH)[0]
        self.assertIs(queue.submit(SEARCH)[0], first)
        self.assertEqual(queue.submit(WIKI)[0].result().status, 503)
        release.set()
        self.assertEqual(first.result(2).status, 200)

    def test_cache_expiry_eviction_and_language_separation(self):
        calls = []
        queue = self.queue(lambda p: (calls.append(p), result(p))[1], interval=0, cache_ttl=.03, cache_size=1)
        queue.submit(SEARCH)[0].result(1)
        queue.submit(SEARCH + "&language=en")[0].result(1)
        queue.submit(SEARCH)[0].result(1)
        self.assertEqual(len(calls), 3)
        time.sleep(.04)
        queue.submit(SEARCH)[0].result(1)
        self.assertEqual(len(calls), 4)
        self.assertEqual(queue.snapshot()["cache_entries"], 1)

    def test_invalid_json_and_http_failures_do_not_poison_worker_or_cache(self):
        for reply in [Reply(200, b"<html>"), Reply(200, b"{}"), Reply(503, b"unavailable")]:
            with self.subTest(reply=reply):
                replies = iter([reply, result(SEARCH)])
                queue = self.queue(lambda p: next(replies), interval=0)
                self.assertGreaterEqual(queue.submit(SEARCH)[0].result(1).status, 500)
                self.assertEqual(queue.submit(SEARCH)[0].result(1).status, 200)

    def test_429_cooldown_is_shared_by_search_and_wikipedia(self):
        calls = []
        queue = self.queue(lambda p: (calls.append(p), Reply(429, b"{}", retry_after=1))[1], interval=0)
        self.assertEqual(queue.submit(WIKI)[0].result(1).status, 429)
        blocked = queue.submit(SEARCH)[0].result(1)
        self.assertEqual(blocked.status, 429)
        self.assertGreaterEqual(blocked.retry_after, 1)
        self.assertEqual(calls, [WIKI])

    def test_wiki_maxlag_triggers_shared_cooldown(self):
        queue = self.queue(lambda p: Reply(200, json.dumps({"error": {"code": "maxlag"}}).encode()), interval=0)
        queue.submit(WIKI)[0].result(1)
        self.assertEqual(queue.submit(SEARCH + "2")[0].result(1).status, 429)
        self.assertGreater(queue.snapshot()["cooldown_seconds"], 170)

    def test_budget_exhaustion_does_not_pause_wikipedia(self):
        budget = DailyBudget({"tavily": 0})
        calls = []
        queue = self.queue(lambda p: (calls.append(p), result(p))[1], interval=0, budget=budget)
        blocked = queue.submit(SEARCH)[0].result(1)
        self.assertEqual(blocked.status, 429)
        self.assertEqual(blocked.scope, "budget")
        self.assertEqual(queue.submit(WIKI)[0].result(1).status, 200)
        self.assertEqual(calls, [WIKI], "nothing sent for the search")
        self.assertEqual(queue.snapshot()["cooldown_seconds"], 0)

    def test_budget_reply_from_fetch_does_not_start_shared_cooldown(self):
        # Race: available() said yes but the last slot went elsewhere before fetch.
        def fetch(path):
            if path.startswith("/search?"):
                return Reply(429, b"{}", retry_after=3600, scope="budget")
            return result(path)
        queue = self.queue(fetch, interval=0)
        self.assertEqual(queue.submit(SEARCH)[0].result(1).status, 429)
        self.assertEqual(queue.submit(WIKI)[0].result(1).status, 200)

    def test_request_validation_and_canonicalization(self):
        self.assertEqual(request_path("/search?q=%20test%20&format=json"), SEARCH)
        # SearXNG-era parameters must not split the cache.
        self.assertEqual(request_path(SEARCH + "&engines=yahoo&categories=general&safesearch=1"), SEARCH)
        # Provider names are a preferred order and stay in the key.
        self.assertEqual(request_path(SEARCH + "&engines=exa,tavily"), "/search?engines=exa%2Ctavily&format=json&q=test")
        for path in ["https://evil.test/search?format=json&q=x", "/?q=x", "/search?format=html&q=x",
                     "/search?format=json&q=a&q=b", "/wikipedia/ja?action=edit&format=json",
                     "/wikipedia/ja?action=query&format=json&list=users", "/wikipedia/ja/../../evil"]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                request_path(path)
        self.assertIn("titles=test", request_path(WIKI))

    def test_wiki_destination_and_identity_are_fixed(self):
        class Response:
            status = 200
            headers = {"Content-Type": "application/json"}
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, limit): return b'{"query": {}}'

        with patch("gateway.urlopen", return_value=Response()) as fetch:
            wikipedia_fetch(WIKI)
        request = fetch.call_args.args[0]
        self.assertTrue(request.full_url.startswith("https://ja.wikipedia.org/w/api.php?"))
        self.assertIn("maxlag=5", request.full_url)
        self.assertIn("bot-tan-search-gateway", request.get_header("User-agent"))
        self.assertIsNone(request.get_header("Authorization"))
        self.assertEqual(retry_seconds("120"), 120)
        self.assertEqual(retry_seconds(None), 180)



class BudgetTests(unittest.TestCase):
    def test_take_refund_close_and_day_rollover(self):
        now = [datetime(2026, 11, 19, 23, 59, tzinfo=JST)]
        budget = DailyBudget({"tavily": 2, "exa": 1}, now=lambda: now[0])
        self.assertTrue(budget.take("tavily"))
        self.assertTrue(budget.take("tavily"))
        self.assertFalse(budget.take("tavily"))
        budget.refund("tavily")
        self.assertTrue(budget.take("tavily"))
        budget.close_for_today("exa")
        self.assertFalse(budget.available())
        self.assertEqual(budget.seconds_until_reset(), 60)
        now[0] = datetime(2026, 11, 20, 0, 0, 1, tzinfo=JST)
        self.assertTrue(budget.available())
        self.assertTrue(budget.take("exa"))

    def test_usage_survives_restart_only_on_the_same_day(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "budget.json")
            day = lambda: datetime(2026, 11, 19, 12, tzinfo=JST)
            first = DailyBudget({"tavily": 2}, path, now=day)
            first.take("tavily")
            first.take("tavily")
            self.assertFalse(DailyBudget({"tavily": 2}, path, now=day).take("tavily"))
            next_day = DailyBudget({"tavily": 2}, path, now=lambda: datetime(2026, 11, 20, 1, tzinfo=JST))
            self.assertTrue(next_day.take("tavily"))
            with open(path, "w") as file:
                file.write("{broken")
            self.assertTrue(DailyBudget({"tavily": 1}, path, now=day).take("tavily"))


class ApiSearchTests(unittest.TestCase):
    PATH = request_path("/search?format=json&q=%E8%B6%85%E8%9E%8D%E5%90%88&language=ja")

    def test_falls_back_and_returns_searxng_shape(self):
        seen = []
        def tavily(key, query, language):
            seen.append(("tavily", query, language))
            raise ProviderError("HTTP 432", quota=True)
        def exa(key, query, language):
            seen.append(("exa", query, language))
            return [{"title": "超融合", "url": "https://example.test/a", "content": "x", "engine": "exa"},
                    {"title": "", "url": "https://example.test/b", "content": "dropped", "engine": "exa"}]
        budget = DailyBudget({"tavily": 5, "exa": 5})
        reply = api_search(self.PATH, [("tavily", tavily, "k1"), ("exa", exa, "k2")], budget)
        body = json.loads(reply.body)
        self.assertEqual(reply.status, 200)
        self.assertEqual(body["provider"], "exa")
        self.assertEqual([item["url"] for item in body["results"]], ["https://example.test/a"])
        self.assertEqual(body["unresponsive_engines"], [])
        self.assertEqual(seen, [("tavily", "超融合", "ja"), ("exa", "超融合", "ja")])
        # Quota answer closes Tavily for the day; Exa's slot is spent.
        self.assertEqual(budget.snapshot()["used"], {"tavily": 5, "exa": 1})

    def test_engines_parameter_sets_provider_order(self):
        seen = []
        def make(name):
            return lambda key, query, language: (seen.append(name), [])[1]
        providers = [("tavily", make("tavily"), "k1"), ("exa", make("exa"), "k2")]
        budget = DailyBudget({"tavily": 5, "exa": 5})
        api_search(request_path("/search?format=json&q=x&engines=exa,tavily"), providers, budget)
        api_search(request_path("/search?format=json&q=y"), providers, budget)
        self.assertEqual(seen, ["exa", "tavily"])

    def test_transient_failures_are_refunded(self):
        def broken(key, query, language):
            raise ProviderError("HTTP 500")
        budget = DailyBudget({"tavily": 5})
        reply = api_search(self.PATH, [("tavily", broken, "k")], budget)
        self.assertEqual(reply.status, 502)
        self.assertEqual(budget.snapshot()["used"], {"tavily": 0})

    def test_exhausted_budget_is_a_budget_scoped_429(self):
        calls = []
        budget = DailyBudget({"tavily": 0})
        reply = api_search(self.PATH, [("tavily", lambda *a: calls.append(a), "k")], budget)
        self.assertEqual((reply.status, reply.scope), (429, "budget"))
        self.assertLessEqual(reply.retry_after, 3600)
        self.assertEqual(calls, [])

    def test_providers_need_keys_and_keep_order(self):
        providers, limits = configured_providers({"WEB_SEARCH_PROVIDERS": "exa,tavily", "TAVILY_API_KEY": "t",
                                                  "EXA_API_KEY": "e", "EXA_DAILY_LIMIT": "10"})
        self.assertEqual([name for name, _, _ in providers], ["exa", "tavily"])
        self.assertEqual(limits, {"exa": 10, "tavily": 32})
        self.assertEqual([name for name, _, _ in configured_providers({"EXA_API_KEY": "e"})[0]], ["exa"])
        with self.assertRaises(ValueError):
            configured_providers({})
        with self.assertRaises(ValueError):
            configured_providers({"WEB_SEARCH_PROVIDERS": "yahoo", "YAHOO_API_KEY": "x"})


if __name__ == "__main__":
    unittest.main()
