import asyncio
import json
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

import httpx
import numpy as np
from fastapi.testclient import TestClient

from app.demo import demo_event, demo_hours
from app.model import backtest, complete_days, fit, forecast, simulate
from app.providers import ProviderError, bounds, collect_posts, fetch_event, normalize_event, slug_from
from app.storage import Store, UTC, hour, parse_time, read_csv
from app.trading import evaluate, fill_order
from app.x_api import collect_x


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temp.name)/"test.db")
        self.t = hour(datetime.now(UTC))-timedelta(hours=3)

    def tearDown(self):
        self.temp.cleanup()

    def test_csv_and_idempotent_upsert(self):
        rows = read_csv(f"timestamp,count\n{self.t.isoformat()},4\n")
        self.store.save_hours(rows)
        self.store.save_hours(rows)
        self.assertEqual(self.store.load()[0],{self.t:4})

    def test_rejection_is_atomic(self):
        self.store.save_hours([(self.t,2)])
        with self.assertRaises(ValueError):
            self.store.save_hours([(self.t,8),(self.t+timedelta(hours=1),-1)])
        self.assertEqual(self.store.load()[0][self.t],2)

    def test_duplicate_hour_rejected(self):
        with self.assertRaisesRegex(ValueError,"повторяется"):
            self.store.save_hours([(self.t,2),(self.t,2)])

    def test_timezone_offset_normalized(self):
        self.assertEqual(parse_time("2026-01-01T03:00:00+03:00"),parse_time("2026-01-01T00:00:00Z"))
        with self.assertRaises(ValueError):
            parse_time("2026-01-01T00:00:00")

    def test_future_and_partial_hours_rejected(self):
        for t in [datetime.now(UTC)+timedelta(days=1),self.t+timedelta(minutes=1),hour(datetime.now(UTC))]:
            with self.assertRaises(ValueError):
                self.store.save_hours([(t,3)])

    def test_demo_isolation(self):
        self.store.save_hours([(self.t,4)],"demo","synthetic")
        self.assertEqual(self.store.load("live")[0],{})


class ForecastTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.now = datetime(2026,10,18,12,20,tzinfo=UTC)
        cls.data = dict(demo_hours(cls.now))
        cls.cutoff=hour(cls.now)

    def test_probabilities_and_current_count(self):
        start=self.cutoff-timedelta(days=3)
        draws,r=forecast(self.data,start,self.cutoff+timedelta(days=2),"UTC",self.now,samples=5000)
        self.assertEqual(r["current_count"],sum(self.data[t] for t in self.data if start<=t<self.cutoff))
        self.assertGreaterEqual(int(draws.min()),r["current_count"])
        self.assertAlmostEqual(sum(x["probability"] for x in r["histogram"]),1)
        self.assertLessEqual(r["low"],r["median"])
        self.assertLessEqual(r["median"],r["high"])

    def test_missing_hour_is_not_zero(self):
        data=self.data.copy(); del data[self.cutoff-timedelta(hours=1)]
        # Make an internal gap, rather than moving the last available hour.
        data[self.cutoff-timedelta(hours=1)]=1
        del data[self.cutoff-timedelta(hours=2)]
        with self.assertRaisesRegex(ValueError,"отсутствуют"):
            forecast(data,self.cutoff-timedelta(days=1),self.cutoff+timedelta(days=1),"UTC",self.now)

    def test_stale_history_disables_signals(self):
        data={t:c for t,c in self.data.items() if t<self.cutoff-timedelta(hours=6)}
        _,r=forecast(data,self.cutoff-timedelta(days=1),self.cutoff+timedelta(days=1),"UTC",self.now,samples=1000)
        self.assertFalse(r["fresh"])

    def test_incomplete_day_not_used_and_no_future_leak(self):
        baseline=fit(self.data,self.cutoff,"UTC")
        changed=self.data.copy()
        for i in range(24):
            changed[self.cutoff+timedelta(hours=i)]=9999
        changed[self.cutoff-timedelta(hours=1)]=9999
        other=fit(changed,self.cutoff,"UTC")
        np.testing.assert_array_equal(baseline["rates"],other["rates"])

    def test_known_posts_shift_total_without_being_predicted_again(self):
        start=self.cutoff-timedelta(hours=6)
        data=self.data.copy()
        for i in range(6): data[start+timedelta(hours=i)] += 2
        a,_=forecast(self.data,start,self.cutoff+timedelta(hours=12),"UTC",self.now,samples=1000)
        b,_=forecast(data,start,self.cutoff+timedelta(hours=12),"UTC",self.now,samples=1000)
        np.testing.assert_array_equal(b-a,np.full(1000,12))

    def test_completed_window_is_exact(self):
        start=self.cutoff-timedelta(hours=8)
        end=self.cutoff-timedelta(hours=2)
        draws,r=forecast(self.data,start,end,"UTC",self.now,samples=500)
        self.assertEqual(r["low"],r["high"])
        self.assertTrue(np.all(draws==r["current_count"]))

    def test_future_single_day_does_not_add_gap_counts(self):
        start=self.cutoff+timedelta(days=2)
        _,r=forecast(self.data,start,start+timedelta(days=1),"UTC",self.now,samples=1000)
        self.assertEqual(r["current_count"],0)
        self.assertGreater(r["mean"],0)

    def test_minimum_history(self):
        data={t:c for t,c in self.data.items() if t>self.cutoff-timedelta(days=7)}
        with self.assertRaisesRegex(ValueError,"14"):
            fit(data,self.cutoff,"UTC")

    def test_isolated_recent_hour_does_not_make_old_training_fresh(self):
        data={t:c for t,c in self.data.items() if t<self.cutoff-timedelta(days=10)}
        data[self.cutoff-timedelta(hours=1)]=2
        _,r=forecast(data,self.cutoff,self.cutoff+timedelta(days=1),"UTC",self.now,samples=500)
        self.assertFalse(r["fresh"])

    def test_gamma_poisson_moments_and_daily_correlation(self):
        fitted={"rates":np.full((7,24),2.),"shape":3.,"uncertainty_shape":1e9}
        start=datetime(2026,1,1,tzinfo=UTC)
        d=simulate(fitted,start,start+timedelta(days=1),"UTC",samples=100000)
        self.assertAlmostEqual(float(d.mean()),48,delta=.5)
        # Shared daily intensity gives Var(N)=mu+mu²/k, unlike independent hourly draws.
        self.assertAlmostEqual(float(d.var()),48+48**2/3,delta=25)

    def test_dst_has_23_and_25_hours(self):
        for date,expected in [(datetime(2026,3,8,tzinfo=UTC),23),(datetime(2026,11,1,tzinfo=UTC),25)]:
            data={date+timedelta(hours=i):1 for i in range(-72,96)}
            days=complete_days(data,date+timedelta(days=4),"America/New_York")
            selected=next(rows for day,rows in days if day==date.date())
            self.assertEqual(len(selected),expected)

    def test_backtest_runs_actual_holdouts(self):
        result=backtest(self.data,self.cutoff,"UTC")
        self.assertEqual(result["days"],14)
        self.assertIsNotNone(result["mae"])
        self.assertTrue(0<=result["coverage80"]<=1)


