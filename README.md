# Put OpenAI behind NetTutor (beginner-friendly setup)

This small Node.js service is a **private proxy** between the Yana n Tuasoc app and OpenAI. The app sends a question to this service; this service adds the NetTutor instructions and calls OpenAI. Your **OpenAI API key stays in the hosting provider’s private environment settings**—it is never put in the APK or the app’s connection form.

The proxy keeps no chat database and does not log message contents. It forwards at most the last 10 chat messages (each capped at 5,000 characters), limits request bodies to 64 KiB and chat requests to 12 per minute per IP, checks a separate proxy access code, and asks the Responses API not to store the response (`store: false`). Do not send passwords, API keys, or sensitive production configuration in a tutoring chat.

## Before you start

You need:

1. An OpenAI Platform account with API access and billing enabled. API billing is separate from a ChatGPT subscription. Create an API key from your OpenAI Platform project’s API keys page and copy it once; you will place it only in the host’s private environment settings—not in the app, GitHub, or this chat.
2. A GitHub account (to hold the proxy code).
3. A Render account (or another host that can run a Node 20 web service and set private environment variables).
4. The updated Yana n Tuasoc app. In NetTutor, you will enter your server’s HTTPS address and a separate proxy access code—not your OpenAI API key.

## Easiest path: deploy on Render

### 1. Make the code available in GitHub

1. Download and unzip `NetTutor-OpenAI-Proxy.zip`.
2. In GitHub, choose **New repository**. You can make it private. Give it a simple name such as `yana-nettutor-proxy`.
3. Open the new repository, choose **Add file → Upload files**, and upload the contents of the unzipped folder (`server.js`, `package.json`, `render.yaml`, and this `README.md`). Do **not** upload an `.env` file or an OpenAI key.
4. Commit the files to the repository’s `main` branch.

### 2. Create the web service

1. In Render, choose **New → Blueprint** and connect the GitHub repository you just made. Render will read `render.yaml` and create the Node web service. If you instead create a **Web Service** manually, choose Node, set the build command to `npm install`, and the start command to `npm start`.
2. Open the service’s **Environment** settings. Add these private variables:

   - `OPENAI_API_KEY` — your key from the OpenAI Platform. Keep it only in this private field; never paste it into GitHub, this chat, or the app.
   - `NETTUTOR_PROXY_TOKEN` — make a different, long random access code (32+ random characters). Save it in a password manager; you will enter it into the app later. **This is not your OpenAI key.**
   - `OPENAI_MODEL` — leave `gpt-5-mini`, or use a model available to your API account.
   - `APP_ORIGINS` — for the Android APK, the native app connection does not need a browser origin. For the web preview/browser, replace `*` with the exact website origin(s) that should be allowed, for example `https://your-site.example`. Origins contain only scheme + host (and optional port), not a page path. CORS is not authentication; the proxy token is still required.

3. Save the environment settings and deploy. Wait until Render reports the service is live.
4. Copy the service’s HTTPS address from its page. It will look like `https://your-service-name.onrender.com`. Use only the base address; do not add `/api/chat`.

Render’s free services can have limits or pause when idle, and its current plan/pricing can change. A first request after a pause may take longer. OpenAI API usage can also cost money; set a usage limit/budget in your OpenAI Platform account.

### 3. Connect NetTutor in the app

1. Open **NetTutor** in Yana n Tuasoc and tap **Settings**.
2. In **HTTPS proxy URL**, paste the base address from Render (for example, `https://your-service-name.onrender.com`).
3. In **Proxy access code**, enter the value you saved as `NETTUTOR_PROXY_TOKEN` in Render. Do **not** enter the OpenAI key here.
4. Turn on **Use OpenAI replies**, then tap **Save connection**.
5. Tap **Test connection**. If it succeeds, ask a question such as “How do I tell Class A, B, and C apart?”

The app keeps its built-in offline tutor as a fallback. If the server cannot be reached, it will say so and offer the local answer instead. OpenAI mode sends recent chat messages from your phone to your server and then to OpenAI; use offline mode for anything you do not want transmitted.

## Try it on your own computer first (optional)

Install Node.js 20 or later. Open a terminal in this folder.

**macOS / Linux** (replace the example values; do not use these literal examples as secrets):

```sh
export OPENAI_API_KEY='your-OpenAI-key'
export NETTUTOR_PROXY_TOKEN='your-own-long-random-proxy-token'
export OPENAI_MODEL='gpt-5-mini'
export APP_ORIGINS='http://localhost:8000'
npm start
```

**Windows PowerShell:**

```powershell
$env:OPENAI_API_KEY = 'your-OpenAI-key'
$env:NETTUTOR_PROXY_TOKEN = 'your-own-long-random-proxy-token'
$env:OPENAI_MODEL = 'gpt-5-mini'
$env:APP_ORIGINS = 'http://localhost:8000'
npm start
```

The local proxy listens on port 3000. The browser app may call it from `http://localhost:8000`; the Android APK intentionally requires HTTPS for a remote proxy. For phone testing, deploy the proxy to an HTTPS host instead of exposing your computer’s port directly.

## If something does not work

- **401 / access code error:** Check that the app’s proxy access code exactly matches `NETTUTOR_PROXY_TOKEN` in Render.
- **403 / origin error in a browser:** Add the exact website origin to `APP_ORIGINS` and redeploy. Android native requests do not send a browser Origin header.
- **“Server owner has not added OPENAI_API_KEY”:** Add it under the hosting service’s private environment settings, then redeploy.
- **OpenAI quota, billing, or model error:** Check the OpenAI Platform’s API billing, usage limits, and model access. ChatGPT Plus/Pro does not automatically include API usage.
- **Timeout on the first request:** The host may have been idle. Wait briefly and try again.

## Security notes

- Never put `OPENAI_API_KEY` in this repository, in the APK, or in the NetTutor app settings.
- The app stores the **proxy access code** locally on your device. Treat it as private and do not distribute an APK preconfigured with it. If it leaks, change `NETTUTOR_PROXY_TOKEN` on the host and update the app’s connection setting.
- `APP_ORIGINS` controls browsers, not non-browser tools. Keep the proxy token private, do not publish it, and monitor API usage. This simple personal-use proxy is not a multi-user identity system.
- Use a private GitHub repository if you prefer; the repository contains no secrets by default.

## Technical details

- `POST /api/chat` accepts recent user/assistant messages and returns `{ "reply": "..." }`.
- `GET /api/health` checks the proxy configuration. Both routes require `Authorization: Bearer <NETTUTOR_PROXY_TOKEN>`.
- The server calls `https://api.openai.com/v1/responses`, uses the server-side `OPENAI_API_KEY`, and passes the NetTutor teaching instructions from `server.js`.
- Chat messages are not stored by this proxy. OpenAI API data handling is governed by OpenAI’s current API terms and account settings.
