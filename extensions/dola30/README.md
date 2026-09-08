# Seedance Studio Pro (Dola-Pool Engine Extension)

This extension provides duration unlock (`15s`, `30s`) and master unwatermarked resource extraction for Dola and Doubao.

## Key Features & Fixes (v1.8.14)
1. **Unwatermarked 1080P Master Extraction**:
   - Dola updated its response to attach `lr=video_gen_watermark_dyn` to standard video streams.
   - This engine queries the unwatermarked stream via `fallback_api` (`logo_type=unwatermarked&codec_type=8&channel=no`), decrypts AES-CBC encrypted `qAAB` tokens with `key_seed` and QAAB salt, and extracts the 1080P clean video without logo.
   - Automatically drops / ignores watermarked preview streams.
2. **Page Bridge (React Fiber Inspection)**:
   - `page-bridge.js` runs in the `MAIN` world to catch `fallback_api` and `key_seed` directly from React component state on Dola / Doubao video cards.
3. **Floating Download Panel & Side Panel**:
   - `content.js` renders the watermark-free media control panel.
   - Side panel (`popup.html`) provides batch prompting, multi-scene management, and multi-account switching.
4. **Duration Unlock (`15s`, `30s`)**:
   - `dola-skill-pack-response.json` and `doubao-skill-pack-response.json` duration parameters injected via Chrome Debugger Fetch API.
