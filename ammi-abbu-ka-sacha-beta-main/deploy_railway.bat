@echo off
echo ===================================================
echo 🚀 Deploying Telegram Slot Bot to Railway Cloud...
echo ===================================================
echo.
echo Step 1: Logging in to Railway (If not already logged in)...
call npx @railway/cli login
echo.
echo Step 2: Linking or Initializing Railway Project...
call npx @railway/cli init
echo.
echo Step 3: Uploading & Deploying Docker Container to Railway...
call npx @railway/cli up --detach
echo.
echo ===================================================
echo ✅ Done! Your bot is now deployed and running live on Railway!
echo ===================================================
pause