class TradingTests(unittest.TestCase):
    def test_buy_uses_asks_and_depth_with_expense_budget(self):
        fill=fill_order([{"price":.6,"size":100},{"price":.4,"size":10}],50, .1)
        self.assertAlmostEqual(fill["total"],50)
        self.assertAlmostEqual(fill["shares"],10+(50/1.1-4)/.6)
        self.assertGreater(fill["vwap"],.4)

    def test_yes_no_are_complements_and_ev_is_net(self):
        now=datetime.now(UTC)
        event=demo_event(now);event["markets"]=event["markets"][:1]
        market=event["markets"][0]
        market["books"]={s:{"asks":[{"price":.4,"size":1000}],"fetched_at":now.isoformat()} for s in ['yes','no']}
        rows=evaluate(np.array([100]*70+[300]*30),event,100,100,5,now=now)
        yes=next(r for r in rows if r["side"]=="YES")
        no=next(r for r in rows if r["side"]=="NO")
        self.assertAlmostEqual(yes["probability"]+no["probability"],1)
        self.assertAlmostEqual(yes["expected_profit"],.7*yes["shares"]-100)
        self.assertTrue(yes["signal"])
        self.assertFalse(no["signal"])

    def test_insufficient_depth_rules_and_stale_quotes_disable(self):
        now=datetime.now(UTC);event=demo_event(now)
        event["markets"]=event["markets"][:1]
        for b in event["markets"][0]["books"].values():
            b["asks"]=[{"price":.01,"size":1}]
            b["fetched_at"]=(now-timedelta(minutes=5)).isoformat()
        rows=evaluate(np.array([100]*100),event,100,0,0,eligible=False,now=now)
        self.assertFalse(any(r["signal"] for r in rows))
        self.assertTrue(all(len(r["reasons"])>=3 for r in rows))


class ProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_x_archive_pages_and_reference_filters(self):
        t=hour(datetime.now(UTC))-timedelta(hours=2)
        def handler(request):
            self.assertEqual(request.url.path,"/2/tweets/search/all")
            if request.url.params.get('next_token'):
                return httpx.Response(200,json={"data":[{"id":"3","created_at":t.isoformat(),"referenced_tweets":[{"type":"retweeted","id":"8"}]}],"meta":{}})
            return httpx.Response(200,json={"data":[{"id":"1","created_at":t.isoformat()},{"id":"2","created_at":t.isoformat(),"referenced_tweets":[{"type":"replied_to","id":"7"}]}],"meta":{"next_token":"page2"}})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            result=await collect_x(30,False,True,"archive",client)
        self.assertEqual(result["posts"],2)
        self.assertEqual(dict(result["rows"])[t],2)
        self.assertEqual(len(result["rows"]),720)

    async def test_x_timeline_truncation_not_filled_with_zeros(self):
        t=hour(datetime.now(UTC))-timedelta(hours=1)
        def handler(request):
            if '/by/username/' in request.url.path:
                return httpx.Response(200,json={"data":{"id":"44196397"}})
            return httpx.Response(200,json={"data":[{"id":"1","created_at":t.isoformat()}],"meta":{}})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            with self.assertRaisesRegex(ProviderError,"Лента X закончилась"):
                await collect_x(30,False,True,"timeline",client)

    async def test_x_timeline_requires_older_boundary_post(self):
        end=hour(datetime.now(UTC));t=end-timedelta(hours=1)
        def handler(request):
            if '/by/username/' in request.url.path:
                return httpx.Response(200,json={"data":{"id":"44196397"}})
            return httpx.Response(200,json={"data":[{"id":"1","created_at":t.isoformat()},{"id":"0","created_at":(end-timedelta(days=31)).isoformat()}],"meta":{}})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            result=await collect_x(30,False,True,"timeline",client)
        self.assertEqual(result["posts"],1)

    async def test_x_access_rate_limits_and_partial_errors(self):
        for code,message in [(401,"авторизацию"),(403,"Тариф"),(429,"Лимит")]:
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r:httpx.Response(code))) as client:
                with self.assertRaisesRegex(ProviderError,message):
                    await collect_x(30,False,True,"archive",client)
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r:httpx.Response(200,json={"data":[],"errors":[{"message":"partial failure"}]}))) as client:
            with self.assertRaisesRegex(ProviderError,"частичном"):
                await collect_x(30,False,True,"archive",client)

    async def test_x_missing_token_does_not_make_network_request(self):
        from unittest.mock import patch
        with patch.dict('os.environ',{},clear=True):
            with self.assertRaisesRegex(ProviderError,"X_BEARER_TOKEN"):
                await collect_x(30,False,True)

    def test_ranges_are_inclusive_and_unknown_is_not_guessed(self):
        for text,expected in [("200–219",(200,219)),("<200",(0,199)),("600+",(600,None)),("600 or more",(600,None)),(">600",(601,None))]:
            self.assertEqual(bounds(text),expected)
        with self.assertRaises(ValueError):bounds("Will Elon tweet 300 times?")

    def test_only_polymarket_urls(self):
        self.assertEqual(slug_from("https://polymarket.com/ru/event/example?x=y"),"example")
        with self.assertRaises(ValueError):slug_from("https://127.0.0.1/event/example")

    async def test_event_adapter_with_unordered_books(self):
        def handler(request):
            if request.url.host=="gamma-api.polymarket.com":
                return httpx.Response(200,json=[{"slug":"test","title":"Test","markets":[{"id":"1","groupItemTitle":"200-219","outcomes":'["No","Yes"]',"clobTokenIds":'["n","y"]',"active":True,"acceptingOrders":True}]}])
            return httpx.Response(200,json={"asks":[{"price":"0.5","size":"100"},{"price":"0.2","size":"20"}]})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            event=await fetch_event("test",client)
        self.assertEqual(event["markets"][0]["tokens"]["yes"],"y")
        self.assertEqual(event["markets"][0]["books"]["yes"]["asks"][0]["price"],.2)

    async def test_partial_clob_failure_is_not_a_fake_price(self):
        def handler(request):
            if request.url.host=="gamma-api.polymarket.com":
                return httpx.Response(200,json=[{"slug":"test","markets":[{"id":"1","groupItemTitle":"0-9","outcomes":["Yes","No"],"clobTokenIds":["y","n"],"active":True,"acceptingOrders":True}]}])
            return httpx.Response(503)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            event=await fetch_event("test",client)
        self.assertEqual(event["markets"][0]["books"]["yes"]["asks"],[])
        self.assertIn("error",event["markets"][0]["books"]["yes"])

    async def test_collector_pages_filters_deduplicates_and_stages_zeros(self):
        t=hour(datetime.now(UTC))-timedelta(hours=2)
        def handler(request):
            page=int(request.url.params["page"])
            rows=[{"id":"1","createdAt":t.isoformat(),"type":"tweet"},{"id":"2","createdAt":t.isoformat(),"type":"reply"}] if page==1 else [{"id":"1","createdAt":t.isoformat(),"type":"tweet"},{"id":"3","createdAt":t.isoformat(),"type":"retweet"}]
            return httpx.Response(200,json={"data":{"posts":rows,"pagination":{"totalPages":2}}})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            result=await collect_posts(15,False,True,client)
        self.assertEqual(result["posts"],2)
        self.assertEqual(len(result["rows"]),360)
        self.assertEqual(dict(result["rows"])[t],2)

    async def test_unpaginated_repeat_rejected(self):
        t=hour(datetime.now(UTC))-timedelta(hours=1)
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r:httpx.Response(200,json={"data":[{"id":"1","createdAt":t.isoformat(),"type":"tweet"}]}))) as client:
            with self.assertRaisesRegex(ProviderError,"повторяет"):
                await collect_posts(15,False,True,client)

    async def test_observed_xtracker_schema_without_types_is_rejected(self):
        t=hour(datetime.now(UTC))-timedelta(hours=1)
        payload={"success":True,"data":[{"id":"tracker-id","platformId":"123","createdAt":t.isoformat(),"content":"post"}]}
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r:httpx.Response(200,json=payload))) as client:
            with self.assertRaisesRegex(ProviderError,"не передаёт типы"):
                await collect_posts(15,False,True,client)


