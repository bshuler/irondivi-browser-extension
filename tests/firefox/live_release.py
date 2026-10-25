"""The published Firefox package against the real sites.

    uv venv /tmp/ffvenv && uv pip install --python /tmp/ffvenv -r tests/firefox/requirements.txt
    /tmp/ffvenv/bin/python -I tests/firefox/live_release.py packages/irondivi-wallet-firefox-v0.0.6.xpi

Installs the .xpi as a temporary add-on in Firefox, creates a throwaway
wallet (the recovery phrase is never read, printed or captured), connects it
to games.divi.domains, and checks that example.com, which is not on the
default list, is told not_allowed and gets 4300 with no window opening.
Selenium Manager fetches geckodriver if it is not installed.
"""
import json
import secrets
import sys
import time
import uuid

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

ADDON_ID = "irondivi-wallet@divi.domains"
FIREFOX = "/Applications/Firefox.app/Contents/MacOS/firefox"


def main(xpi: str) -> int:
    ext_uuid = str(uuid.uuid4())
    opts = Options()
    opts.binary_location = FIREFOX
    # A fixed internal UUID so the popup has a known moz-extension:// URL
    opts.set_preference("extensions.webextensions.uuids", json.dumps({ADDON_ID: ext_uuid}))
    # WebDriver may not navigate to moz-extension:// itself; the popup is
    # opened from the browser window instead, which needs system access
    driver = webdriver.Firefox(options=opts, service=Service(service_args=["--allow-system-access"]))
    wait = WebDriverWait(driver, 30)
    password = "LiveCheck-" + secrets.token_hex(8) + "!A1"
    ok = True

    def check(what: str, cond: bool, detail: str = "") -> None:
        nonlocal ok
        ok = ok and cond
        print(("PASS " if cond else "FAIL ") + what + (f": {detail}" if detail else ""))

    def call(script: str):
        # Runs an async page call; resolves to {"ok": value} or {"code": n}
        return driver.execute_async_script(
            "const done = arguments[arguments.length - 1];"
            f"Promise.resolve().then(() => {script}).then(v => done({{ok: v}}), e => done({{code: e && e.code, msg: String(e && e.message)}}));"
        )

    def wait_provider() -> None:
        wait.until(lambda d: d.execute_script("return !!window.irondivi"))

    try:
        driver.install_addon(xpi, temporary=True)
        version = driver.capabilities.get("browserVersion")
        print("Firefox", version)
        main_handle = driver.current_window_handle

        with driver.context(driver.CONTEXT_CHROME):
            driver.execute_script("openTrustedLinkIn(arguments[0], 'current')", f"moz-extension://{ext_uuid}/popup.html")
        wait.until(EC.element_to_be_clickable((By.ID, "onboard-create-btn"))).click()
        driver.find_element(By.ID, "create-name").send_keys("Live check")
        driver.find_element(By.ID, "create-password").send_keys(password)
        driver.find_element(By.ID, "create-password-confirm").send_keys(password)
        driver.find_element(By.ID, "create-submit-btn").click()
        # Confirm the phrase modal without reading it
        wait.until(EC.element_to_be_clickable((By.ID, "mnemonic-confirm-btn"))).click()
        wait.until(EC.invisibility_of_element_located((By.ID, "loading")))
        check("wallet created", not driver.find_elements(By.CSS_SELECTOR, "#toast.error:not(.hidden)"))

        driver.get("https://games.divi.domains/")
        wait_provider()
        status = call("window.irondivi.getAccessStatus()")
        check("games.divi.domains is a default site", status.get("ok") == "default", json.dumps(status))
        before = set(driver.window_handles)
        driver.execute_script("window.__c = window.irondivi.connect().then(r => window.__r = r, e => window.__r = {code: e.code})")
        wait.until(lambda d: len(set(d.window_handles) - before) == 1)
        (approval,) = set(driver.window_handles) - before
        driver.switch_to.window(approval)
        wait.until(EC.element_to_be_clickable((By.ID, "approve-request-btn"))).click()
        driver.switch_to.window(main_handle)
        wait.until(lambda d: d.execute_script("return window.__r !== undefined"))
        r = driver.execute_script("return window.__r")
        shown = {k: ("present" if k == "address" else v) for k, v in (r or {}).items()}
        check("games.divi.domains connects", bool(r and r.get("connected") and r.get("address")), json.dumps(shown))

        driver.get("https://example.com/")
        wait_provider()
        before = set(driver.window_handles)
        status = call("window.irondivi.getAccessStatus()")
        check("example.com is told not_allowed", status.get("ok") == "not_allowed", json.dumps(status))
        r = call("window.irondivi.connect()")
        check("example.com connect gets 4300", r.get("code") == 4300, json.dumps(r))
        r = call("window.irondivi.getAccounts()")
        check("example.com getAccounts gets 4300", r.get("code") == 4300, json.dumps(r))
        time.sleep(2)
        new = set(driver.window_handles) - before
        check("no window opened for example.com", not new, f"{len(new)} new")
    finally:
        driver.quit()
    print("ALL PASS" if ok else "SOME CHECKS FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
