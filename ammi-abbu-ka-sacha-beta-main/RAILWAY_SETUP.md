# 🚀 Deploying to Railway.app (Virtual Cloud Hosting)

Your bot is **100% prepared** for Railway Cloud Hosting with Dockerfile, Railway configuration, and cross-platform Chromium support.

---

### Option A: 1-Click via Railway Web (Easiest & Recommended)
1. Go to **[https://railway.app](https://railway.app)** and log in with your GitHub account.
2. Click **"New Project"** -> **"Deploy from GitHub repo"**.
3. Push this project to a GitHub repository:
   ```bash
   git remote add origin https://github.com/<your-username>/telegram-slot-bot.git
   git push -u origin master
   ```
4. Select the repository on Railway.
5. In your Railway service dashboard, click **Variables** and add:
   - `BOT_TOKEN`: Your Telegram Bot Token
   - `BOSS_SECRET`: a long random string (e.g. `openssl rand -hex 16`; must be ≥6 chars, ≥10 in production)
6. Railway will automatically build the `Dockerfile` and run the bot 24/7 in the cloud!

---

### Option B: 1-Click via deploy_railway.bat
1. In folder `telegram-slot-bot`, double-click **`deploy_railway.bat`**.
2. It will open your browser to log in to Railway once.
3. Select "Create a new project".
4. It will upload the files and deploy to Railway immediately!
5. In Railway dashboard, go to **Variables** and set your `BOT_TOKEN`.