class AppTests(unittest.TestCase):
    def setUp(self):
        from app import main
        self.main=main
        self.temp=tempfile.TemporaryDirectory()
        self.previous=main.store
        main.store=Store(Path(self.temp.name)/"app.db")
        self.client=TestClient(main.app)

    def tearDown(self):
        self.client.close();self.main.store=self.previous;self.temp.cleanup()

    def test_full_demo_workflow(self):
        self.assertEqual(self.client.get('/').status_code,200)
        self.assertEqual(self.client.get('/api/docs').status_code,200)
        self.assertIn('/api/analyze',self.client.get('/openapi.json').json()['paths'])
        demo=self.client.post('/api/demo',json={}).json()
        request={"dataset":"demo","start":demo["start"],"end":demo["end"],"timezone":demo["timezone"],"rules_confirmed":True}
        response=self.client.post('/api/analyze',json=request)
        self.assertEqual(response.status_code,200,response.text)
        result=response.json()
        self.assertEqual(len(result["positions"]),14)
        self.assertEqual(result["backtest"]["days"],14)
        self.assertEqual(self.client.get('/api/status').json()["live"]["hours"],0)
        self.assertTrue(result["event"]["demo"])

    def test_empty_history_and_validation_errors(self):
        r=self.client.post('/api/analyze',json={"start":"2026-10-18T00:00","end":"2026-10-19T00:00"})
        self.assertEqual(r.status_code,400)
        self.assertIn('историю',r.json()["detail"])
        self.assertEqual(self.client.post('/api/analyze',json={"budget":-1}).status_code,422)

    def test_cross_origin_mutation_rejected(self):
        self.assertEqual(self.client.post('/api/demo',json={},headers={"Origin":"https://evil.example"}).status_code,403)

    def test_unconfirmed_import_rejected(self):
        r=self.client.post('/api/import',json={"content":"timestamp,count\n2026-01-01T00:00:00Z,3"})
        self.assertEqual(r.status_code,400)
        self.assertEqual(self.client.get('/api/status').json()["live"]["hours"],0)

    def test_import_export_and_real_dataset_forecast(self):
        rows=demo_hours()[-24*35:]
        content='timestamp,count\n'+'\n'.join(f'{t.isoformat()},{c}' for t,c in rows)
        imported=self.client.post('/api/import',json={"content":content,"coverage_confirmed":True})
        self.assertEqual(imported.status_code,200,imported.text)
        self.assertEqual(imported.json()['imported_hours'],840)
        exported=self.client.get('/api/export')
        self.assertEqual(len(read_csv(exported.text)),840)
        start=hour(datetime.now(UTC))
        response=self.client.post('/api/analyze',json={"dataset":"live","start":start.isoformat(),"end":(start+timedelta(days=1)).isoformat(),"timezone":"UTC"})
        self.assertEqual(response.status_code,200,response.text)
        self.assertGreater(response.json()['mean'],0)
        self.assertEqual(response.json()['positions'],[])

    def test_dst_nonexistent_and_ambiguous_times_rejected(self):
        for value in ["2026-03-08T02:00","2026-11-01T01:00"]:
            with self.assertRaises(ValueError):self.main.local_time(value,"America/New_York")

    def test_demo_different_window_only_forecast(self):
        demo=self.client.post('/api/demo',json={}).json()
        end=self.main.local_time(demo["end"],demo["timezone"])+timedelta(hours=1)
        response=self.client.post('/api/analyze',json={"dataset":"demo","start":demo["start"],"end":end.isoformat(),"timezone":demo["timezone"]})
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(response.json()["positions"],[])


if __name__=='__main__':
    unittest.main()
