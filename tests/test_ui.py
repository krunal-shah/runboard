#!/usr/bin/env python3
"""End-to-end UI regression tests for runboard. Hermetic: builds a synthetic
event-file corpus in a tempdir, starts its own server on a free port, and
drives the page with headless Chromium.

Run inside the `training` conda env:  python tests/test_ui.py
"""

import asyncio
import contextlib
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import synthdata  # noqa: E402

FAILURES = []


def check(name, cond, detail=""):
    print(("PASS" if cond else "FAIL"), name, detail)
    if not cond:
        FAILURES.append(name)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@contextlib.contextmanager
def server(root):
    port = free_port()
    proc = subprocess.Popen(
        [sys.executable, os.path.join(HERE, "..", "server.py"),
         "--logdir", root, "--port", str(port)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f"http://127.0.0.1:{port}"
    try:
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(url + "/api/runs", timeout=2) as r:
                    if json.load(r)["runs"]:
                        break
            except Exception:
                time.sleep(0.3)
        else:
            raise RuntimeError("server did not come up")
        yield url
    finally:
        proc.terminate()
        proc.wait(timeout=10)


async def select_run(page, query):
    await page.fill("#run-search", query)
    await page.wait_for_timeout(350)
    await page.locator("#run-list .run-row input[type=checkbox]").first.click()
    await page.wait_for_timeout(350)


async def flow_basics(browser, url):
    """Selection, multi-series charts, rename, pin, reorder, zoom, log, GC."""
    page = await browser.new_page(viewport={"width": 1500, "height": 950})
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    await page.goto(url, wait_until="networkidle")
    await page.wait_for_selector("#run-list .run-row", timeout=15000)

    await select_run(page, "run-00")
    await select_run(page, "run-01")
    await select_run(page, "run-02")
    await page.wait_for_selector(".card .uplot canvas", timeout=20000)
    await page.wait_for_timeout(1200)

    n_series = await page.evaluate(
        "window.__rb.charts().get('loss') ? window.__rb.charts().get('loss').data.size : 0")
    check("all selected runs plotted on shared tag", n_series == 3, f"series={n_series}")

    # rename (client-side alias) + persistence through reload
    row = page.locator("#selected-list .run-row").first
    await row.hover()
    await row.locator("button[title*='rename']").click()
    await page.fill("#selected-list input.rename-input", "my-baseline")
    await page.keyboard.press("Enter")
    await page.wait_for_timeout(300)

    # pin two charts, then drag-reorder them
    pins = page.locator(".card .card-head button[title='pin to top']")
    await pins.first.click()
    await page.wait_for_timeout(250)
    await pins.first.click()
    await page.wait_for_timeout(500)
    order0 = await page.evaluate(
        "[...document.querySelectorAll('#pinned-grid .card')].map(c => c.dataset.tag)")
    check("two charts pinned", len(order0) == 2, str(order0))

    handle = page.locator("#pinned-grid .card .drag-handle").first
    target = page.locator("#pinned-grid .card").nth(1)
    hb = await handle.bounding_box()
    tb = await target.bounding_box()
    await page.mouse.move(hb["x"] + 4, hb["y"] + 4)
    await page.mouse.down()
    await page.mouse.move(tb["x"] + tb["width"] * 0.8, tb["y"] + 40, steps=12)
    await page.wait_for_timeout(150)
    await page.mouse.move(tb["x"] + tb["width"] * 0.8, tb["y"] + 40, steps=2)
    await page.mouse.up()
    await page.wait_for_timeout(400)
    order1 = await page.evaluate(
        "[...document.querySelectorAll('#pinned-grid .card')].map(c => c.dataset.tag)")
    check("pinned drag-reorder", order1 == list(reversed(order0)), f"{order0} -> {order1}")

    # linked zoom + double-click reset
    over = page.locator("#pinned-grid .card .u-over").first
    box = await over.bounding_box()
    await page.mouse.move(box["x"] + 60, box["y"] + 50)
    await page.mouse.down()
    await page.mouse.move(box["x"] + 220, box["y"] + 50, steps=8)
    await page.mouse.up()
    await page.wait_for_timeout(300)
    zoomed = await page.evaluate("""
      [...window.__rb.charts().values()].filter(c => c.u)
        .every(c => c.zoomed && c.u.scales.x.max - c.u.scales.x.min < 490)
    """)
    check("drag-zoom links across charts", zoomed)
    await over.dblclick()
    await page.wait_for_timeout(300)
    reset = await page.evaluate(
        "[...window.__rb.charts().values()].filter(c => c.u).every(c => !c.zoomed)")
    check("dblclick resets all charts", reset)

    # log-scale toggle
    await page.locator("#pinned-grid .card button[title='log-scale y axis']").first.click()
    await page.wait_for_timeout(300)
    distr = await page.evaluate("""
      [...window.__rb.charts().values()]
        .find(c => c.u && window.__rb.state.logTags[c.tag])?.u.scales.y.distr
    """)
    check("log scale applies", distr == 3, f"distr={distr}")

    # persistence through reload
    await page.reload(wait_until="networkidle")
    await page.wait_for_timeout(1500)
    seltext = await page.locator("#selected-list").inner_text()
    pinned = await page.locator("#pinned-grid .card").count()
    check("state survives reload",
          "my-baseline" in seltext and pinned == 2,
          f"pinned={pinned}")

    # chart-map GC under tag filters
    await select_run(page, "manytags")
    await page.wait_for_timeout(1500)
    size0 = await page.evaluate("window.__rb.charts().size")
    await page.fill("#tag-filter", "metric_000")
    await page.wait_for_timeout(1200)
    size1 = await page.evaluate("window.__rb.charts().size")
    cards1 = await page.locator("#groups .card, #pinned-grid .card").count()
    check("chart map GC on filter change", size1 < size0 and size1 == cards1,
          f"{size0} -> {size1}, DOM={cards1}")
    await page.fill("#tag-filter", "")
    await page.wait_for_timeout(800)

    # pin budget: pinning every tag must still respect the 400-card cap
    stats = await page.evaluate("""
      (() => {
        const tags = new Set();
        for (const rid of window.__rb.state.selected) {
          // union of tags known to the client
          for (const c of window.__rb.charts().keys()) tags.add(c);
        }
        window.__rb.state.pins = [...tags].concat(
          Array.from({length: 480}, (_, i) => 'grp0/metric_' + String(i).padStart(4, '0')));
        window.__rb.rebuild();
        return {
          pinnedCards: document.querySelectorAll('#pinned-grid .card').length,
          chartCount: window.__rb.charts().size,
        };
      })()
    """)
    check("pin rendering honors card cap",
          stats["pinnedCards"] <= 400 and stats["chartCount"] <= 400, str(stats))

    check("no console errors (basics)", not errors, str(errors[:3]))
    await page.close()


async def flow_tooltip_and_smoothing(browser, url):
    """Cadence-honest tooltips; server-side smoothing incl. stale-alpha race."""
    page = await browser.new_page(viewport={"width": 1400, "height": 900})
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

    # delay any scalars request with smoothing=0.8 so its response arrives
    # AFTER the 0.9 one — the stale response must be rejected
    async def route_scalars(route):
        body = route.request.post_data_json or {}
        if body.get("smoothing") == 0.8:
            await asyncio.sleep(1.5)
        await route.continue_()
    await page.route("**/api/scalars", route_scalars)

    await page.goto(url, wait_until="networkidle")
    await page.wait_for_selector("#run-list .run-row", timeout=15000)
    await select_run(page, "run-00")
    await select_run(page, "run-01")
    await page.wait_for_selector(".card .uplot canvas", timeout=20000)
    await page.wait_for_timeout(1000)

    # tooltip at far left: cursor sits at step 0; run-01 only has steps >= 100
    over = page.locator(".card .u-over").first
    box = await over.bounding_box()
    await page.mouse.move(box["x"] + 2, box["y"] + box["height"] / 2)
    await page.wait_for_timeout(400)
    tt = (await page.locator("#tooltip").inner_text()).replace("\n", " | ")
    check("tooltip labels off-cursor steps honestly",
          "@ step 100" in tt and "step 0" in tt, tt[:120])

    # stale-alpha race: 0.8 (delayed) then 0.9 (fast)
    await page.locator("#smoothing").evaluate(
        "e => { e.value = 0.8; e.dispatchEvent(new Event('input')) }")
    await page.wait_for_timeout(600)
    await page.locator("#smoothing").evaluate(
        "e => { e.value = 0.9; e.dispatchEvent(new Event('input')) }")
    await page.wait_for_timeout(3500)  # let the delayed 0.8 response land
    alphas = await page.evaluate("""
      [...window.__rb.charts().values()].flatMap(c =>
        [...c.data.values()].map(d => d.smoothing)).filter(a => a != null)
    """)
    check("stale smoothing responses rejected",
          len(alphas) > 0 and all(a == 0.9 for a in alphas), f"alphas={alphas}")
    has_smooth = await page.evaluate("""
      [...window.__rb.charts().values()].some(c =>
        [...c.data.values()].some(d => Array.isArray(d.smooth)))
    """)
    check("server smoothing arrays in use", has_smooth)

    # chip patterns: force slots 8 and 16 — legend chips must differ
    dashes = await page.evaluate("""
      (() => {
        window.__rb.state.slots[window.__rb.state.selected[0]] = 8;
        window.__rb.state.slots[window.__rb.state.selected[1]] = 16;
        window.__rb.renderSidebar();
        return [...document.querySelectorAll('#selected-list .chip-line line')]
          .map(l => l.getAttribute('stroke-dasharray'));
      })()
    """)
    check("legend chips show distinct dash patterns",
          len(dashes) == 2 and dashes[0] != dashes[1], str(dashes))

    check("no console errors (tooltip/smoothing)", not errors, str(errors[:3]))
    await page.close()


async def flow_persisted_state(browser, url):
    """Cap on persisted selections; alias-id migration for saved selections."""
    page = await browser.new_page(viewport={"width": 1400, "height": 900})
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    seed = {
        "selected": [f"fake-run-{i:03d}" for i in range(65)] + ["0002_alias_resume"],
        "slots": {},
    }
    await page.add_init_script(
        f"localStorage.setItem('runboard:v1', JSON.stringify({json.dumps(seed)}))")
    await page.goto(url, wait_until="networkidle")
    await page.wait_for_timeout(1500)
    n = await page.evaluate("window.__rb.state.selected.length")
    check("persisted selection clamped to cap", n == 30, f"selected={n}")

    # a persisted selection containing ONLY an alias id must migrate + plot
    page2 = await browser.new_page(viewport={"width": 1400, "height": 900})
    page2.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    seed2 = {"selected": ["0002_alias_resume"], "slots": {"0002_alias_resume": 0}}
    await page2.add_init_script(
        f"localStorage.setItem('runboard:v1', JSON.stringify({json.dumps(seed2)}))")
    await page2.goto(url, wait_until="networkidle")
    await page2.wait_for_timeout(1500)
    sel = await page2.evaluate("window.__rb.state.selected")
    ncards = await page2.locator("#groups .card, #pinned-grid .card").count()
    check("alias id migrates to chosen id",
          sel == ["0001_alias_short"], str(sel))
    check("migrated selection produces charts", ncards >= 1, f"cards={ncards}")

    check("no console errors (persisted state)", not errors, str(errors[:3]))
    await page.close()
    await page2.close()


async def main():
    root = tempfile.mkdtemp(prefix="runboard-test-")
    try:
        synthdata.build(root)
        with server(root) as url:
            async with async_playwright() as pw:
                browser = await pw.chromium.launch()
                await flow_basics(browser, url)
                await flow_tooltip_and_smoothing(browser, url)
                await flow_persisted_state(browser, url)
                await browser.close()
    finally:
        shutil.rmtree(root, ignore_errors=True)
    print("ALL PASS" if not FAILURES else f"FAILED: {FAILURES}")
    sys.exit(1 if FAILURES else 0)


asyncio.run(main())
