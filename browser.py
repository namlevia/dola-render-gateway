import json
from pathlib import Path
import re
import time

import config

LAUNCH_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
]


async def launch_account_context(p, account: str, headless: bool = None, use_extension: bool = False):
    """Launches accounts/<account> profile, returns BrowserContext. Caller must close.

    p: async_playwright() instance
    headless: None = uses config.HEADLESS
    """
    profile_dir = Path("accounts") / account
    if not profile_dir.exists():
        raise FileNotFoundError(
            f"Account profile does not exist: {profile_dir} (run python add_account.py {account} first)"
        )
    launch_headless = config.HEADLESS if headless is None else headless
    args = list(LAUNCH_ARGS)
    if use_extension:
        if not config.EXTENSION_ENABLED:
            raise RuntimeError("Dola extension is disabled (DOLA_EXTENSION_ENABLED=0)")
        extension_dir = Path(config.EXTENSION_DIR).resolve()
        if not extension_dir.exists():
            raise FileNotFoundError(f"Dola extension directory does not exist: {extension_dir}")
        # Chromium debugger extension requires headed window to intercept skill/action-bar responses
        launch_headless = False
        args.extend([
            f"--disable-extensions-except={extension_dir}",
            f"--load-extension={extension_dir}",
        ])
    kwargs = {
        "headless": launch_headless,
        "args": args,
        "locale": "ja-JP",
        "timezone_id": "Asia/Tokyo",
    }
    if config.PROXY:
        kwargs["proxy"] = {"server": config.PROXY}
    return await p.chromium.launch_persistent_context(str(profile_dir), **kwargs)


def cookie_value(cookies: list, name: str) -> str:
    """Extracts cookie value from context.cookies() result."""
    return next((c["value"] for c in cookies if c["name"] == name and c["value"]), "")


async def check_login_state(account: str) -> bool:
    """Opens Dola in headless mode and checks whether session is active."""
    from patchright.async_api import async_playwright
    async with async_playwright() as p:
        context = await launch_account_context(p, account)
        try:
            page = context.pages[0] if context.pages else await context.new_page()
            await page.goto("https://www.dola.com/chat", timeout=60000, wait_until="domcontentloaded")
            await page.wait_for_timeout(5000)
            cookies = await context.cookies("https://www.dola.com")
            if not cookie_value(cookies, "sessionid"):
                return False
            return bool(await page.evaluate(
                """() => !!(document.querySelector('textarea')
                        || document.querySelector('[contenteditable="true"]')
                        || document.querySelector('input[type="text"]'))"""
            ))
        finally:
            await context.close()


def parse_cookie_input(raw: str, default_domain: str = ".dola.com") -> list[dict]:
    """Parses raw cookie input from Cookie-Editor JSON, Netscape format, or standard header string."""
    raw = (raw or "").strip()
    if not raw:
        return []

    future = time.time() + 365 * 86400

    # 1. Try JSON (e.g. Cookie-Editor export)
    if raw.startswith("[") and raw.endswith("]"):
        try:
            data = json.loads(raw)
            if isinstance(data, list):
                cookies = []
                for item in data:
                    name = item.get("name")
                    value = item.get("value")
                    domain = item.get("domain") or default_domain
                    path = item.get("path") or "/"
                    expires = item.get("expires") or item.get("expirationDate") or future
                    http_only = bool(item.get("httpOnly", False))
                    secure = bool(item.get("secure", False))
                    same_site = item.get("sameSite")
                    if name and value is not None:
                        entry = {
                            "name": str(name).strip(),
                            "value": str(value).strip(),
                            "domain": str(domain).strip(),
                            "path": str(path).strip() or "/",
                            "expires": float(expires),
                            "httpOnly": http_only,
                            "secure": secure,
                        }
                        if same_site in ("Strict", "Lax", "None"):
                            entry["sameSite"] = same_site
                        cookies.append(entry)
                if cookies:
                    return cookies
        except Exception:
            pass

    # 2. Key-value string or Netscape format
    cookies = []
    segments = re.split(r"[;\n]+", raw)
    for seg in segments:
        seg = seg.strip()
        if not seg or seg.startswith("#"):
            continue
        parts = seg.split("\t")
        if len(parts) >= 7:
            exp_val = parts[4].strip()
            try:
                exp_ts = float(exp_val) if float(exp_val) > 0 else future
            except Exception:
                exp_ts = future
            cookies.append({
                "domain": parts[0].strip() or default_domain,
                "path": parts[2].strip() or "/",
                "name": parts[5].strip(),
                "value": parts[6].strip(),
                "expires": exp_ts,
                "secure": parts[3].strip().upper() == "TRUE",
                "httpOnly": False,
            })
            continue
        if "=" in seg:
            k, v = seg.split("=", 1)
            k = k.strip()
            v = v.strip()
            if k:
                cookies.append({
                    "name": k,
                    "value": v,
                    "domain": default_domain,
                    "path": "/",
                    "expires": future,
                    "httpOnly": (k == "sessionid"),
                    "secure": False,
                })
    return cookies


async def import_account_cookies(account: str, cookies: list[dict], default_domain: str = ".dola.com") -> bool:
    """Injects cookies into persistent profile directory, navigates to warmup and verifies session."""
    from patchright.async_api import async_playwright
    profile_dir = Path("accounts") / account
    profile_dir.mkdir(parents=True, exist_ok=True)
    
    future = time.time() + 365 * 86400
    clean = []
    for c in cookies:
        domain = c.get("domain") or default_domain
        entry = {
            "name": str(c["name"]).strip(),
            "value": str(c["value"]).strip(),
            "domain": str(domain).strip(),
            "path": c.get("path") or "/",
            "expires": float(c.get("expires") or c.get("expirationDate") or future),
            "httpOnly": bool(c.get("httpOnly", False)),
            "secure": bool(c.get("secure", False)),
        }
        if c.get("sameSite") in ("Strict", "Lax", "None"):
            entry["sameSite"] = c["sameSite"]
        clean.append(entry)

    async with async_playwright() as p:
        kwargs = {
            "headless": True,
            "args": LAUNCH_ARGS,
            "locale": "ja-JP",
            "timezone_id": "Asia/Tokyo",
        }
        if config.PROXY:
            kwargs["proxy"] = {"server": config.PROXY}
        context = await p.chromium.launch_persistent_context(str(profile_dir), **kwargs)
        login_ok = True
        try:
            await context.add_cookies(clean)
            # If Dola platform, navigate to chat to warmup and verify session
            if "dola" in default_domain or any("dola.com" in str(c.get("domain", "")) for c in clean):
                page = context.pages[0] if context.pages else await context.new_page()
                try:
                    await page.goto("https://www.dola.com/chat", timeout=45000, wait_until="domcontentloaded")
                    await page.wait_for_timeout(3000)
                    c_after = await context.cookies("https://www.dola.com")
                    sess = cookie_value(c_after, "sessionid")
                    has_input = await page.evaluate(
                        """() => !!(document.querySelector('textarea')
                                || document.querySelector('[contenteditable="true"]')
                                || document.querySelector('input[type="text"]'))"""
                    )
                    login_ok = bool(sess and has_input)
                except Exception as e:
                    print(f"[import_cookies] warm-up navigation warning: {e}", flush=True)
                    login_ok = True
        finally:
            await context.close()
    return login_ok


