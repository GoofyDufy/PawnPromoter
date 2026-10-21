"""Screenshots of the app for a visual review, in headless Firefox via geckodriver
(WebDriver over HTTP, standard library only). Opens the profile tests/e2e/weak.sh
kept, so the database and analysis are already there.

  python3 -I tests/e2e/screenshots.py            → tests/e2e/results/shots/*.png
Needs the e2e build (weak.sh makes it). Starts its own test server and geckodriver.
"""
import base64, json, pathlib, subprocess, sys, time, urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
RESULTS = ROOT / "tests" / "e2e" / "results"
PROFILE = RESULTS / "ff-profile-weak"
SHOTS = RESULTS / "shots"
DRIVER = "http://127.0.0.1:4444"
APP = "http://127.0.0.1:8766/e2e.html?phase=show"


def call(method, path, body=None):
    req = urllib.request.Request(DRIVER + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read() or b"{}").get("value")


class Session:
    def __init__(self, dark):
        caps = {"browserName": "firefox", "moz:firefoxOptions": {
            "args": ["-headless", "-profile", str(PROFILE)],
            "prefs": {"ui.systemUsesDarkTheme": 1 if dark else 0, "layout.css.prefers-color-scheme.content-override": 0 if dark else 1}}}
        self.id = call("POST", "/session", {"capabilities": {"alwaysMatch": caps}})["sessionId"]

    def js(self, script, *args):
        return call("POST", f"/session/{self.id}/execute/sync", {"script": script, "args": list(args)})

    def wait(self, script, timeout=120):
        end = time.time() + timeout
        while time.time() < end:
            if self.js(script):
                return True
            time.sleep(0.3)
        raise TimeoutError(script)

    def size(self, w, h):
        call("POST", f"/session/{self.id}/window/rect", {"width": w, "height": h})

    def shot(self, name):
        SHOTS.mkdir(parents=True, exist_ok=True)
        time.sleep(0.6)
        (SHOTS / f"{name}.png").write_bytes(base64.b64decode(call("GET", f"/session/{self.id}/screenshot")))
        print("shot", name, flush=True)

    def click_text(self, selector, text):
        self.js("const t = arguments[1]; const b = [...document.querySelectorAll(arguments[0])].find((e) => e.textContent.trim().startsWith(t));"
                " if (!b) throw new Error('no ' + t); b.click();", selector, text)

    def close(self):
        call("DELETE", f"/session/{self.id}")


def tour(s, theme):
    s.size(1366, 768)
    call("POST", f"/session/{s.id}/url", {"url": APP})
    s.wait("return !!document.querySelector('.level-card')")
    s.click_text(".nav button", "Stats")
    s.wait("return !!document.querySelector('.weak-page .stat-card')")
    s.shot(f"{theme}-weak-overview")
    s.js("document.querySelector('.main').scrollTop = 900")
    s.shot(f"{theme}-weak-overview-examples")
    s.js("document.querySelector('.main').scrollTop = 0")
    for view in ("Training plan", "Splits", "How it works"):
        s.click_text(".weak-views button", view)
        s.shot(f"{theme}-weak-{view.split()[0].lower()}")
    if theme == "light":
        s.click_text(".weak-views button", "Splits")
        s.js("document.querySelector('.main').scrollTop = 700")
        s.shot("light-weak-splits-lower")
        s.js("document.querySelector('.main').scrollTop = 0")
    for screen in ("Puzzle Review", "Game Review", "Opening Drill", "Tactics & Threats", "Progress", "Import & Analyze"):
        s.click_text(".nav button", screen)
        time.sleep(2.5)
        s.shot(f"{theme}-{screen.split()[0].lower()}")


def main():
    if not PROFILE.exists():
        sys.exit("run tests/e2e/weak.sh first")
    server = subprocess.Popen([sys.executable, "-I", str(ROOT / "tests" / "e2e" / "server.py")])
    driver = subprocess.Popen(["geckodriver", "--port", "4444", "--profile-root", str(RESULTS)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(120):          # the snap geckodriver can take a while to start
        try:
            call("GET", "/status")
            break
        except OSError:
            time.sleep(0.5)
    try:
        for theme in ("light", "dark"):
            s = Session(dark=theme == "dark")
            try:
                tour(s, theme)
                if theme == "light":
                    s.size(390, 844)
                    s.click_text(".nav button", "Stats")
                    s.wait("return !!document.querySelector('.weak-page .stat-card')")
                    s.shot("phone-weak-overview")
                    s.click_text(".weak-views button", "Training plan")
                    s.shot("phone-weak-training")
            finally:
                s.close()
    finally:
        driver.terminate()
        server.terminate()


if __name__ == "__main__":
    main()
