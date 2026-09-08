"""Manual login tool: Opens browser window for you to log into Dola manually.
Usage:
    .venv/bin/python manual_login.py <account_name>
"""
import asyncio
import sys
from pathlib import Path

from patchright.async_api import async_playwright

import config
from browser import LAUNCH_ARGS
from browser_pool import BrowserPool


async def main():
    if len(sys.argv) < 2:
        print("Usage: python manual_login.py <account_name>")
        sys.exit(1)

    account = sys.argv[1].strip()
    profile_dir = Path("accounts") / account
    profile_dir.mkdir(parents=True, exist_ok=True)

    print(f"[*] Đang mở trình duyệt cho tài khoản '{account}'...")
    async with async_playwright() as p:
        kwargs = {
            "headless": False,
            "args": LAUNCH_ARGS,
            "locale": "ja-JP",
            "timezone_id": "Asia/Tokyo",
        }
        if config.PROXY:
            kwargs["proxy"] = {"server": config.PROXY}

        context = await p.chromium.launch_persistent_context(str(profile_dir), **kwargs)
        page = context.pages[0] if context.pages else await context.new_page()
        await page.goto("https://www.dola.com/chat")
        print("[*] Trình duyệt đã mở. Vui lòng bấm đăng nhập (Google hoặc Facebook)...")
        print("[*] Đang theo dõi trạng thái đăng nhập (chờ sessionid)...")

        logged_in = False
        for _ in range(300):  # Đợi 10 phút
            await asyncio.sleep(2)
            try:
                cookies = await context.cookies("https://www.dola.com")
                if any(c["name"] == "sessionid" and c["value"] for c in cookies):
                    print(f"\n[✓] Đăng nhập thành công! Session đã được lưu vào profile 'accounts/{account}'.")
                    logged_in = True
                    # Cập nhật metadata pool
                    pool = BrowserPool()
                    pool.set_login_status(account, True)
                    await asyncio.sleep(3)
                    break
            except Exception:
                pass

        if not logged_in:
            print("[-] Hết thời gian chờ đăng nhập (10 phút).")
        await context.close()


if __name__ == "__main__":
    asyncio.run(main())
